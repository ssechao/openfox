/**
 * Étape 6a, critère 1 — worker isolé avec fencing worker+génération.
 *
 * Mac-safe: no kill -9, no server boot. Covers the fencing primitives that
 * prevent double execution after PID reuse, and the no-blind-replay recovery
 * decision. Process crash detection and cleanup proofs live in
 * worker-crash.integration.test.ts / worker-cleanup.test.ts (.122 only).
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assignWorkerToken,
  clearWorkerToken,
  createWorkerFence,
  isWorkerMessageCurrent,
  isWorkerTokenCurrent,
  StaleWorkerGenerationError,
  planWorkerCrashRecovery,
  readTrackedChildren,
  initChildrenTracking,
  trackExclusiveChild,
  killTrackedChildren,
} from './worker/index.js'
import { attachWorkerEventStore, getEventStore } from '../events/store.js'
import { CONTINUE_AFTER_STREAM_ERROR_PROMPT } from './auto-continue.js'
import type { StoredEvent } from '../events/types.js'

function createSessionsDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      is_running INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      worker_generation INTEGER NOT NULL DEFAULT 0,
      interrupted_at TEXT,
      updated_at TEXT
    )
  `)
  db.prepare(`INSERT INTO sessions (id, updated_at) VALUES ('sess-1', '2026-10-23T00:00:00Z')`).run()
  return db
}

function storedEvent(seq: number, type: string, data: Record<string, unknown>): StoredEvent {
  return { seq, timestamp: Date.now(), sessionId: 'sess-1', type, data } as StoredEvent
}

const openDbs: Database.Database[] = []
function trackedDb(): Database.Database {
  const db = createSessionsDb()
  openDbs.push(db)
  return db
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close()
})

describe('worker token fencing', () => {
  it('assigns a fresh (workerId, generation) pair and never reuses a generation', () => {
    const db = trackedDb()
    const first = assignWorkerToken(db, 'sess-1')
    expect(first.generation).toBe(1)
    expect(first.workerId).toBeTruthy()

    const second = assignWorkerToken(db, 'sess-1')
    expect(second.generation).toBe(2)
    expect(second.workerId).not.toBe(first.workerId)

    expect(isWorkerTokenCurrent(db, 'sess-1', second)).toBe(true)
    expect(isWorkerTokenCurrent(db, 'sess-1', first)).toBe(false)
  })

  it('refuses to assign a token to an unknown session', () => {
    const db = trackedDb()
    expect(() => assignWorkerToken(db, 'nope')).toThrow(/unknown session/)
  })

  it('clears a token only for the exact (workerId, generation) pair', () => {
    const db = trackedDb()
    const first = assignWorkerToken(db, 'sess-1')
    const second = assignWorkerToken(db, 'sess-1')

    // Late cleanup of generation 1 must not clear generation 2's token.
    clearWorkerToken(db, 'sess-1', first)
    expect(isWorkerTokenCurrent(db, 'sess-1', second)).toBe(true)

    clearWorkerToken(db, 'sess-1', second)
    expect(isWorkerTokenCurrent(db, 'sess-1', second)).toBe(false)
    // Generation is monotonic even after a clear (PID-reuse-safe fencing).
    expect(assignWorkerToken(db, 'sess-1').generation).toBe(3)
  })

  it('honors only IPC messages of the live pair — never a PID', () => {
    const token = { workerId: 'w1', generation: 7 }
    expect(isWorkerMessageCurrent(token, { workerId: 'w1', generation: 7, type: 'ws' })).toBe(true)
    expect(isWorkerMessageCurrent(token, { workerId: 'w1', generation: 6, type: 'ws' })).toBe(false)
    expect(isWorkerMessageCurrent(token, { workerId: 'w2', generation: 7, type: 'ws' })).toBe(false)
    expect(isWorkerMessageCurrent(null, { workerId: 'w1', generation: 7 })).toBe(false)
  })
})

describe('fenced worker EventStore', () => {
  it('rejects writes from a stale generation and never double-executes them', () => {
    const db = trackedDb()
    const token = assignWorkerToken(db, 'sess-1')
    const store = attachWorkerEventStore(db, token)

    store.append('sess-1', { type: 'message.start', data: { messageId: 'm1', role: 'assistant' } })
    expect(getEventStore().getEvents('sess-1')).toHaveLength(1)

    // The token moves on (gateway relaunched a worker after a crash).
    assignWorkerToken(db, 'sess-1')

    expect(() => store.append('sess-1', { type: 'message.done', data: { messageId: 'm1' } })).toThrow(
      StaleWorkerGenerationError,
    )
    expect(store.getEvents('sess-1')).toHaveLength(1)
  })

  it('fences appendBatch atomically as well', () => {
    const db = trackedDb()
    const token = assignWorkerToken(db, 'sess-1')
    assignWorkerToken(db, 'sess-1') // token is now stale
    const store = attachWorkerEventStore(db, token)

    expect(() =>
      store.appendBatch('sess-1', [
        { type: 'message.start', data: { messageId: 'm1', role: 'assistant' } },
        { type: 'message.done', data: { messageId: 'm1' } },
      ]),
    ).toThrow(StaleWorkerGenerationError)
    expect(store.getEvents('sess-1')).toHaveLength(0)
  })

  it('exposes a raw fence that matches the store behavior', () => {
    const db = trackedDb()
    const token = assignWorkerToken(db, 'sess-1')
    const fence = createWorkerFence(db, token)
    expect(() => fence('sess-1')).not.toThrow()
    assignWorkerToken(db, 'sess-1')
    expect(() => fence('sess-1')).toThrow(/no longer the owner/)
  })
})

describe('crash recovery planning (no blind replay)', () => {
  it('finalizes a partial assistant message and continues with the stream-interrupted reminder', () => {
    const events = [
      storedEvent(1, 'message.start', { messageId: 'u1', role: 'user' }),
      storedEvent(2, 'message.start', { messageId: 'a1', role: 'assistant' }),
    ]
    const plan = planWorkerCrashRecovery(events, false)
    expect(plan?.finalizeMessageId).toBe('a1')
    expect(plan?.content).toBe(CONTINUE_AFTER_STREAM_ERROR_PROMPT)
    // The continuation is a reminder, never a replay of a tool call.
    expect(plan?.content).not.toMatch(/run_command|tool_call/i)
  })

  it('does not finalize an already-completed turn', () => {
    const events = [
      storedEvent(1, 'message.start', { messageId: 'a1', role: 'assistant' }),
      storedEvent(2, 'message.done', { messageId: 'a1' }),
    ]
    const plan = planWorkerCrashRecovery(events, false)
    expect(plan?.finalizeMessageId).toBeUndefined()
    expect(plan?.content).toBeTruthy()
  })

  it('refuses any continuation while a workflow is active', () => {
    const events = [storedEvent(1, 'message.start', { messageId: 'a1', role: 'assistant' })]
    expect(planWorkerCrashRecovery(events, true)).toBeNull()
  })
})

describe('exclusive children tracking', () => {
  afterEach(() => {
    delete process.env['OPENFOX_WORKER_CHILDREN']
  })

  it('records children synchronously, dedups pids, and tolerates a truncated tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-'))
    const file = join(dir, 'w.children')
    try {
      initChildrenTracking(file)
      process.env['OPENFOX_WORKER_CHILDREN'] = file
      trackExclusiveChild(1234, 'sleep 300')
      trackExclusiveChild(1234, 'sleep 300') // duplicate ignored
      trackExclusiveChild(1235)
      delete process.env['OPENFOX_WORKER_CHILDREN']
      // Simulate a worker killed mid-append: truncated trailing line.
      appendFileSync(file, '{"pid": 99')

      const children = readTrackedChildren(file)
      expect(children).toEqual([{ pid: 1234, command: 'sleep 300' }, { pid: 1235 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op outside a worker process', () => {
    delete process.env['OPENFOX_WORKER_CHILDREN']
    expect(() => trackExclusiveChild(4321, 'sleep 1')).not.toThrow()
  })

  it('kills a recorded detached process group and removes the sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-'))
    const file = join(dir, 'w.children')
    initChildrenTracking(file)
    process.env['OPENFOX_WORKER_CHILDREN'] = file
    try {
      const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
      trackExclusiveChild(child.pid, 'sleep 60')
      child.unref()
      expect(child.pid).toBeGreaterThan(0)

      const killed = await killTrackedChildren(file)
      expect(killed).toEqual([child.pid])

      const deadline = Date.now() + 3000
      let alive = true
      while (Date.now() < deadline) {
        try {
          process.kill(child.pid!, 0)
        } catch {
          alive = false
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(alive).toBe(false)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
