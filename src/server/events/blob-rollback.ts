import type Database from 'better-sqlite3'
import type { BlobStore } from './blob-store.js'
import { payloadHasBlobRef, reinlineBinaries } from './blob-codec.js'
import { rewriteSessionPayloads, sessionPayloadsNeedRewrite } from './blob-rewrite.js'

export type BlobRollbackStatus = 'hydrated' | 'switched'

export interface BlobRollbackReport {
  sessionId: string
  scanned: number
  rewritten: number
  status: BlobRollbackStatus
}

export function ensureBlobRollbackSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blob_rollback (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

export function getBlobRollbackStatus(db: Database.Database, sessionId: string): BlobRollbackStatus | null {
  ensureBlobRollbackSchema(db)
  const row = db.prepare('SELECT status FROM blob_rollback WHERE session_id = ?').get(sessionId) as
    { status: string } | undefined
  if (row?.status === 'hydrated' || row?.status === 'switched') return row.status
  return null
}

function setStatus(db: Database.Database, sessionId: string, status: BlobRollbackStatus): void {
  ensureBlobRollbackSchema(db)
  db.prepare(
    `INSERT INTO blob_rollback (session_id, status, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run(sessionId, status, Date.now())
}

export function rollbackSessionBlobs(db: Database.Database, sessionId: string, store: BlobStore): BlobRollbackReport {
  ensureBlobRollbackSchema(db)
  const existing = getBlobRollbackStatus(db, sessionId)
  const check = sessionPayloadsNeedRewrite(db, sessionId, payloadHasBlobRef)
  if (existing === 'switched' && !check.needed) {
    return { sessionId, scanned: check.scanned, rewritten: 0, status: 'switched' }
  }

  const { scanned, rewritten } = rewriteSessionPayloads(db, sessionId, {
    shouldRewrite: payloadHasBlobRef,
    transform: (parsed) => reinlineBinaries(parsed, store),
    afterPrepBarrier: 'after-hydrate',
    beforeSwitchBarrier: 'before-switch',
    afterSwitchBarrier: 'after-switch',
    markPrepared: () => setStatus(db, sessionId, 'hydrated'),
    markSwitched: () => setStatus(db, sessionId, 'switched'),
  })
  return { sessionId, scanned, rewritten, status: 'switched' }
}

export function rollbackAllBlobs(db: Database.Database, store: BlobStore): BlobRollbackReport[] {
  const sessions = db.prepare('SELECT DISTINCT session_id FROM events').all() as Array<{ session_id: string }>
  return sessions.map((row) => rollbackSessionBlobs(db, row.session_id, store))
}
