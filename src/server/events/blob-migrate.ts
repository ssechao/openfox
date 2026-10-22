import type Database from 'better-sqlite3'
import type { BlobStore } from './blob-store.js'
import { extractBinaries, payloadHasInlineBinary } from './blob-codec.js'
import { rewriteSessionPayloads } from './blob-rewrite.js'

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
  const rows = db.prepare('SELECT payload FROM events WHERE session_id = ?').all(sessionId) as Array<{
    payload: string
  }>
  if (existing === 'switched' && !rows.some((row) => payloadHasInlineBinary(row.payload))) {
    return { sessionId, scanned: rows.length, rewritten: 0, status: 'switched' }
  }

  const { scanned, rewritten } = rewriteSessionPayloads(db, sessionId, {
    shouldRewrite: payloadHasInlineBinary,
    transform: (parsed) => extractBinaries(parsed, store),
    afterPrepBarrier: 'after-blob-write',
    beforeSwitchBarrier: 'before-switch',
    afterSwitchBarrier: 'after-switch',
    markPrepared: () => setStatus(db, sessionId, 'copied'),
    markSwitched: () => setStatus(db, sessionId, 'switched'),
  })
  return { sessionId, scanned, rewritten, status: 'switched' }
}

export function migrateAllBlobs(db: Database.Database, store: BlobStore): BlobMigrationReport[] {
  const sessions = db.prepare('SELECT DISTINCT session_id FROM events').all() as Array<{ session_id: string }>
  return sessions.map((row) => migrateSessionBlobs(db, row.session_id, store))
}
