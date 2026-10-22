/**
 * FTS5 session search index.
 *
 * Online writes never parse turn.snapshot. Rebuild (CLI) and explicit import
 * may read snapshots to recover prompts that cleanupOldEvents deleted.
 */
import type Database from 'better-sqlite3'
import { parkAtBlobBarrier } from '../events/blob-barrier.js'
import type { TurnEvent } from '../events/types.js'

export const SEARCH_INDEX_READY_KEY = 'search.indexReady'
export const SEARCH_INDEX_SCHEMA_VERSION = 1
export const TITLE_ROW_ID = ''

export const SEARCH_INDEX_UNAVAILABLE = {
  en: 'Search index is unavailable. Run scripts/rebuild-search-index.ts to enable search.',
  fr: "L'index de recherche est indisponible. Exécutez scripts/rebuild-search-index.ts pour activer la recherche.",
} as const

const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  session_id UNINDEXED,
  message_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
)`

const FTS_REBUILD_DDL = `CREATE VIRTUAL TABLE search_index_rebuild USING fts5(
  session_id UNINDEXED,
  message_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
)`

export interface SearchIndexReadyState {
  version: number
  ready: boolean
}

export interface SearchHit {
  sessionId: string
  messageId: string
  matchField: 'title' | 'body'
  snippet: string
}

export interface SearchPage {
  sessionIds: string[]
  hits: SearchHit[]
  hasMore: boolean
  total: number
}

const EMPTY_PAGE: SearchPage = { sessionIds: [], hits: [], hasMore: false, total: 0 }

interface IndexableMessage {
  id: string
  content: string
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`).get(name) as
    { name: string } | undefined
  return Boolean(row)
}

export function ensureSearchSchema(db: Database.Database): void {
  db.exec(FTS_DDL)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEARCH_INDEX_READY_KEY) as
    { value: string } | undefined
  if (!existing) {
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SEARCH_INDEX_READY_KEY,
      JSON.stringify({ version: SEARCH_INDEX_SCHEMA_VERSION, ready: false }),
      new Date().toISOString(),
    )
  }
}

export function getSearchIndexReadyState(db: Database.Database): SearchIndexReadyState {
  ensureSearchSchema(db)
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEARCH_INDEX_READY_KEY) as
    { value: string } | undefined
  if (!row) return { version: SEARCH_INDEX_SCHEMA_VERSION, ready: false }
  try {
    const parsed = JSON.parse(row.value) as { version?: unknown; ready?: unknown }
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.ready === 'boolean') {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        ready: parsed.ready,
      }
    }
  } catch {
    if (row.value === 'true') return { version: SEARCH_INDEX_SCHEMA_VERSION, ready: true }
    if (row.value === 'false') return { version: SEARCH_INDEX_SCHEMA_VERSION, ready: false }
  }
  return { version: SEARCH_INDEX_SCHEMA_VERSION, ready: false }
}

export function isSearchIndexReady(db: Database.Database): boolean {
  const state = getSearchIndexReadyState(db)
  return state.ready && state.version === SEARCH_INDEX_SCHEMA_VERSION
}

export function setSearchIndexReadyState(db: Database.Database, state: SearchIndexReadyState): void {
  ensureSearchSchema(db)
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SEARCH_INDEX_READY_KEY, JSON.stringify(state), new Date().toISOString())
}

export function isIndexableUserMessage(message: {
  role?: string
  isSystemGenerated?: boolean
  messageKind?: string
  subAgentType?: string
}): boolean {
  return message.role === 'user' && !message.isSystemGenerated && !message.messageKind && !message.subAgentType
}

function readTitle(db: Database.Database, sessionId: string, fallback: string): string {
  if (!tableExists(db, 'sessions')) return fallback
  try {
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as
      { title: string | null } | undefined
    return row?.title ?? fallback
  } catch {
    return fallback
  }
}

function upsertRow(
  db: Database.Database,
  table: string,
  sessionId: string,
  messageId: string,
  title: string,
  body: string,
): void {
  db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND message_id = ?`).run(sessionId, messageId)
  db.prepare(`INSERT INTO ${table} (session_id, message_id, title, body) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    messageId,
    title,
    body,
  )
}

