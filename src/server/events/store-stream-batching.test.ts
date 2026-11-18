import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventStore } from './store.js'
import { foldTurnEventsToSnapshotMessages } from './folding.js'
import type { StoredEvent, TurnEvent } from './types.js'

const SID = 'session-1'

function thinking(messageId: string, content: string): TurnEvent {
  return { type: 'message.thinking', data: { messageId, content } }
}

function delta(messageId: string, content: string): TurnEvent {
  return { type: 'message.delta', data: { messageId, content } }
}

function preparing(messageId: string, index: number, name: string, args?: string): TurnEvent {
  return {
    type: 'tool.preparing',
    data: { messageId, index, name, ...(args !== undefined ? { arguments: args } : {}) },
  }
}

function makeFragments(count: number): string[] {
  const alphabet = ['é', '🦊', 'ß', ' ', '\n', 'a', '"', '\\']
  return Array.from({ length: count }, (_, i) => `f${i}${alphabet[i % alphabet.length]}`)
}

function collectLive(store: EventStore): { events: StoredEvent[]; drain: () => Promise<void>; stop: () => void } {
  const events: StoredEvent[] = []
  const { iterator, unsubscribe } = store.subscribeAll()
  void (async () => {
    for await (const event of iterator) events.push(event)
  })()
  return {
    events,
    drain: () => new Promise((resolve) => setImmediate(resolve)),
    stop: unsubscribe,
  }
}

function rawRows(db: Database.Database, type?: string): Array<{ seq: number; event_type: string; payload: string }> {
  return (
    type
      ? db.prepare('SELECT seq, event_type, payload FROM events WHERE event_type = ? ORDER BY seq').all(type)
      : db.prepare('SELECT seq, event_type, payload FROM events ORDER BY seq').all()
  ) as Array<{ seq: number; event_type: string; payload: string }>
}

function contentOf(rows: Array<{ payload: string }>): string {
  return rows.map((row) => (JSON.parse(row.payload) as { content: string }).content).join('')
}

describe('EventStore stream batching', () => {
  let db: Database.Database
  let store: EventStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new EventStore(db)
    store.append(SID, { type: 'message.start', data: { messageId: 'a1', role: 'assistant' } })
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('persists 10 000 thinking fragments as fewer than 200 events while every fragment is published live', async () => {
    const live = collectLive(store)
    const fragments = makeFragments(10_000)

    for (const fragment of fragments) store.appendStreaming(SID, thinking('a1', fragment))
    store.append(SID, { type: 'message.done', data: { messageId: 'a1' } })
    await live.drain()
    live.stop()

    const persisted = rawRows(db, 'message.thinking')
    expect(persisted.length).toBeLessThan(200)
    expect(contentOf(persisted)).toBe(fragments.join(''))

    const liveThinking = live.events.filter((event) => event.type === 'message.thinking')
    expect(liveThinking).toHaveLength(fragments.length)
    expect(liveThinking.map((event) => (event.data as { content: string }).content)).toEqual(fragments)

    const [message] = foldTurnEventsToSnapshotMessages(store.getEvents(SID))
    expect(message?.thinkingContent).toBe(fragments.join(''))
  })

  it('flushes a partial batch 250 ms after its first fragment', () => {
    vi.useFakeTimers()
    store.appendStreaming(SID, thinking('a1', 'one '))
    store.appendStreaming(SID, thinking('a1', 'two '))

    vi.advanceTimersByTime(249)
    expect(rawRows(db, 'message.thinking')).toHaveLength(0)

    vi.advanceTimersByTime(1)
    const rows = rawRows(db, 'message.thinking')
    expect(rows).toHaveLength(1)
    expect(contentOf(rows)).toBe('one two ')
  })

  it('flushes as soon as 4 KB are pending', () => {
    vi.useFakeTimers()
    const kilobyte = 'x'.repeat(1024)
    for (let i = 0; i < 3; i++) store.appendStreaming(SID, thinking('a1', kilobyte))
    expect(rawRows(db, 'message.thinking')).toHaveLength(0)

    store.appendStreaming(SID, thinking('a1', kilobyte))
    expect(rawRows(db, 'message.thinking')).toHaveLength(1)

    store.appendStreaming(SID, thinking('a1', 'tail'))
    expect(rawRows(db, 'message.thinking')).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(contentOf(rawRows(db, 'message.thinking'))).toBe(kilobyte.repeat(4) + 'tail')
  })

  it('persists pending fragments before any other event of the session, keeping their order', () => {
    store.appendStreaming(SID, thinking('a1', 'think '))
    store.appendStreaming(SID, thinking('a1', 'more'))
    store.appendStreaming(SID, delta('a1', 'answer '))
    store.appendStreaming(SID, delta('a1', 'text'))
    store.append(SID, { type: 'message.done', data: { messageId: 'a1' } })

    const rows = rawRows(db)
    expect(rows.map((row) => row.event_type)).toEqual([
      'message.start',
      'message.thinking',
      'message.delta',
      'message.done',
    ])
    expect(contentOf(rows.slice(1, 2))).toBe('think more')
    expect(contentOf(rows.slice(2, 3))).toBe('answer text')
  })

  it('never merges fragments of different messages or sessions, and keeps each stream in order', () => {
    store.append('other', { type: 'message.start', data: { messageId: 'b1', role: 'assistant' } })
    store.append(SID, { type: 'message.start', data: { messageId: 'a2', role: 'assistant' } })
    store.appendStreaming(SID, delta('a1', 'A'))
    store.appendStreaming('other', delta('b1', 'B'))
    store.appendStreaming(SID, delta('a2', 'C'))
    store.appendStreaming(SID, delta('a1', 'D'))
    store.appendStreaming(SID, thinking('a1', 'T'))
    store.flushStreaming(SID)
    store.flushStreaming('other')

    const persisted = store
      .getEvents(SID)
      .filter((event) => event.type !== 'message.start')
      .map((event) => [
        event.type,
        (event.data as { messageId: string }).messageId,
        (event.data as { content: string }).content,
      ])
    expect(persisted).toEqual([
      ['message.delta', 'a1', 'AD'],
      ['message.delta', 'a2', 'C'],
      ['message.thinking', 'a1', 'T'],
    ])
    expect(store.getEvents('other').map((event) => (event.data as { content?: string }).content)).toEqual([
      undefined,
      'B',
    ])
    const messages = foldTurnEventsToSnapshotMessages(store.getEvents(SID))
    expect(messages.map((message) => [message.id, message.content, message.thinkingContent])).toEqual([
      ['a1', 'AD', 'T'],
      ['a2', 'C', undefined],
    ])
  })

  it('keeps only the latest cumulative arguments of a streaming tool call and folds to the same state', () => {
    const reference = new EventStore(new Database(':memory:'))
    reference.append(SID, { type: 'message.start', data: { messageId: 'a1', role: 'assistant' } })
    const args = '{"path":"src/a.ts","content":"' + 'line\\n'.repeat(50) + '"}'
    const stream: TurnEvent[] = [preparing('a1', 0, 'write_file')]
    for (let end = 5; end <= args.length; end += 7) stream.push(preparing('a1', 0, 'write_file', args.slice(0, end)))
    stream.push(preparing('a1', 0, 'write_file', args))
    stream.push(preparing('a1', 1, 'run_command', '{"command":"ls"}'))

    for (const event of stream) {
      store.appendStreaming(SID, event)
      reference.append(SID, event)
    }
    store.flushStreaming(SID)

    const persistedPreparing = rawRows(db, 'tool.preparing')
    expect(persistedPreparing.length).toBeLessThan(stream.length)
    expect(foldTurnEventsToSnapshotMessages(store.getEvents(SID))).toEqual(
      foldTurnEventsToSnapshotMessages(reference.getEvents(SID)).map((message) => ({
        ...message,
        timestamp: expect.any(Number),
      })),
    )
  })

  it('serves pending fragments to readers', () => {
    store.appendStreaming(SID, thinking('a1', 'visible '))
    store.appendStreaming(SID, thinking('a1', 'now'))

    const events = store.getEvents(SID)
    expect(events.map((event) => event.type)).toEqual(['message.start', 'message.thinking'])
    expect((events[1]!.data as { content: string }).content).toBe('visible now')
  })

  it('moves the session revision only when fragments are persisted', () => {
    const before = store.getSessionRevision(SID)
    store.appendStreaming(SID, thinking('a1', 'x'))
    const afterRead = store.getSessionRevision(SID)
    expect(afterRead).not.toBe(before)
    expect(store.getSessionRevision(SID)).toBe(afterRead)
  })

  it('drops pending fragments of a deleted session', () => {
    vi.useFakeTimers()
    store.appendStreaming(SID, thinking('a1', 'gone'))
    store.deleteSession(SID)
    vi.advanceTimersByTime(1000)
    expect(rawRows(db)).toHaveLength(0)
  })
})

