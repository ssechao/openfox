import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventStore } from './store.js'
import { FileBlobStore, blobDirForDatabase, setBlobStore } from './blob-store.js'
import { BlobBackupError, backupDatabaseAndBlobs, restoreDatabaseAndBlobs } from './blob-backup.js'
import { collectBlobRefs } from './blob-codec.js'
import { hydrateAttachmentData } from './blob-codec.js'
import { CRASH_HASH, CRASH_PNG, CRASH_PNG_URL, killAtBarrier } from './blob-crash-harness.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const LOCK_CHILD = join(dirname(fileURLToPath(import.meta.url)), '../db/instance-lock.test-child.ts')

function liveOpenfoxHits(): number {
  const root = join(homedir(), 'Library/Application Support/openfox')
  try {
    const out = execFileSync('lsof', ['-n', '-P', '+D', root], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').filter((line) => line.includes('Application Support/openfox')).length
  } catch {
    return 0
  }
}

function schema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );
  `)
}

function openStore(dir: string, name: string) {
  const dbPath = join(dir, name)
  const db = new Database(dbPath)
  schema(db)
  db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run('s1')
  const events = new EventStore(db)
  return { dbPath, db, events, blobs: events.blobStore as FileBlobStore }
}

function appendPng(events: EventStore, sessionId = 's1') {
  return events.append(sessionId, {
    type: 'message.start',
    data: {
      messageId: 'm1',
      role: 'user',
      content: 'see',
      attachments: [
        { id: 'a', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL },
      ],
    },
  })
}

describe('blob backup / restore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-backup-'))
  })
  afterEach(() => {
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips sqlite + blobs and hydrates', async () => {
    const { dbPath, db, events } = openStore(dir, 'sessions.db')
    appendPng(events)
    db.close()
    const dest = join(dir, 'backup')
    await backupDatabaseAndBlobs(dbPath, dest)
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
    const restoredPath = join(dir, 'restored.db')
    restoreDatabaseAndBlobs(dest, restoredPath)
    const restored = new Database(restoredPath)
    const store = new EventStore(restored)
    try {
      const payload = restored.prepare(`SELECT payload FROM events`).get() as { payload: string }
      expect(payload.payload).toContain(CRASH_HASH)
      expect(payload.payload).not.toContain('data:image')
      const rec = store.blobStore.get(CRASH_HASH)
      expect(rec.bytes.equals(CRASH_PNG)).toBe(true)
      expect(rec.mime).toBe('image/png')
      const data = hydrateAttachmentData(
        {
          id: 'a',
          filename: 'dot.png',
          mimeType: 'image/png',
          size: CRASH_PNG.length,
          blob: { hash: CRASH_HASH, mime: 'image/png', size: CRASH_PNG.length },
        },
        store.blobStore,
      )
      expect(data).toContain(CRASH_PNG.toString('base64'))
    } finally {
      restored.close()
    }
    expect(liveOpenfoxHits()).toBe(0)
  })

  it('fails closed when a referenced blob is missing and publishes nothing', async () => {
    const { dbPath, db, events, blobs } = openStore(dir, 'sessions.db')
    appendPng(events)
    blobs.removeBlob(CRASH_HASH)
    db.close()
    const dest = join(dir, 'backup')
    await expect(backupDatabaseAndBlobs(dbPath, dest)).rejects.toBeInstanceOf(BlobBackupError)
    expect(existsSync(dest)).toBe(false)
    const leftovers = execFileSync('ls', [dir], { encoding: 'utf8' })
    expect(leftovers).not.toMatch(/manifest\.json/)
  })

  it('SIGKILL mid-backup publishes nothing and restore refuses', async () => {
    const { dbPath, db, events } = openStore(dir, 'sessions.db')
    appendPng(events)
    db.close()
    const dest = join(dir, 'backup')
    await killAtBarrier(
      {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_BLOB_CRASH_MODE: 'backup',
        OPENFOX_BLOB_BACKUP_DEST: dest,
      },
      'before-blob-copy',
      join(dir, 'barrier-backup'),
    )
    expect(existsSync(dest)).toBe(false)
    expect(() => restoreDatabaseAndBlobs(dest, join(dir, 'restored.db'))).toThrow()
  }, 30_000)

  it('backs up during concurrent writes', async () => {
    const { dbPath, db, events } = openStore(dir, 'sessions.db')
    appendPng(events)
    db.close()
    const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'blob-crash-child.ts')
    const child = fork(CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: {
        ...process.env,
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_BLOB_CRASH_MODE: 'append-loop',
        OPENFOX_BLOB_SESSION: 's1',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    const logs: string[] = []
    child.stdout?.on('data', (data: Buffer) => logs.push(data.toString()))
    child.stderr?.on('data', (data: Buffer) => logs.push(data.toString()))
    let writes = 0
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer child timed out\n${logs.join('')}`)), 20_000)
      child.on('message', (message) => {
        const wrote = (message as { wrote?: number }).wrote
        if (typeof wrote === 'number') {
          writes = Math.max(writes, wrote)
          if (wrote >= 1) {
            clearTimeout(timer)
            resolve()
          }
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`writer child exited ${code}\n${logs.join('')}`))
      })
    })
    const dest = join(dir, 'backup')
    try {
      await backupDatabaseAndBlobs(dbPath, dest)
    } finally {
      try {
        child.kill('SIGKILL')
      } catch {
        // gone
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    expect(writes).toBeGreaterThan(0)
    const restoredPath = join(dir, 'restored.db')
    restoreDatabaseAndBlobs(dest, restoredPath)
    const restored = new Database(restoredPath, { readonly: true })
    const blobs = new FileBlobStore(blobDirForDatabase(restoredPath), { ownerDbPath: restoredPath })
    try {
      const rows = restored.prepare('SELECT payload FROM events').all() as Array<{ payload: string }>
      for (const row of rows) {
        for (const ref of collectBlobRefs(JSON.parse(row.payload))) {
          const rec = blobs.get(ref.hash)
          expect(rec.bytes.equals(CRASH_PNG)).toBe(true)
        }
      }
    } finally {
      restored.close()
    }
  }, 20_000)

  it('export embeds blob bytes and import hydrates; v1 inline stays importable', () => {
    const src = openStore(dir, 'src.db')
    const stored = appendPng(src.events)
    const packed = collectBlobRefs(stored.data).map((ref) => {
      const rec = src.blobs.get(ref.hash)
      return { hash: rec.hash, mime: rec.mime, size: rec.size, data: rec.bytes.toString('base64') }
    })
    expect(packed).toHaveLength(1)
    src.db.close()

    const dst = openStore(dir, 'dst.db')
    for (const blob of packed) {
      dst.blobs.put(Buffer.from(blob.data, 'base64'), blob.mime)
      dst.blobs.clearPending?.(blob.hash)
    }
    dst.events.importEvents('s1', [
      { seq: 1, timestamp: Date.now(), sessionId: 's1', type: 'message.start', data: stored.data },
    ])
    const rec = dst.blobs.get(CRASH_HASH)
    expect(rec.bytes.equals(CRASH_PNG)).toBe(true)
    dst.db.close()

    const inline = openStore(dir, 'inline.db')
    inline.events.importEvents('s1', [
      {
        seq: 1,
        timestamp: Date.now(),
        sessionId: 's1',
        type: 'message.start',
        data: {
          messageId: 'm1',
          role: 'user',
          content: 'old',
          attachments: [
            { id: 'a', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL },
          ],
        },
      },
    ])
    const row = inline.db.prepare('SELECT payload FROM events').get() as { payload: string }
    expect(row.payload).toContain('data:image/png')
    inline.db.close()
  })
})