function deleteSessionRows(db: Database.Database, table: string, sessionId: string): void {
  db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
}

function deleteMessageRows(db: Database.Database, table: string, sessionId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const del = db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND message_id = ?`)
  for (const id of messageIds) del.run(sessionId, id)
}

export function buildMatchQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.replace(/["*]/g, ''))
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

export function searchSessionIds(
  db: Database.Database,
  query: string,
  options: { limit?: number; offset?: number; projectId?: string } = {},
): SearchPage {
  ensureSearchSchema(db)
  const match = buildMatchQuery(query)
  if (!match) return EMPTY_PAGE
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const offset = Math.max(options.offset ?? 0, 0)
  const projectId = options.projectId
  const grouped = `SELECT session_id, MIN(rank) AS best
     FROM search_index WHERE search_index MATCH ? GROUP BY session_id`
  const fromHits =
    projectId && tableExists(db, 'sessions')
      ? `SELECT h.session_id AS session_id, h.best AS best
         FROM (${grouped}) h
         JOIN sessions s ON s.id = h.session_id
         WHERE s.project_id = ?`
      : grouped
  try {
    const countRow =
      projectId && tableExists(db, 'sessions')
        ? (db.prepare(`SELECT COUNT(*) AS n FROM (${fromHits})`).get(match, projectId) as { n: number })
        : (db.prepare(`SELECT COUNT(*) AS n FROM (${fromHits})`).get(match) as { n: number })
    const total = countRow?.n ?? 0
    const pageSql = `SELECT session_id, best FROM (${fromHits}) ORDER BY best ASC, session_id ASC LIMIT ? OFFSET ?`
    const rows =
      projectId && tableExists(db, 'sessions')
        ? (db.prepare(pageSql).all(match, projectId, limit + 1, offset) as Array<{ session_id: string }>)
        : (db.prepare(pageSql).all(match, limit + 1, offset) as Array<{ session_id: string }>)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const sessionIds = page.map((row) => row.session_id)
    const hits = attachSearchHits(db, match, sessionIds)
    return { sessionIds, hits, hasMore, total }
  } catch {
    return EMPTY_PAGE
  }
}

function attachSearchHits(db: Database.Database, match: string, sessionIds: string[]): SearchHit[] {
  if (sessionIds.length === 0) return []
  const placeholders = sessionIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT session_id, message_id, snippet(search_index, 3, '', '', '…', 24) AS body_snip, rank AS best
       FROM search_index
       WHERE search_index MATCH ? AND session_id IN (${placeholders})
       ORDER BY rank ASC, session_id ASC`,
    )
    .all(match, ...sessionIds) as Array<{ session_id: string; message_id: string; body_snip: string }>
  const first = new Map<string, SearchHit>()
  for (const row of rows) {
    if (first.has(row.session_id)) continue
    first.set(row.session_id, {
      sessionId: row.session_id,
      messageId: row.message_id,
      matchField: row.message_id === TITLE_ROW_ID ? 'title' : 'body',
      snippet: row.body_snip ?? '',
    })
  }
  return sessionIds.flatMap((id) => {
    const hit = first.get(id)
    return hit ? [hit] : []
  })
}

type PendingEntry = { content: string; indexable: boolean }

export class SearchIndexer {
  private pending = new Map<string, Map<string, PendingEntry>>()

  constructor(private readonly db: Database.Database) {
    ensureSearchSchema(db)
  }

  /** Snapshot in-memory pending buffers and restore them if `fn` throws. */
  withPendingRollback<T>(fn: () => T): T {
    const snapshot = this.clonePending()
    try {
      return fn()
    } catch (error) {
      this.pending = snapshot
      throw error
    }
  }

