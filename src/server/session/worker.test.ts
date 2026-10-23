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
import { appendFileSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  findPendingToolReconciliations,
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
  it('requires reconciliation only for unresolved calls in the current turn', () => {
    const events = [
      { ...storedEvent(1, 'message.start', { messageId: 'u1', role: 'user' }), timestamp: 1 },
      {
        ...storedEvent(2, 'tool.call', {
          messageId: 'a1',
          toolCall: { id: 'old-call', name: 'run_command', arguments: { command: 'old' } },
        }),
        timestamp: 2,
      },
      { ...storedEvent(3, 'message.start', { messageId: 'u2', role: 'user' }), timestamp: 3 },
      {
        ...storedEvent(4, 'tool.call', {
          messageId: 'a2',
          toolCall: { id: 'current-call', name: 'run_command', arguments: { command: 'current' } },
        }),
        timestamp: 4,
      },
    ]

    expect(findPendingToolReconciliations(events)).toEqual([
      {
        messageId: 'a2',
        toolCallId: 'current-call',
        name: 'run_command',
        arguments: { command: 'current' },
      },
    ])
  })

  it('excludes current-turn calls that already have results', () => {
    const events = [
      { ...storedEvent(1, 'message.start', { messageId: 'u1', role: 'user' }), timestamp: 1 },
      {
        ...storedEvent(2, 'tool.call', {
          messageId: 'a1',
          toolCall: { id: 'call-1', name: 'run_command', arguments: {} },
        }),
        timestamp: 2,
      },
      { ...storedEvent(3, 'tool.result', { messageId: 'a1', toolCallId: 'call-1', result: {} }), timestamp: 3 },
    ]

    expect(findPendingToolReconciliations(events)).toEqual([])
  })

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
      trackExclusiveChild(process.pid, 'current process')
      trackExclusiveChild(process.pid, 'current process') // duplicate ignored
      delete process.env['OPENFOX_WORKER_CHILDREN']
      // Simulate a worker killed mid-append: truncated trailing line.
      appendFileSync(file, '{"pid": 99')

      const children = readTrackedChildren(file)
      expect(children).toEqual([{ pid: process.pid, startedAt: expect.any(String), command: 'current process' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps reused pids with different start identities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-reused-'))
    const file = join(dir, 'w.children')
    try {
      writeFileSync(
        file,
        `${JSON.stringify({ pid: 4321, startedAt: 'linux:1' })}\n${JSON.stringify({ pid: 4321, startedAt: 'linux:2' })}\n`,
      )
      expect(readTrackedChildren(file)).toEqual([
        { pid: 4321, startedAt: 'linux:1' },
        { pid: 4321, startedAt: 'linux:2' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails explicitly when a tracking append is impossible', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-unwritable-'))
    process.env['OPENFOX_WORKER_CHILDREN'] = dir
    try {
      expect(() => trackExclusiveChild(process.pid, 'sleep 1')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op outside a worker process', () => {
    delete process.env['OPENFOX_WORKER_CHILDREN']
    expect(() => trackExclusiveChild(4321, 'sleep 1')).not.toThrow()
  })

  it.skipIf(process.platform !== 'darwin')(
    'recovers finalized and unfinalized children on Darwin',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'openfox-children-darwin-'))
      const file = join(dir, 'w.children')
      initChildrenTracking(file)
      process.env['OPENFOX_WORKER_CHILDREN'] = file
      const finalized = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      })
      finalized.unref()
      const reservationId = `darwin-${process.pid}-${Date.now()}`
      const unfinalized = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, OPENFOX_CHILD_RESERVATION_ID: reservationId },
      })
      unfinalized.unref()
      try {
        await Promise.all(
          [finalized, unfinalized].map(
            (child) =>
              new Promise<void>((resolve, reject) => {
                child.once('spawn', resolve)
                child.once('error', reject)
              }),
          ),
        )
        trackExclusiveChild(finalized.pid, 'darwin-finalized')
        appendFileSync(file, `${JSON.stringify({ type: 'reservation', id: reservationId })}\n`, 'utf-8')

        const killed = await killTrackedChildren(file)
        expect(killed).toContain(finalized.pid)
        expect(killed).toContain(unfinalized.pid)
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          const alive = [finalized.pid, unfinalized.pid].some((pid) => {
            try {
              process.kill(pid!, 0)
              return true
            } catch {
              return false
            }
          })
          if (!alive) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(() => process.kill(finalized.pid!, 0)).toThrow()
        expect(() => process.kill(unfinalized.pid!, 0)).toThrow()
      } finally {
        for (const child of [finalized, unfinalized]) {
          if (!child.pid) continue
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            void error
          }
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
    10_000,
  )

  it.skipIf(process.platform !== 'darwin')(
    'reaps every marked sibling after the reservation process-group leader exits on Darwin',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'openfox-children-darwin-orphan-group-'))
      const file = join(dir, 'w.children')
      const firstPidFile = join(dir, 'first.pid')
      const secondPidFile = join(dir, 'second.pid')
      const reservationId = `darwin-orphans-${process.pid}-${Date.now()}`
      writeFileSync(file, `${JSON.stringify({ type: 'reservation', id: reservationId })}\n`, 'utf-8')
      const childScript = 'setInterval(() => {}, 1000)'
      const leader = spawn(
        'sh',
        [
          '-c',
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & echo $! > "$FIRST_PID"; ${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & echo $! > "$SECOND_PID"`,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            OPENFOX_CHILD_RESERVATION_ID: reservationId,
            FIRST_PID: firstPidFile,
            SECOND_PID: secondPidFile,
          },
        },
      )
      leader.unref()
      let firstPid = 0
      let secondPid = 0
      try {
        await new Promise<void>((resolve) => leader.once('exit', () => resolve()))
        const deadline = Date.now() + 3000
        while (Date.now() < deadline && (!existsSync(firstPidFile) || !existsSync(secondPidFile))) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        firstPid = Number(readFileSync(firstPidFile, 'utf-8').trim())
        secondPid = Number(readFileSync(secondPidFile, 'utf-8').trim())
        expect(firstPid).toBeGreaterThan(0)
        expect(secondPid).toBeGreaterThan(0)
        expect(() => process.kill(leader.pid!, 0)).toThrow()
        expect(() => process.kill(firstPid, 0)).not.toThrow()
        expect(() => process.kill(secondPid, 0)).not.toThrow()

        const attempted = await killTrackedChildren(file, { killTree: async () => {} })
        expect(attempted).toEqual(expect.arrayContaining([firstPid, secondPid]))
        expect(() => process.kill(firstPid, 0)).not.toThrow()
        expect(() => process.kill(secondPid, 0)).not.toThrow()
        expect(existsSync(file)).toBe(true)

        const killed = await killTrackedChildren(file)
        expect(killed).toEqual(expect.arrayContaining([firstPid, secondPid]))
        const cleanupDeadline = Date.now() + 3000
        while (Date.now() < cleanupDeadline) {
          const alive = [firstPid, secondPid].some((pid) => {
            try {
              process.kill(pid, 0)
              return true
            } catch {
              return false
            }
          })
          if (!alive) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(() => process.kill(firstPid, 0)).toThrow()
        expect(() => process.kill(secondPid, 0)).toThrow()
        expect(existsSync(file)).toBe(false)
      } finally {
        if (leader.pid) {
          try {
            process.kill(-leader.pid, 'SIGKILL')
          } catch (error) {
            void error
          }
        }
        for (const pid of [firstPid, secondPid]) {
          if (!pid) continue
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            void error
          }
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
    10_000,
  )

  it('does not kill a foreign process that reused a tracked pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-'))
    const file = join(dir, 'w.children')
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    child.unref()
    try {
      expect(child.pid).toBeGreaterThan(0)
      writeFileSync(file, `${JSON.stringify({ pid: child.pid, startedAt: 'foreign-process' })}\n`, 'utf-8')

      const killed = await killTrackedChildren(file)
      expect(killed).toEqual([])
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
    } finally {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills a recorded process group when the process root is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-absent-root-'))
    const file = join(dir, 'w.children')
    const pid = 987_654
    writeFileSync(file, `${JSON.stringify({ pid, startedAt: 'linux:1' })}\n`, 'utf-8')
    let groupSignals = 0
    try {
      expect(
        await killTrackedChildren(file, {
          readProcessIdentity: () => ({ status: 'absent' }),
          signalGroup: async () => {
            groupSignals += 1
            return true
          },
        }),
      ).toEqual([pid])
      expect(groupSignals).toBe(1)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('retries an unreadable process identity without blindly killing its group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-unreadable-identity-'))
    const file = join(dir, 'w.children')
    const pid = 987_654
    writeFileSync(file, `${JSON.stringify({ pid, startedAt: 'linux:1' })}\n`, 'utf-8')
    let identityReads = 0
    let groupSignals = 0
    try {
      expect(
        await killTrackedChildren(file, {
          readProcessIdentity: () => {
            identityReads += 1
            return { status: 'unreadable', error: new Error('permission denied') }
          },
          signalGroup: async () => {
            groupSignals += 1
            return true
          },
          retryDelay: async () => {},
        }),
      ).toEqual([])
      expect(identityReads).toBe(2)
      expect(groupSignals).toBe(0)
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills a recorded process group after its root exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfox-children-orphan-group-'))
    const file = join(dir, 'w.children')
    initChildrenTracking(file)
    process.env['OPENFOX_WORKER_CHILDREN'] = file
    const root = spawn('sh', ['-c', 'sleep 60 &'], { detached: true, stdio: 'ignore' })
    try {
      trackExclusiveChild(root.pid, 'sleep 60 &')
      const pid = root.pid!
      await new Promise<void>((resolve) => root.once('exit', () => resolve()))
      expect(() => process.kill(pid, 0)).toThrow()
      expect(() => process.kill(-pid, 0)).not.toThrow()

      expect(await killTrackedChildren(file)).toEqual([pid])
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        try {
          process.kill(-pid, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
      expect(() => process.kill(-pid, 0)).toThrow()
    } finally {
      if (root.pid) {
        try {
          process.kill(-root.pid, 'SIGKILL')
        } catch (error) {
          void error
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

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
