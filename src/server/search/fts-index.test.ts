import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import type { TurnEvent, SessionSnapshot } from '../events/types.js'
import {
  searchSessionIds,
  buildMatchQuery,
  isSearchIndexReady,
  getSearchIndexReadyState,
  SEARCH_INDEX_SCHEMA_VERSION,
  ensureSearchSchema,
  SearchIndexer,
} from './fts-index.js'

function snapshot(messages: SessionSnapshot['messages']): SessionSnapshot {
  return {
    mode: 'planner',
    phase: 'plan',
    isRunning: false,
    messages,
    criteria: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 0,
      maxTokens: 1000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId: 'w1',
    todos: [],
    snapshotSeq: 1,
    snapshotAt: Date.now(),
  }
}

function userStart(
  id: string,
  content: string,
  extra: { isSystemGenerated?: boolean; messageKind?: 'auto-prompt'; subAgentType?: string } = {},
): TurnEvent {
  return {
    type: 'message.start',
    data: { messageId: id, role: 'user', content, ...extra },
  }
}

describe('C1 FTS index write path', () => {
  let db: Database.Database
  let store: EventStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        project_id TEXT,
        workdir TEXT DEFAULT '',
        phase TEXT DEFAULT 'idle',
        created_at TEXT DEFAULT '',
        updated_at TEXT DEFAULT ''
      )
    `)
    store = new EventStore(db)
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES (?, ?, ?)`).run('s1', 'Alpha title', 'p1')
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES (?, ?, ?)`).run('s2', 'Other', 'p2')
  })

  afterEach(() => {
    db.close()
  })

  function ids(q: string, projectId?: string): string[] {
    return searchSessionIds(db, q, { limit: 20, offset: 0, ...(projectId ? { projectId } : {}) }).sessionIds
  }

  it('indexes title and user prompts without parsing turn.snapshot', () => {
    const spy = vi.spyOn(store, 'getLatestSnapshot')
    store.append('s1', {
      type: 'session.initialized',
      data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1', title: 'Alpha title' },
    })
    store.append('s1', userStart('m1', 'hello world unique-term'))
    store.append('s1', { type: 'message.delta', data: { messageId: 'm1', content: ' and more' } })
    store.append('s1', { type: 'message.done', data: { messageId: 'm1' } })
    expect(spy).not.toHaveBeenCalled()
    expect(ids('unique-term')).toEqual(['s1'])
    expect(ids('Alpha')).toEqual(['s1'])
    expect(ids('more')).toEqual(['s1'])
  })

  it('indexes the final merged content of deltas, not only message.start', () => {
    store.append('s1', userStart('m1', 'start-only-aaa'))
    store.append('s1', { type: 'message.delta', data: { messageId: 'm1', content: ' merged-zzz' } })
    store.append('s1', { type: 'message.done', data: { messageId: 'm1' } })
    expect(ids('merged-zzz')).toEqual(['s1'])
  })

  it('excludes system, sub-agent and messageKind messages', () => {
    store.append('s1', userStart('m-sys', 'system-secret', { isSystemGenerated: true }))
    store.append('s1', userStart('m-kind', 'kind-secret', { messageKind: 'auto-prompt' }))
    store.append('s1', userStart('m-sub', 'sub-secret', { subAgentType: 'explore' }))
    store.append('s1', {
      type: 'message.start',
      data: { messageId: 'm-as', role: 'assistant', content: 'assistant-secret' },
    })
    expect(ids('system-secret')).toEqual([])
    expect(ids('kind-secret')).toEqual([])
    expect(ids('sub-secret')).toEqual([])
    expect(ids('assistant-secret')).toEqual([])
  })

  it('does not index snapshot-only prompts on the online path', () => {
    store.append('s1', {
      type: 'turn.snapshot',
      data: snapshot([
        {
          id: 'snap-1',
          role: 'user',
          content: 'snapshot-only-term',
          timestamp: Date.now(),
        },
      ]),
    })
    expect(ids('snapshot-only-term')).toEqual([])
  })

  it('keeps indexed prompts across cleanupOldEvents (technical purge)', () => {
    store.append('s1', {
      type: 'session.initialized',
      data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
    })
    store.append('s1', userStart('old-1', 'ancient-keep-me'))
    store.append('s1', {
      type: 'turn.snapshot',
      data: snapshot([{ id: 'old-1', role: 'user', content: 'ancient-keep-me', timestamp: Date.now() }]),
    })
    store.cleanupOldEvents('s1')
    expect(ids('ancient-keep-me')).toEqual(['s1'])
  })

  it('removes a session from the index on deleteSession', () => {
    store.append('s1', userStart('m1', 'gone-soon'))
    expect(ids('gone-soon')).toEqual(['s1'])
    store.deleteSession('s1')
    expect(ids('gone-soon')).toEqual([])
  })

  it('logical message removal takes explicit ids and does not read snapshots', () => {
    store.append('s1', userStart('keep', 'keep-term'))
    store.append('s1', userStart('drop', 'drop-term'))
    const spy = vi.spyOn(store, 'getLatestSnapshot')
    store.searchIndex.removeMessages('s1', ['drop'])
    expect(spy).not.toHaveBeenCalled()
    expect(ids('drop-term')).toEqual([])
    expect(ids('keep-term')).toEqual(['s1'])
  })

  it('rolls back the event when the FTS write fails', () => {
    db.exec('DROP TABLE search_index')
    expect(() => store.append('s1', userStart('m1', 'will-fail'))).toThrow()
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(events.n).toBe(0)
  })

  it('keeps event and index in the same transaction for appendBatch', () => {
    store.appendBatch('s1', [userStart('m1', 'batch-term-one'), userStart('m2', 'batch-term-two')])
    expect(ids('batch-term-one')).toEqual(['s1'])
    expect(ids('batch-term-two')).toEqual(['s1'])
  })

  it('updates the title on session.name_generated', () => {
    store.append('s1', { type: 'session.name_generated', data: { name: 'RenamedUnique' } })
    expect(ids('RenamedUnique')).toEqual(['s1'])
  })

  it('dedupes by session before pagination and orders by native bm25 (lower is better)', () => {
    store.append('s1', userStart('m1', 'needle extra needle'))
    store.append('s1', userStart('m2', 'needle'))
    store.append('s2', userStart('m3', 'needle'))
    const page = searchSessionIds(db, 'needle', { limit: 1, offset: 0 })
    expect(page.sessionIds).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    const page2 = searchSessionIds(db, 'needle', { limit: 1, offset: 1 })
    expect(page2.sessionIds).toHaveLength(1)
    expect([...page.sessionIds, ...page2.sessionIds].sort()).toEqual(['s1', 's2'])
  })

  it('applies the project filter', () => {
    store.append('s1', userStart('m1', 'shared-term'))
    store.append('s2', userStart('m2', 'shared-term'))
    expect(ids('shared-term', 'p1')).toEqual(['s1'])
    expect(ids('shared-term', 'p2')).toEqual(['s2'])
  })

  it('handles words, prefixes, accents, multi-word, empty and punctuation without throwing', () => {
    store.append('s1', userStart('m1', 'café prefixable-term alpha bravo hello, world!'))
    expect(ids('cafe')).toEqual(['s1'])
    expect(ids('prefix')).toEqual(['s1'])
    expect(ids('alpha bravo')).toEqual(['s1'])
    expect(ids('hello!')).toEqual(['s1'])
    expect(ids('   ')).toEqual([])
    expect(ids('""')).toEqual([])
    expect(ids('no-such-zzzz')).toEqual([])
    expect(() => searchSessionIds(db, 'AND OR * "')).not.toThrow()
  })

  it('does not mark a pre-existing database ready after new writes', () => {
    store.append('s1', userStart('m1', 'fresh-write'))
    expect(isSearchIndexReady(db)).toBe(false)
    expect(getSearchIndexReadyState(db)).toEqual({ version: SEARCH_INDEX_SCHEMA_VERSION, ready: false })
  })

  it('buildMatchQuery quotes tokens for MATCH', () => {
    expect(buildMatchQuery('  foo bar  ')).toBe('"foo"* AND "bar"*')
    expect(buildMatchQuery('unique-term')).toBe('"unique"* AND "term"*')
    expect(buildMatchQuery('')).toBeNull()
  })

  it('does not keep a rolled-back delta in the in-memory pending buffer', () => {
    store.append('s1', userStart('m1', 'keep-prefix-'))
    db.exec('DROP TABLE search_index')
    expect(() =>
      store.append('s1', { type: 'message.delta', data: { messageId: 'm1', content: 'rolled-back-zzz' } }),
    ).toThrow()
    ensureSearchSchema(db)
    store.append('s1', { type: 'message.delta', data: { messageId: 'm1', content: 'committed-yyy' } })
    expect(ids('rolled-back-zzz')).toEqual([])
    expect(ids('committed-yyy')).toEqual(['s1'])
    expect(ids('keep-prefix')).toEqual(['s1'])
  })

  it('uses the sessions table title after a rename through a different indexer', () => {
    store.append('s1', userStart('m1', 'before-rename'))
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('BravoUnique', 's1')
    new SearchIndexer(db).updateTitle('s1', 'BravoUnique')
    store.append('s1', userStart('m2', 'after-rename'))
    expect(ids('BravoUnique')).toEqual(['s1'])
    expect(ids('Alpha')).toEqual([])
  })
})