  apply(
    sessionId: string,
    event: TurnEvent,
    _timestamp: number,
    options: { allowSnapshot?: boolean; removeMessageIds?: string[] } = {},
  ): void {
    if (event.type === 'session.initialized' && event.data.title) {
      this.updateTitle(sessionId, event.data.title)
      return
    }
    if (event.type === 'session.name_generated') {
      this.updateTitle(sessionId, event.data.name)
      return
    }
    if (event.type === 'turn.snapshot') {
      if (options.allowSnapshot) this.indexSnapshotMessages(sessionId, event.data.messages ?? [])
      if (options.removeMessageIds) this.removeMessages(sessionId, options.removeMessageIds)
      return
    }
    if (event.type === 'message.start') {
      const indexable = isIndexableUserMessage(event.data)
      const content = event.data.content ?? ''
      if (indexable) this.upsertMessage(sessionId, event.data.messageId, content)
      this.sessionPending(sessionId).set(event.data.messageId, { content, indexable })
      return
    }
    if (event.type === 'message.delta') {
      const pending = this.sessionPending(sessionId).get(event.data.messageId)
      if (!pending) return
      const next = pending.content + event.data.content
      if (pending.indexable) this.upsertMessage(sessionId, event.data.messageId, next)
      pending.content = next
      return
    }
    if (event.type === 'message.done') {
      const pending = this.sessionPending(sessionId).get(event.data.messageId)
      if (pending?.indexable) this.upsertMessage(sessionId, event.data.messageId, pending.content)
      this.sessionPending(sessionId).delete(event.data.messageId)
    }
    if (options.removeMessageIds) this.removeMessages(sessionId, options.removeMessageIds)
  }

  updateTitle(sessionId: string, title: string): void {
    const current = this.db
      .prepare('SELECT message_id, body FROM search_index WHERE session_id = ?')
      .all(sessionId) as Array<{ message_id: string; body: string }>
    if (current.length === 0) {
      upsertRow(this.db, 'search_index', sessionId, TITLE_ROW_ID, title, '')
      return
    }
    for (const row of current) {
      upsertRow(this.db, 'search_index', sessionId, row.message_id, title, row.body)
    }
    if (!current.some((row) => row.message_id === TITLE_ROW_ID)) {
      upsertRow(this.db, 'search_index', sessionId, TITLE_ROW_ID, title, '')
    }
  }

  removeSession(sessionId: string): void {
    deleteSessionRows(this.db, 'search_index', sessionId)
    this.pending.delete(sessionId)
  }

  removeMessages(sessionId: string, messageIds: string[]): void {
    deleteMessageRows(this.db, 'search_index', sessionId, messageIds)
    const pending = this.pending.get(sessionId)
    if (pending) {
      for (const id of messageIds) pending.delete(id)
    }
  }

  private clonePending(): Map<string, Map<string, PendingEntry>> {
    const clone = new Map<string, Map<string, PendingEntry>>()
    for (const [sessionId, messages] of this.pending) {
      const inner = new Map<string, PendingEntry>()
      for (const [messageId, entry] of messages) {
        inner.set(messageId, { content: entry.content, indexable: entry.indexable })
      }
      clone.set(sessionId, inner)
    }
    return clone
  }

  private sessionPending(sessionId: string): Map<string, PendingEntry> {
    let map = this.pending.get(sessionId)
    if (!map) {
      map = new Map()
      this.pending.set(sessionId, map)
    }
    return map
  }

  private titleOf(sessionId: string): string {
    return readTitle(this.db, sessionId, '')
  }

  indexUserMessages(
    sessionId: string,
    messages: Array<{
      id?: string
      role?: string
      content?: string
      isSystemGenerated?: boolean
      messageKind?: string
      subAgentType?: string
    }>,
  ): void {
    this.indexSnapshotMessages(sessionId, messages)
  }

  private upsertMessage(sessionId: string, messageId: string, body: string): void {
    upsertRow(this.db, 'search_index', sessionId, messageId, this.titleOf(sessionId), body)
  }

  private indexSnapshotMessages(
    sessionId: string,
    messages: Array<{
      id?: string
      role?: string
      content?: string
      isSystemGenerated?: boolean
      messageKind?: string
      subAgentType?: string
    }>,
  ): void {
    const title = this.titleOf(sessionId)
    upsertRow(this.db, 'search_index', sessionId, TITLE_ROW_ID, title, '')
    for (const message of messages) {
      if (!message.id || !isIndexableUserMessage(message)) continue
      upsertRow(this.db, 'search_index', sessionId, message.id, title, message.content ?? '')
    }
  }
}

