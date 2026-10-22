import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventStore, initEventStore } from './store.js'
import { FileBlobStore, blobDirForDatabase, hashBytes, setBlobStore } from './blob-store.js'
import { BlobStoreOwnerError, gcBlobs } from './blob-gc.js'
import { BlobScanError } from './blob-scan.js'
import {
  CRASH_HASH,
  CRASH_PNG,
  CRASH_PNG_URL,
  assertResolvablePng,
  eventPayloads,
  killAtBarrier,
  parkAtBarrier,
  reopenCrashStore,
  seedCrashDatabase,
} from './blob-crash-harness.js'
import { closeDatabase } from '../db/index.js'

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

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
    CREATE TABLE IF NOT EXISTS tombstones (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE(session_id, seq)
    );
  `)
}

function openPair(dir: string, name: string) {
  const dbPath = join(dir, name)
  const db = new Database(dbPath)
  schema(db)
  db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run('s1')
  const events = new EventStore(db)
  return { dbPath, db, events, blobs: events.blobStore as FileBlobStore }
}

function pngMessage(sessionId: string, events: EventStore, extra: Record<string, unknown> = {}) {
  return events.append(sessionId, {
    type: 'message.start',
    data: {
      messageId: 'm1',
      role: 'user',
      content: 'see',
      attachments: [
        { id: 'a', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL, ...extra },
      ],
    },
  })
}

describe('blob GC', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-gc-'))
  })

  afterEach(() => {
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes blobs left by deleteSession, cleanup and a 4a-1 crash write', async () => {
    const { db, events, blobs } = openPair(dir, 'sessions.db')
    try {
      pngMessage('s1', events)
      expect(blobs.has(CRASH_HASH)).toBe(true)
      events.deleteSession('s1')
      expect(events.gcBlobs().deleted).toBe(1)
      expect(blobs.has(CRASH_HASH)).toBe(false)
    } finally {
      db.close()
    }

    const crashPath = join(dir, 'crash.db')
    seedCrashDatabase(crashPath, 's1', false)
    await killAtBarrier(
      { OPENFOX_DB_PATH: crashPath, OPENFOX_BLOB_CRASH_MODE: 'append', OPENFOX_BLOB_SESSION: 's1' },
      'after-blob-write',
      join(dir, 'barrier-crash'),
    )
    const reopened = reopenCrashStore(crashPath)
    try {
      expect(eventPayloads(reopened.db, 's1')).toEqual([])
      expect(reopened.blobs.has(CRASH_HASH)).toBe(true)
      expect(reopened.events.gcBlobs().deleted).toBeGreaterThanOrEqual(1)
      expect(reopened.blobs.has(CRASH_HASH)).toBe(false)
    } finally {
      reopened.db.close()
    }
    expect(liveOpenfoxHits()).toBe(0)
  }, 30_000)

  it('keeps deduped and tombstoned refs', () => {
    const { db, events, blobs } = openPair(dir, 'sessions.db')
    try {
      db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run('s2')
      pngMessage('s1', events)
      events.append('s2', {
        type: 'message.start',
        data: {
          messageId: 'm2',
          role: 'user',
          content: 'also',
          attachments: [
            { id: 'b', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL },
          ],
        },
      })
      events.deleteSession('s1')
      expect(events.gcBlobs().deleted).toBe(0)
      expect(blobs.has(CRASH_HASH)).toBe(true)

      events.tombstoneEvents('s2', [1])
      expect(events.gcBlobs().deleted).toBe(0)
      expect(blobs.has(CRASH_HASH)).toBe(true)
      assertResolvablePng(blobs)
    } finally {
      db.close()
    }
  })

  it('does not treat a raw 64-hex string as a reference', () => {
    const { db, events, blobs } = openPair(dir, 'sessions.db')
    try {
      pngMessage('s1', events)
      const orphan = blobs.put(JPEG, 'image/jpeg')
      blobs.clearPending?.(orphan.hash)
      events.append('s1', {
        type: 'message.start',
        data: { messageId: 'm2', role: 'user', content: `hash ${orphan.hash} in text` },
      })
      const report = events.gcBlobs()
      expect(report.deleted).toBe(1)
      expect(blobs.has(CRASH_HASH)).toBe(true)
      expect(blobs.has(orphan.hash)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('refuses GC when an event payload is unreadable and does not delete', () => {
    const { db, events, blobs } = openPair(dir, 'sessions.db')
    try {
      pngMessage('s1', events)
      const orphan = blobs.put(JPEG, 'image/jpeg')
      blobs.clearPending?.(orphan.hash)
      db.prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 2, ?, 'message.start', ?)`,
      ).run('s1', Date.now(), '{not-json')
      expect(() => events.gcBlobs()).toThrow(BlobScanError)
      expect(blobs.has(CRASH_HASH)).toBe(true)
      expect(blobs.has(orphan.hash)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('refuses a marker mismatch and never deletes the other database blob on a shared dir', () => {
    const db1Path = join(dir, 'a.db')
    const db2Path = join(dir, 'b.db')
    const shared = join(dir, 'shared-blobs')
    const db1 = new Database(db1Path)
    const db2 = new Database(db2Path)
    schema(db1)
    schema(db2)
    db1.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1')
    db2.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1')
    const store = new FileBlobStore(shared, { ownerDbPath: db1Path })
    expect(() => store.registerOwner(db2Path)).toThrow(BlobStoreOwnerError)
    expect(() => new FileBlobStore(shared, { ownerDbPath: db2Path })).toThrow(BlobStoreOwnerError)
    const e1 = new EventStore(db1, { blobStore: store })
    try {
      pngMessage('s1', e1)
      const jpegHash = hashBytes(JPEG)
      store.put(JPEG, 'image/jpeg')
      store.clearPending?.(jpegHash)
      db2
        .prepare(
          `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'message.start', ?)`,
        )
        .run(
          's1',
          Date.now(),
          JSON.stringify({
            messageId: 'm1',
            role: 'user',
            content: 'jpeg',
            attachments: [
              {
                id: 'j',
                filename: 'dot.jpg',
                mimeType: 'image/jpeg',
                size: JPEG.length,
                blob: { hash: jpegHash, mime: 'image/jpeg', size: JPEG.length },
              },
            ],
          }),
        )
      expect(() => gcBlobs(db2, store)).toThrow(BlobStoreOwnerError)
      // Exclusive owner: the non-owner cannot GC, so db1's png stays. We do not
      // GC db1 here — that would treat db2's planted jpeg as an orphan.
      expect(store.has(CRASH_HASH)).toBe(true)
      expect(store.has(jpegHash)).toBe(true)
    } finally {
      db1.close()
      db2.close()
    }
  })

  it('keeps an in-flight blob while a child is parked at after-blob-write', async () => {
    const dbPath = join(dir, 'sessions.db')
    seedCrashDatabase(dbPath, 's1', false)
    const child = await parkAtBarrier(
      { OPENFOX_DB_PATH: dbPath, OPENFOX_BLOB_CRASH_MODE: 'append', OPENFOX_BLOB_SESSION: 's1' },
      'after-blob-write',
      join(dir, 'barrier-live'),
    )
    try {
      const { db, events, blobs } = reopenCrashStore(dbPath)
      try {
        expect(blobs.has(CRASH_HASH)).toBe(true)
        expect(eventPayloads(db, 's1')).toEqual([])
        expect(events.gcBlobs().deleted).toBe(0)
        expect(blobs.has(CRASH_HASH)).toBe(true)
      } finally {
        db.close()
      }
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
    const again = reopenCrashStore(dbPath)
    try {
      const stored = again.events.append('s1', {
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
      const att = (stored.data as { attachments: Array<{ blob?: { hash: string } }> }).attachments[0]
      expect(att?.blob?.hash).toBe(CRASH_HASH)
      assertResolvablePng(again.blobs)
    } finally {
      again.db.close()
    }
  }, 30_000)

  it('SIGKILL during GC leaves live refs readable and resume is idempotent', async () => {
    const { dbPath, db, events, blobs } = openPair(dir, 'sessions.db')
    pngMessage('s1', events)
    const orphan = blobs.put(JPEG, 'image/jpeg')
    blobs.clearPending?.(orphan.hash)
    db.close()

    await killAtBarrier(
      { OPENFOX_DB_PATH: dbPath, OPENFOX_BLOB_CRASH_MODE: 'gc' },
      'before-gc-delete',
      join(dir, 'barrier-gc'),
    )
    const reopened = reopenCrashStore(dbPath)
    try {
      expect(reopened.blobs.has(CRASH_HASH)).toBe(true)
      assertResolvablePng(reopened.blobs)
      const first = reopened.events.gcBlobs()
      expect(reopened.blobs.has(CRASH_HASH)).toBe(true)
      expect(reopened.blobs.has(orphan.hash)).toBe(false)
      const second = reopened.events.gcBlobs()
      expect(second.deleted).toBe(0)
      expect(first.deleted + second.deleted).toBeGreaterThanOrEqual(0)
    } finally {
      reopened.db.close()
    }
  }, 60_000)
})

describe('startup does not GC', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-gc-boot-'))
  })
  afterEach(() => {
    setBlobStore(null)
    try {
      closeDatabase()
    } catch {
      // not opened through initDatabase
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves orphans on disk when EventStore starts', () => {
    const dbPath = join(dir, 'sessions.db')
    const db = new Database(dbPath)
    schema(db)
    db.close()
    const blobs = new FileBlobStore(blobDirForDatabase(dbPath), { ownerDbPath: dbPath })
    const orphan = blobs.put(JPEG, 'image/jpeg')
    blobs.clearPending?.(orphan.hash)
    const opened = new Database(dbPath)
    initEventStore(opened)
    expect(blobs.has(orphan.hash)).toBe(true)
    opened.close()
  })
})

describe('gc-blobs refuses a locked database', () => {
  let dir: string
  let child: ChildProcess | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-gc-lock-'))
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

  it('exits without deleting blobs when another instance holds the lock', async () => {
    const { dbPath, db, events, blobs } = openPair(dir, 'sessions.db')
    pngMessage('s1', events)
    const orphan = blobs.put(JPEG, 'image/jpeg')
    blobs.clearPending?.(orphan.hash)
    db.close()

    child = fork(LOCK_CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
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
      execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/gc-blobs.ts', '--yes', '--db', dbPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const err = error as { status?: number; stderr?: string; stdout?: string }
      status = err.status ?? 0
      stderr = `${err.stderr ?? ''}${err.stdout ?? ''}`
    }
    expect(status).toBe(1)
    expect(stderr).toMatch(/database already in use/)
    const blobsAfter = new FileBlobStore(blobDirForDatabase(dbPath), { ownerDbPath: dbPath })
    expect(blobsAfter.has(CRASH_HASH)).toBe(true)
    expect(blobsAfter.has(orphan.hash)).toBe(true)
    expect(existsSync(dbPath)).toBe(true)
  }, 60_000)
})
