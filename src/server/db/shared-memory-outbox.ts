import { randomUUID } from 'node:crypto'
import { getDatabase } from './index.js'

export interface OutboxItem {
  id: string
  sessionId: string
  projectId: string | null
  collection: string
  payload: Record<string, unknown>
  tags: string[]
  identifiers: string[]
  dedupKey: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

interface OutboxRow {
  id: string
  session_id: string
  project_id: string | null
  collection: string
  payload: string
  tags: string
  identifiers: string
  dedup_key: string
  status: string
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

function rowToItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    collection: row.collection,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    tags: JSON.parse(row.tags) as string[],
    identifiers: JSON.parse(row.identifiers) as string[],
    dedupKey: row.dedup_key,
    status: row.status as OutboxItem['status'],
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Durable outbox insert (criterion 5): the candidate is persisted BEFORE any
 * network call to the hub, so a crash/restart between extraction and
 * delivery never silently loses it — the next capture pass retries pending
 * items (see src/server/memory/capture.ts).
 */
export function enqueueOutboxItem(item: {
  sessionId: string
  projectId: string | null
  collection: string
  payload: Record<string, unknown>
  tags: string[]
  identifiers: string[]
  dedupKey: string
}): OutboxItem {
  const db = getDatabase()
  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO shared_memory_outbox
       (id, session_id, project_id, collection, payload, tags, identifiers, dedup_key, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    id,
    item.sessionId,
    item.projectId,
    item.collection,
    JSON.stringify(item.payload),
    JSON.stringify(item.tags),
    JSON.stringify(item.identifiers),
    item.dedupKey,
    now,
    now,
  )
  return {
    id,
    sessionId: item.sessionId,
    projectId: item.projectId,
    collection: item.collection,
    payload: item.payload,
    tags: item.tags,
    identifiers: item.identifiers,
    dedupKey: item.dedupKey,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function findOutboxItemByDedupKey(sessionId: string, dedupKey: string): OutboxItem | null {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT * FROM shared_memory_outbox WHERE session_id = ? AND dedup_key = ?`)
    .get(sessionId, dedupKey) as OutboxRow | undefined
  return row ? rowToItem(row) : null
}

export function listPendingOutboxItems(sessionId: string, limit = 20): OutboxItem[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT * FROM shared_memory_outbox WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    )
    .all(sessionId, limit) as OutboxRow[]
  return rows.map(rowToItem)
}

export function markOutboxItemSent(id: string): void {
  const db = getDatabase()
  db.prepare(`UPDATE shared_memory_outbox SET status = 'sent', updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  )
}

/** Bounded retry: stays 'pending' (idempotent retry) until maxAttempts, then 'failed'. */
export function markOutboxItemAttemptFailed(id: string, error: string, maxAttempts = 5): void {
  const db = getDatabase()
  const now = new Date().toISOString()
  const row = db.prepare(`SELECT attempts FROM shared_memory_outbox WHERE id = ?`).get(id) as
    { attempts: number } | undefined
  const attempts = (row?.attempts ?? 0) + 1
  const status = attempts >= maxAttempts ? 'failed' : 'pending'
  db.prepare(
    `UPDATE shared_memory_outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, attempts, error, now, id)
}
