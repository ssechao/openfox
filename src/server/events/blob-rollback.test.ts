import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventStore } from './store.js'
import { FileBlobStore, setBlobStore } from './blob-store.js'
import { BlobRollbackError, collectBlobRefs } from './blob-codec.js'
import {
  CRASH_HASH,
  CRASH_PNG,
  CRASH_PNG_URL,
  eventPayloads,
  killAtBarrier,
  reopenCrashStore,
  seedCrashDatabase,
} from './blob-crash-harness.js'
import { attachmentDataFromToolMetadata, hasImageMetadata } from './fixtures/pre-4a1/tool-image.js'
import { getBlobRollbackStatus } from './blob-rollback.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const LOCK_CHILD = join(dirname(fileURLToPath(import.meta.url)), '../db/instance-lock.test-child.ts')

function schema(db: Database.Database): void {
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

function openStore(dir: string) {
  const dbPath = join(dir, 'sessions.db')
  const db = new Database(dbPath)
  schema(db)
  db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run('s1')
  const events = new EventStore(db)
  return { dbPath, db, events, blobs: events.blobStore as FileBlobStore }
}

describe('blob rollback', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-rollback-'))
  })
  afterEach(() => {
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reinlines attachments and tool metadata.dataUrl for the pre-4a-1 parser', () => {
    const { db, events, blobs } = openStore(dir)
    try {
      events.append('s1', {
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
      events.append('s1', {
        type: 'tool.result',
        data: {
          messageId: 'm2',
          toolCallId: 'c1',
          result: {
            success: true,
            output: 'ok',
            durationMs: 1,
            truncated: false,
            metadata: {
              mimeType: 'image/png',
              path: 'dot.png',
              size: CRASH_PNG.length,
              base64Data: CRASH_PNG.toString('base64'),
              dataUrl: CRASH_PNG_URL,
            },
          },
        },
      })
      expect(eventPayloads(db, 's1').join('')).toContain(CRASH_HASH)
      expect(eventPayloads(db, 's1').join('')).not.toContain('data:image')

      const report = events.rollbackSessionBlobs('s1')
      expect(report.status).toBe('switched')
      expect(report.rewritten).toBe(2)
      const payloads = eventPayloads(db, 's1')
      expect(payloads.join('')).toContain('data:image/png')
      expect(payloads.join('')).not.toMatch(/"hash":"[a-f0-9]{64}"/)
      expect(collectBlobRefs(JSON.parse(payloads[0]!))).toEqual([])
      expect(collectBlobRefs(JSON.parse(payloads[1]!))).toEqual([])

      const attachment = JSON.parse(payloads[0]!) as {
        attachments: Array<{ data?: string; blob?: unknown }>
      }
      expect(attachment.attachments[0]?.data).toContain(CRASH_PNG.toString('base64'))
      expect(attachment.attachments[0]?.blob).toBeUndefined()

      const tool = JSON.parse(payloads[1]!) as {
        result: { metadata: { mimeType?: string; dataUrl?: string; base64Data?: string } }
      }
      expect(hasImageMetadata(tool.result)).toBe(true)
      expect(attachmentDataFromToolMetadata(tool.result.metadata)).toContain('data:image/png;base64,')
      expect(tool.result.metadata.base64Data).toBe(CRASH_PNG.toString('base64'))
      expect(blobs.has(CRASH_HASH)).toBe(true)
      expect(blobs.get(CRASH_HASH).bytes.equals(CRASH_PNG)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('covers migrated sessions and native 4a-1 writes without deleting blobs', () => {
    const { db, events, blobs } = openStore(dir)
    try {
      db.prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'message.start', ?)`,
      ).run(
        's1',
        Date.now(),
        JSON.stringify({
          messageId: 'legacy',
          role: 'user',
          content: 'old',
          attachments: [
            { id: 'a', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL },
          ],
        }),
      )
      events.migrateSessionBlobs('s1')
      expect(eventPayloads(db, 's1')[0]).toContain(CRASH_HASH)
      events.rollbackSessionBlobs('s1')
      expect(eventPayloads(db, 's1')[0]).toContain('data:image/png')
      expect(blobs.has(CRASH_HASH)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('restores image_url.url and nested dataUrl for the pre-4a-1 reader', () => {
    const { db, events } = openStore(dir)
    try {
      db.prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'message.start', ?)`,
      ).run(
        's1',
        Date.now(),
        JSON.stringify({
          messageId: 'm1',
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: CRASH_PNG_URL, detail: 'auto' } },
            { type: 'nested', wrapped: { dataUrl: CRASH_PNG_URL } },
          ],
        }),
      )
      events.migrateSessionBlobs('s1')
      expect(eventPayloads(db, 's1')[0]).toContain(CRASH_HASH)
      const report = events.rollbackSessionBlobs('s1')
      expect(report.status).toBe('switched')
      const payload = JSON.parse(eventPayloads(db, 's1')[0]!) as {
        content: Array<{
          type?: string
          image_url?: { url?: string; dataUrl?: string; detail?: string; blob?: unknown }
          wrapped?: { dataUrl?: string; url?: string; blob?: unknown }
        }>
      }
      const image = payload.content.find((part) => part.type === 'image_url')
      expect(image?.image_url?.url).toBe(CRASH_PNG_URL)
      expect(image?.image_url?.dataUrl).toBeUndefined()
      expect(image?.image_url?.blob).toBeUndefined()
      expect(image?.image_url?.detail).toBe('auto')
      const nested = payload.content.find((part) => part.type === 'nested')
      expect(nested?.wrapped?.dataUrl).toBe(CRASH_PNG_URL)
      expect(nested?.wrapped?.url).toBeUndefined()
      expect(nested?.wrapped?.blob).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('refuses an ambiguous blob form before marking switched', () => {
    const { db, events, blobs } = openStore(dir)
    try {
      blobs.put(CRASH_PNG, 'image/png')
      blobs.clearPending?.(CRASH_HASH)
      db.prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'message.start', ?)`,
      ).run(
        's1',
        Date.now(),
        JSON.stringify({
          mystery: { blob: { hash: CRASH_HASH, mime: 'image/png', size: CRASH_PNG.length } },
        }),
      )
      expect(() => events.rollbackSessionBlobs('s1')).toThrow(BlobRollbackError)
      expect(getBlobRollbackStatus(db, 's1')).not.toBe('switched')
      expect(eventPayloads(db, 's1')[0]).toContain(CRASH_HASH)
      expect(blobs.has(CRASH_HASH)).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('C3 SIGKILL at rollback barriers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-sigkill-c3-'))
  })
  afterEach(() => {
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  async function seedSwitched() {
    const dbPath = join(dir, 'sessions.db')
    seedCrashDatabase(dbPath, 's1', true)
    const opened = reopenCrashStore(dbPath)
    opened.events.migrateSessionBlobs('s1')
    opened.db.close()
    return dbPath
  }

  it('SIGKILL after-hydrate keeps refs, resume finishes without a half-inlined session', async () => {
    const dbPath = await seedSwitched()
    await killAtBarrier(
      { OPENFOX_DB_PATH: dbPath, OPENFOX_BLOB_CRASH_MODE: 'rollback', OPENFOX_BLOB_SESSION: 's1' },
      'after-hydrate',
      join(dir, 'barrier'),
    )
    const { db, events, blobs } = reopenCrashStore(dbPath)
    try {
      const before = eventPayloads(db, 's1')
      expect(before[0]).toContain(CRASH_HASH)
      expect(before[0]).not.toContain('data:image')
      expect(getBlobRollbackStatus(db, 's1')).not.toBe('switched')
      expect(blobs.has(CRASH_HASH)).toBe(true)
      const report = events.rollbackSessionBlobs('s1')
      expect(report.status).toBe('switched')
      const after = eventPayloads(db, 's1')
      expect(after[0]).toContain('data:image/png')
      expect(after[0]).not.toContain(CRASH_HASH)
      expect(blobs.has(CRASH_HASH)).toBe(true)
    } finally {
      db.close()
    }
  }, 30_000)

  it('SIGKILL before-switch keeps refs, resume switches once', async () => {
    const dbPath = await seedSwitched()
    await killAtBarrier(
      { OPENFOX_DB_PATH: dbPath, OPENFOX_BLOB_CRASH_MODE: 'rollback', OPENFOX_BLOB_SESSION: 's1' },
      'before-switch',
      join(dir, 'barrier'),
    )
    const { db, events, blobs } = reopenCrashStore(dbPath)
    try {
      expect(eventPayloads(db, 's1')[0]).toContain(CRASH_HASH)
      events.rollbackSessionBlobs('s1')
      expect(eventPayloads(db, 's1')[0]).toContain('data:image/png')
      expect(events.rollbackSessionBlobs('s1').rewritten).toBe(0)
      expect(blobs.has(CRASH_HASH)).toBe(true)
    } finally {
      db.close()
    }
  }, 30_000)

  it('SIGKILL after-switch leaves inline events, resume is a no-op, blobs remain', async () => {
    const dbPath = await seedSwitched()
    await killAtBarrier(
      { OPENFOX_DB_PATH: dbPath, OPENFOX_BLOB_CRASH_MODE: 'rollback', OPENFOX_BLOB_SESSION: 's1' },
      'after-switch',
      join(dir, 'barrier'),
    )
    const { db, events, blobs } = reopenCrashStore(dbPath)
    try {
      const before = eventPayloads(db, 's1')
      expect(before[0]).toContain('data:image/png')
      expect(getBlobRollbackStatus(db, 's1')).toBe('switched')
      expect(events.rollbackSessionBlobs('s1').rewritten).toBe(0)
      expect(eventPayloads(db, 's1')).toEqual(before)
      expect(blobs.has(CRASH_HASH)).toBe(true)
    } finally {
      db.close()
    }
  }, 30_000)
})

describe('rollback-blobs refuses a locked database', () => {
  let dir: string
  let child: ChildProcess | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-rollback-lock-'))
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

  it('exits without mutating payloads when another instance holds the lock', async () => {
    const { dbPath, db, events } = openStore(dir)
    events.append('s1', {
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
    const original = eventPayloads(db, 's1')[0]
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
      execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/rollback-blobs.ts', '--yes', '--db', dbPath], {
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
    const after = new Database(dbPath, { readonly: true })
    const row = after.prepare(`SELECT payload FROM events`).get() as { payload: string }
    expect(row.payload).toBe(original)
    after.close()
    expect(existsSync(dbPath)).toBe(true)
  }, 60_000)
})
