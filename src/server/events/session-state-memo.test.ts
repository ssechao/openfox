/**
 * Memoized session folding: getSessionState must not replay the event log again
 * while the session's events are unchanged, and must never serve a stale state
 * after any write path (append, delete, tombstone, another connection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initEventStore, getEventStore } from './store.js'
import {
  emitSessionInitialized,
  emitUserMessage,
  emitAssistantMessageStart,
  emitMessageDelta,
  emitMessageDone,
  emitToolCall,
  getSessionState,
  clearSessionStateMemo,
} from './session.js'

let db: Database.Database

function createSchema(target: Database.Database): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workdir TEXT NOT NULL
    )
  `)
}

beforeEach(() => {
  clearSessionStateMemo()
  db = new Database(':memory:')
  createSchema(db)
  initEventStore(db)
})

afterEach(() => {
  db.close()
})

function seedSession(sessionId: string): void {
  emitSessionInitialized(sessionId, 'proj-1', '/tmp/test', 'win-1')
  emitUserMessage(sessionId, 'Hello', { contextWindowId: 'win-1' })
  const msgId = emitAssistantMessageStart(sessionId, { contextWindowId: 'win-1' })
  emitMessageDelta(sessionId, msgId, 'Hi')
  emitMessageDone(sessionId, msgId)
}

describe('getSessionState memoization', () => {
  it('returns the same folded state while the session has no new events', () => {
    seedSession('s1')
    const first = getSessionState('s1')
    const second = getSessionState('s1')
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  it('refolds after an append to the session', () => {
    seedSession('s1')
    const before = getSessionState('s1')!
    emitUserMessage('s1', 'Again', { contextWindowId: 'win-1' })
    const after = getSessionState('s1')!
    expect(after).not.toBe(before)
    expect(after.messages.length).toBe(before.messages.length + 1)
  })

  it('is not invalidated by writes to another session', () => {
    seedSession('s1')
    seedSession('s2')
    const before = getSessionState('s1')
    emitUserMessage('s2', 'Other', { contextWindowId: 'win-1' })
    expect(getSessionState('s1')).toBe(before)
  })

  it('keeps distinct results per maxTokens/defaultMode', () => {
    seedSession('s1')
    const small = getSessionState('s1', 1000)
    const large = getSessionState('s1', 500000)
    expect(large).not.toBe(small)
    expect(getSessionState('s1', 1000)).toBe(small)
  })

  it('refolds when events are deleted and the same max seq is reached again', () => {
    seedSession('s1')
    const store = getEventStore()
    const maxSeq = store.getLatestSeq('s1')!
    const before = getSessionState('s1')!
    store.deleteEventsAfterSeq('s1', maxSeq - 2)
    for (const n of [1, 2]) {
      store.append('s1', {
        type: 'message.start',
        data: { messageId: `replaced-${n}`, role: 'user', content: `replaced-${n}`, contextWindowId: 'win-1' },
      })
    }
    expect(store.getLatestSeq('s1')).toBe(maxSeq)
    const after = getSessionState('s1')!
    expect(after).not.toBe(before)
    expect(after.messages.map((m) => m.content)).toContain('replaced-2')
  })

  it('refolds after events are tombstoned', () => {
    seedSession('s1')
    const store = getEventStore()
    const before = getSessionState('s1')!
    const userStart = store.getEvents('s1').find((e) => e.type === 'message.start')!
    store.tombstoneEvents('s1', [userStart.seq])
    expect(getSessionState('s1')).not.toBe(before)
  })

  it('refolds when another connection writes to the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-memo-'))
    const path = join(dir, 'sessions.db')
    try {
      db.close()
      db = new Database(path)
      db.pragma('journal_mode = WAL')
      createSchema(db)
      initEventStore(db)
      seedSession('s1')
      const before = getSessionState('s1')!

      const other = new Database(path)
      const maxSeq = (other.prepare(`SELECT MAX(seq) AS s FROM events WHERE session_id = 's1'`).get() as { s: number })
        .s
      other
        .prepare(
          `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES ('s1', ?, ?, 'message.start', ?)`,
        )
        .run(
          maxSeq + 1,
          Date.now(),
          JSON.stringify({
            messageId: 'external',
            role: 'user',
            content: 'from another connection',
            contextWindowId: 'win-1',
          }),
        )
      other.close()

      const after = getSessionState('s1')!
      expect(after).not.toBe(before)
      expect(after.messages.map((m) => m.content)).toContain('from another connection')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves a frozen shared state under test so mutations fail loudly', () => {
    seedSession('s1')
    const msgId = emitAssistantMessageStart('s1', { contextWindowId: 'win-1' })
    emitToolCall('s1', msgId, { id: 'call-1', name: 'read_file', arguments: { path: 'a' } })
    const state = getSessionState('s1')!
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.messages)).toBe(true)
    expect(() => (state.messages as unknown[]).push({})).toThrow(TypeError)
  })
})