describe('restore-blobs refuses a locked target', () => {
  let dir: string
  let child: ChildProcess | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-restore-lock-'))
  })
  afterEach(() => {
    if (child && child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // gone
        }
      }
    }
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits without restoring when the target is locked', async () => {
    const src = openStore(dir, 'src.db')
    appendPng(src.events)
    src.db.close()
    const backupDir = join(dir, 'backup')
    await backupDatabaseAndBlobs(src.dbPath, backupDir)
    const destPath = join(dir, 'dest.db')
    new Database(destPath).close()

    child = fork(LOCK_CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, OPENFOX_LOCK_DB_PATH: destPath },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock child timed out')), 10_000)
      child!.once('message', (message) => {
        clearTimeout(timer)
        if ((message as { ok?: boolean }).ok) resolve()
        else reject(new Error(`lock failed ${JSON.stringify(message)}`))
      })
      child!.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`lock child exited ${code}`))
      })
    })

    let status = 0
    let stderr = ''
    try {
      execFileSync(
        join(REPO_ROOT, 'node_modules/.bin/tsx'),
        ['scripts/restore-blobs.ts', '--yes', '--from', backupDir, '--db', destPath],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (error) {
      const err = error as { status?: number; stderr?: string; stdout?: string }
      status = err.status ?? 0
      stderr = `${err.stderr ?? ''}${err.stdout ?? ''}`
    }
    expect(status).toBe(1)
    expect(stderr).toMatch(/database already in use/)
  }, 60_000)
})