describe('EventStore stream batching against the application schema', () => {
  let db: Database.Database
  let store: EventStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `)
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run(SID)
    store = new EventStore(db)
    store.append(SID, { type: 'message.start', data: { messageId: 'a1', role: 'assistant' } })
  })

  afterEach(() => {
    db.close()
  })

  it('publishes no fragment of a session deleted mid-stream, like a regular append', async () => {
    const live = collectLive(store)
    store.appendStreaming(SID, delta('a1', 'before '))
    store.deleteSession(SID)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(SID)

    store.appendStreaming(SID, delta('a1', 'after'))
    store.flushStreaming(SID)
    await live.drain()
    live.stop()

    expect(live.events.map((event) => (event.data as { content: string }).content)).toEqual(['before '])
    expect(rawRows(db)).toHaveLength(0)
  })
})

describe('EventStore stream batching while another connection holds the write lock', () => {
  let directory: string
  let db: Database.Database
  let holder: Database.Database
  let store: EventStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'openfox-stream-busy-'))
    db = new Database(join(directory, 'sessions.db'), { timeout: 20 })
    db.pragma('journal_mode = WAL')
    store = new EventStore(db)
    store.append(SID, { type: 'message.start', data: { messageId: 'a1', role: 'assistant' } })
    holder = new Database(join(directory, 'sessions.db'))
  })

  afterEach(() => {
    if (holder.inTransaction) holder.exec('ROLLBACK')
    holder.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps the fragments of a failed flush and persists them once the lock is released', () => {
    holder.exec('BEGIN IMMEDIATE')
    store.appendStreaming(SID, thinking('a1', 'x'.repeat(4096)))
    expect(() => store.appendStreaming(SID, thinking('a1', 'kept '))).not.toThrow()
    expect(() => store.flushStreaming(SID)).toThrow(/locked|busy/i)

    holder.exec('ROLLBACK')
    store.appendStreaming(SID, thinking('a1', 'safe'))
    store.flushStreaming(SID)

    const [message] = foldTurnEventsToSnapshotMessages(store.getEvents(SID))
    expect(message?.thinkingContent).toBe('x'.repeat(4096) + 'kept safe')
  })
})
