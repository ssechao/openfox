import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventStore } from './store.js'
import type { SessionSnapshot } from './types.js'

describe('EventStore cache invalidation', () => {
  let db: Database.Database
  let store: EventStore

  const snapshot = (messages: SessionSnapshot['messages'] = []): SessionSnapshot => ({
    mode: 'planner',
    phase: 'plan',
    isRunning: false,
    messages,
    criteria: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId: 'window-1',
    todos: [],
    readFiles: [],
    snapshotSeq: 1,
    snapshotAt: 1000,
  })

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        recent_user_prompts TEXT
      )
    `)
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('session-1')
    store = new EventStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('keeps prompt and snapshot caches hot for a message delta', () => {
    store.append('session-1', {
      type: 'turn.snapshot',
      data: snapshot([{ id: 'm1', role: 'user', content: 'First', timestamp: 1000 }]),
    })
    expect(store.getRecentUserPrompts('session-1', 10)).toHaveLength(1)
    const snapshotSpy = vi.spyOn(store, 'getLatestSnapshot')

    store.append('session-1', {
      type: 'message.delta',
      data: { messageId: 'assistant-1', content: 'chunk' },
    })

    expect(store.getRecentUserPrompts('session-1', 10)).toHaveLength(1)
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('keeps caches hot for a batch containing only technical events', () => {
    store.append('session-1', {
      type: 'turn.snapshot',
      data: snapshot([{ id: 'm1', role: 'user', content: 'First', timestamp: 1000 }]),
    })
    const cachedSnapshot = store.getLatestSnapshot('session-1')
    expect(store.getRecentUserPrompts('session-1', 10)).toHaveLength(1)
    const snapshotSpy = vi.spyOn(store, 'getLatestSnapshot')

    store.appendBatch('session-1', [
      { type: 'message.delta', data: { messageId: 'assistant-1', content: 'chunk' } },
      { type: 'message.thinking', data: { messageId: 'assistant-1', content: 'thought' } },
    ])

    expect(store.getLatestSnapshot('session-1')).toBe(cachedSnapshot)
    snapshotSpy.mockClear()
    expect(store.getRecentUserPrompts('session-1', 10)).toHaveLength(1)
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('invalidates only prompt data for a real user message', () => {
    store.append('session-1', { type: 'turn.snapshot', data: snapshot() })
    const cachedSnapshot = store.getLatestSnapshot('session-1')
    expect(store.getRecentUserPrompts('session-1', 10)).toEqual([])

    store.append('session-1', {
      type: 'message.start',
      data: { messageId: 'm2', role: 'user', content: 'Second' },
    })

    expect(store.getLatestSnapshot('session-1')).toBe(cachedSnapshot)
    expect(store.getRecentUserPrompts('session-1', 10).map((prompt) => prompt.id)).toEqual(['m2'])
  })

  it('invalidates both caches for a new snapshot', () => {
    store.append('session-1', { type: 'turn.snapshot', data: snapshot() })
    const first = store.getLatestSnapshot('session-1')
    store.getRecentUserPrompts('session-1', 10)

    store.append('session-1', {
      type: 'turn.snapshot',
      data: snapshot([{ id: 'm3', role: 'user', content: 'Third', timestamp: 3000 }]),
    })

    expect(store.getLatestSnapshot('session-1')).not.toBe(first)
    expect(store.getRecentUserPrompts('session-1', 10).map((prompt) => prompt.id)).toEqual(['m3'])
  })

  it('populates lightweight prompts when importing events', () => {
    store.importEvents('session-1', [
      {
        seq: 1,
        timestamp: 4000,
        sessionId: 'source-session',
        type: 'message.start',
        data: { messageId: 'm-imported', role: 'user', content: 'Imported' },
      },
    ])

    const coldStore = new EventStore(db)
    const snapshotSpy = vi.spyOn(coldStore, 'getLatestSnapshot')
    expect(coldStore.getRecentUserPrompts('session-1', 10).map((prompt) => prompt.id)).toEqual(['m-imported'])
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('serves cold recent prompts from the lightweight session column', () => {
    store.append('session-1', {
      type: 'message.start',
      data: { messageId: 'm4', role: 'user', content: 'Fourth' },
    })

    const coldStore = new EventStore(db)
    const snapshotSpy = vi.spyOn(coldStore, 'getLatestSnapshot')
    expect(coldStore.getRecentUserPrompts('session-1', 10)).toEqual([
      expect.objectContaining({ id: 'm4', content: 'Fourth' }),
    ])
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('deduplicates duplicate message ids from snapshots', () => {
    store.append('session-1', {
      type: 'turn.snapshot',
      data: snapshot([
        { id: 'duplicate', role: 'user', content: 'Old', timestamp: 1000 },
        { id: 'duplicate', role: 'user', content: 'New', timestamp: 2000 },
      ]),
    })

    const coldStore = new EventStore(db)
    expect(coldStore.getRecentUserPrompts('session-1', 10)).toEqual([
      expect.objectContaining({ id: 'duplicate', content: 'New' }),
    ])
  })

  it('keeps caches hot for a technical import event', () => {
    store.append('session-1', {
      type: 'turn.snapshot',
      data: snapshot([{ id: 'm1', role: 'user', content: 'First', timestamp: 1000 }]),
    })
    const cachedSnapshot = store.getLatestSnapshot('session-1')
    store.getRecentUserPrompts('session-1', 10)
    const snapshotSpy = vi.spyOn(store, 'getLatestSnapshot')

    store.importEvents('session-1', [
      {
        seq: 2,
        timestamp: 2000,
        sessionId: 'source-session',
        type: 'message.delta',
        data: { messageId: 'assistant', content: 'chunk' },
      },
    ])

    expect(store.getLatestSnapshot('session-1')).toBe(cachedSnapshot)
    snapshotSpy.mockClear()
    expect(store.getRecentUserPrompts('session-1', 10).map((prompt) => prompt.id)).toEqual(['m1'])
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('persists real user prompts from batches and filters generated messages', () => {
    store.appendBatch('session-1', [
      { type: 'message.start', data: { messageId: 'real', role: 'user', content: 'Keep me' } },
      {
        type: 'message.start',
        data: { messageId: 'generated', role: 'user', content: 'Drop me', isSystemGenerated: true },
      },
      {
        type: 'message.start',
        data: { messageId: 'subagent', role: 'user', content: 'Drop me too', subAgentType: 'verifier' },
      },
    ])

    const coldStore = new EventStore(db)
    expect(coldStore.getRecentUserPrompts('session-1', 10).map((prompt) => prompt.id)).toEqual(['real'])
  })

  it('bounds persisted prompts to 20 entries without truncating content', () => {
    for (let i = 0; i < 25; i++) {
      store.append('session-1', {
        type: 'message.start',
        data: { messageId: `m${i}`, role: 'user', content: `${i}:${'x'.repeat(3000)}` },
      })
    }

    const row = db.prepare('SELECT recent_user_prompts FROM sessions WHERE id = ?').get('session-1') as {
      recent_user_prompts: string
    }
    const prompts = JSON.parse(row.recent_user_prompts) as Array<{ id: string; content: string }>
    expect(prompts).toHaveLength(20)
    expect(prompts[0]?.id).toBe('m24')
    expect(prompts[0]?.content).toBe(`24:${'x'.repeat(3000)}`)
  })
})
