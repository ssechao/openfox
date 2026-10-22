import type Database from 'better-sqlite3'
import type { BlobStore } from './blob-store.js'
import { extractBinaries, payloadHasInlineBinary } from './blob-codec.js'
import { parkAtBlobBarrier } from './blob-barrier.js'

export type BlobMigrationStatus = 'copied' | 'switched'

export interface BlobMigrationReport {
  sessionId: string
  scanned: number
  rewritten: number
  status: BlobMigrationStatus
}

export function ensureBlobMigrationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blob_migration (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

export function getBlobMigrationStatus(db: Database.Database, sessionId: string): BlobMigrationStatus | null {
  ensureBlobMigrationSchema(db)
  const row = db.prepare('SELECT status FROM blob_migration WHERE session_id = ?').get(sessionId) as
    { status: string } | undefined
  if (row?.status === 'copied' || row?.status === 'switched') return row.status
  return null
}

function setStatus(db: Database.Database, sessionId: string, status: BlobMigrationStatus): void {
  ensureBlobMigrationSchema(db)
  db.prepare(
    `INSERT INTO blob_migration (session_id, status, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run(sessionId, status, Date.now())
}

export function migrateSessionBlobs(db: Database.Database, sessionId: string, store: BlobStore): BlobMigrationReport {
  ensureBlobMigrationSchema(db)
  const existing = getBlobMigrationStatus(db, sessionId)
  const rows = db.prepare('SELECT id, payload FROM events WHERE session_id = ?').all(sessionId) as Array<{
    id: number
    payload: string
  }>

  if (existing === 'switched' && !rows.some((row) => payloadHasInlineBinary(row.payload))) {
    return { sessionId, scanned: rows.length, rewritten: 0, status: 'switched' }
  }

  const updates: Array<{ id: number; payload: string }> = []
  for (const row of rows) {
    if (!payloadHasInlineBinary(row.payload)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    const extracted = extractBinaries(parsed, store)
    const payload = JSON.stringify(extracted)
    if (payload !== row.payload) updates.push({ id: row.id, payload })
  }

  parkAtBlobBarrier('after-blob-write')
  setStatus(db, sessionId, 'copied')
  parkAtBlobBarrier('before-switch')

  const switchTx = db.transaction(() => {
    const update = db.prepare('UPDATE events SET payload = ? WHERE id = ?')
    for (const row of updates) update.run(row.payload, row.id)
    setStatus(db, sessionId, 'switched')
  })
  switchTx()
  parkAtBlobBarrier('after-switch')

  return { sessionId, scanned: rows.length, rewritten: updates.length, status: 'switched' }
}

export function migrateAllBlobs(db: Database.Database, store: BlobStore): BlobMigrationReport[] {
  const sessions = db.prepare('SELECT DISTINCT session_id FROM events').all() as Array<{ session_id: string }>
  return sessions.map((row) => migrateSessionBlobs(db, row.session_id, store))
}
