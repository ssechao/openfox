import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, initEventStore, getEventStore } from './store.js'
import { FileBlobStore, hashBytes, setBlobStore } from './blob-store.js'
import { getBlobMigrationStatus } from './blob-migrate.js'
import { closeDatabase } from '../db/index.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

function seedInline(db: Database.Database, sessionId: string): string {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO sessions (id) VALUES ('${sessionId}');
  `)
  const payload = JSON.stringify({
    messageId: 'm1',
    role: 'user',
    content: 'see',
    attachments: [{ id: 'a', filename: 'dot.png', mimeType: 'image/png', size: PNG.length, data: PNG_URL }],
  })
  db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'message.start', ?)`,
  ).run(sessionId, Date.now(), payload)
  return payload
}

describe('blob migration', () => {
  let dir: string
  let dbPath: string
  let db: Database.Database
  let events: EventStore
  let original: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-mig-'))
    dbPath = join(dir, 'sessions.db')
    db = new Database(dbPath)
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(session_id, seq)
      )
    `)
    original = seedInline(db, 's1')
    events = new EventStore(db, { blobStore: new FileBlobStore(join(dir, 'blobs')) })
  })

  afterEach(() => {
    setBlobStore(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('copies then switches in one transaction and reconstructs bytes', () => {
    const before = db.prepare(`SELECT payload FROM events WHERE session_id='s1'`).get() as { payload: string }
    expect(before.payload).toBe(original)
    const report = events.migrateSessionBlobs('s1')
    expect(report.status).toBe('switched')
    expect(report.rewritten).toBe(1)
    const after = db.prepare(`SELECT payload FROM events WHERE session_id='s1'`).get() as { payload: string }
    expect(after.payload).not.toContain('data:image')
    expect(after.payload).toContain(hashBytes(PNG))
    const rec = events.blobStore.get(hashBytes(PNG))
    expect(rec.bytes.equals(PNG)).toBe(true)
    expect(rec.mime).toBe('image/png')
    expect(getBlobMigrationStatus(db, 's1')).toBe('switched')
  })

  it('resumes after a kill during copy without duplicating or losing bytes', () => {
    const first = events.migrateSessionBlobs('s1')
    expect(first.status).toBe('switched')
    const second = events.migrateSessionBlobs('s1')
    expect(second.rewritten).toBe(0)
    expect(second.status).toBe('switched')
    const n = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id='s1'`).get() as { n: number }
    expect(n.n).toBe(1)
    expect(events.blobStore.get(hashBytes(PNG)).bytes.equals(PNG)).toBe(true)
  })

  it('keeps originals intact when the switch transaction is aborted', () => {
    const wrapped = db.transaction(() => {
      events.migrateSessionBlobs('s1')
      throw new Error('killed mid switch')
    })
    expect(() => wrapped()).toThrow(/killed mid switch/)
    const row = db.prepare(`SELECT payload FROM events WHERE session_id='s1'`).get() as { payload: string }
    expect(row.payload).toBe(original)
    expect(row.payload).toContain('data:image/png')
  })

  it('does not delete original event rows', () => {
    const idBefore = db.prepare(`SELECT id FROM events WHERE session_id='s1'`).get() as { id: number }
    events.migrateSessionBlobs('s1')
    const idAfter = db.prepare(`SELECT id FROM events WHERE session_id='s1'`).get() as { id: number }
    expect(idAfter.id).toBe(idBefore.id)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).toEqual({ n: 1 })
  })
})

describe('startup does not migrate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-boot-'))
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

  it('leaves inline snapshots untouched when EventStore starts', () => {
    const dbPath = join(dir, 'sessions.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE TABLE sessions (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0);
    `)
    const original = seedInline(db, 's1')
    db.close()

    const opened = new Database(dbPath)
    initEventStore(opened)
    const payload = opened.prepare(`SELECT payload FROM events`).get() as { payload: string }
    expect(payload.payload).toBe(original)
    expect(payload.payload).toContain('data:image/png')
    expect(getEventStore().blobStore.has(hashBytes(PNG))).toBe(false)
    opened.close()
  })

  it('sends new writes through the blob store without a migration', () => {
    const db = new Database(':memory:')
    const events = new EventStore(db)
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)`)
    db.exec(`INSERT INTO sessions (id) VALUES ('s2')`)
    const stored = events.append('s2', {
      type: 'message.start',
      data: {
        messageId: 'n1',
        role: 'user',
        content: 'new',
        attachments: [{ id: 'a', filename: 'dot.png', mimeType: 'image/png', size: PNG.length, data: PNG_URL }],
      },
    })
    const payload = db.prepare(`SELECT payload FROM events`).get() as { payload: string }
    expect(payload.payload).not.toContain('data:image')
    expect((stored.data as { attachments: Array<{ blob?: { hash: string } }> }).attachments[0]?.blob?.hash).toBe(
      hashBytes(PNG),
    )
    db.close()
  })
})