function latestSnapshotSeq(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(`SELECT MAX(seq) AS seq FROM events WHERE session_id = ? AND event_type = 'turn.snapshot'`)
    .get(sessionId) as { seq: number | null } | undefined
  return row?.seq ?? 0
}

function collectIndexableFromSnapshot(payload: string): IndexableMessage[] {
  try {
    const parsed = JSON.parse(payload) as {
      messages?: Array<{
        id?: string
        role?: string
        content?: string
        isSystemGenerated?: boolean
        messageKind?: string
        subAgentType?: string
      }>
    }
    const out: IndexableMessage[] = []
    for (const message of parsed.messages ?? []) {
      if (!message.id || !isIndexableUserMessage(message)) continue
      out.push({ id: message.id, content: message.content ?? '' })
    }
    return out
  } catch {
    return []
  }
}

function populateTable(db: Database.Database, table: string): void {
  const sessions = tableExists(db, 'sessions')
    ? (db.prepare('SELECT id, title FROM sessions').all() as Array<{ id: string; title: string | null }>)
    : []
  const sessionIds =
    sessions.length > 0
      ? sessions.map((row) => row.id)
      : (db.prepare('SELECT DISTINCT session_id AS id FROM events').all() as Array<{ id: string }>).map((row) => row.id)
  const titleById = new Map(sessions.map((row) => [row.id, row.title ?? '']))

  const insert = db.prepare(`INSERT INTO ${table} (session_id, message_id, title, body) VALUES (?, ?, ?, ?)`)
  const eventRows = db.prepare(
    `SELECT event_type, payload FROM events
     WHERE session_id = ? AND seq > ? AND event_type IN ('message.start', 'message.delta', 'message.done')
     ORDER BY seq`,
  )
  const snapshotRow = db.prepare(
    `SELECT payload FROM events WHERE session_id = ? AND event_type = 'turn.snapshot' ORDER BY seq DESC LIMIT 1`,
  )

  for (const sessionId of sessionIds) {
    const title = titleById.get(sessionId) ?? ''
    insert.run(sessionId, TITLE_ROW_ID, title, '')
    const bodies = new Map<string, { content: string; indexable: boolean }>()
    const snapshot = snapshotRow.get(sessionId) as { payload: string } | undefined
    if (snapshot) {
      for (const message of collectIndexableFromSnapshot(snapshot.payload)) {
        bodies.set(message.id, { content: message.content, indexable: true })
      }
    }
    const after = latestSnapshotSeq(db, sessionId)
    const rows = eventRows.all(sessionId, after) as Array<{ event_type: string; payload: string }>
    for (const row of rows) {
      try {
        const data = JSON.parse(row.payload) as {
          messageId?: string
          role?: string
          content?: string
          isSystemGenerated?: boolean
          messageKind?: string
          subAgentType?: string
        }
        const messageId = data.messageId
        if (!messageId) continue
        if (row.event_type === 'message.start') {
          bodies.set(messageId, {
            content: data.content ?? '',
            indexable: isIndexableUserMessage(data),
          })
        } else if (row.event_type === 'message.delta') {
          const pending = bodies.get(messageId)
          if (pending) pending.content += data.content ?? ''
        } else if (row.event_type === 'message.done') {
          // content already accumulated
        }
      } catch {
        continue
      }
    }
    for (const [messageId, pending] of bodies) {
      if (!pending.indexable) continue
      insert.run(sessionId, messageId, title, pending.content)
    }
  }
}

/** Offline rebuild. Caller must hold the instance lock. */
export function rebuildSearchIndex(db: Database.Database): { sessions: number } {
  ensureSearchSchema(db)
  db.exec('DROP TABLE IF EXISTS search_index_rebuild')
  db.exec(FTS_REBUILD_DDL)
  populateTable(db, 'search_index_rebuild')
  parkAtBlobBarrier('before-search-rebuild-swap')
  const sessions = (
    db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM search_index_rebuild').get() as { n: number }
  ).n
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS search_index')
    db.exec('ALTER TABLE search_index_rebuild RENAME TO search_index')
    setSearchIndexReadyState(db, { version: SEARCH_INDEX_SCHEMA_VERSION, ready: true })
  })()
  return { sessions }
}
