import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Config } from '../../../shared/types.js'
import type { StoredEvent } from '../../events/types.js'
import type { SessionManager } from '../manager.js'
import { SessionWorkerManager } from './manager.js'
import { sessionResumeAllowed } from './settle-unknown.js'
import type { OrphanInventoryCheck } from './children.js'

function createDb(name: string): { db: Database.Database; namedDb: Database.Database } {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      worker_generation INTEGER NOT NULL DEFAULT 0,
      is_running INTEGER NOT NULL DEFAULT 0,
      interrupted_at TEXT,
      updated_at TEXT
    );
    INSERT INTO sessions (id) VALUES ('sess-1');
  `)
  const namedDb = {
    name,
    prepare: db.prepare.bind(db),
    transaction: db.transaction.bind(db),
  } as unknown as Database.Database
  return { db, namedDb }
}

const config = {
  mode: 'test',
  llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 1000, idleTimeout: 1000 },
  context: { maxTokens: 1000, compactionThreshold: 0.85, compactionTarget: 0.6 },
  agent: { maxIterations: 1, maxConsecutiveFailures: 1, toolTimeout: 1000 },
  server: { port: 0, host: '127.0.0.1' },
  database: { path: ':memory:' },
  logging: { level: 'error' },
  workdir: process.cwd(),
  globalConfigPath: '/tmp/openfox-worker-recovery-proof-test.json',
} satisfies Config

const openDbs: Database.Database[] = []

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close()
})

function interruptedAtOf(namedDb: Database.Database): string | null {
  const row = namedDb.prepare(`SELECT interrupted_at FROM sessions WHERE id = 'sess-1'`).get() as {
    interrupted_at: string | null
  }
  return row.interrupted_at
}

function memoryStore(): { events: StoredEvent[]; eventStore: () => never } {
  const events: StoredEvent[] = []
  return {
    events,
    eventStore: () =>
      ({
        invalidateExternalSession: () => {},
        getEvents: () => events,
        append: (sessionId: string, event: { type: StoredEvent['type']; data: StoredEvent['data'] }) => {
          events.push({
            seq: events.length + 1,
            timestamp: Date.now(),
            sessionId,
            type: event.type,
            data: event.data,
          } as StoredEvent)
        },
      }) as never,
  }
}

function childProcess(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
    send: (message: { type?: string }) => {
      if (message.type === 'abort') queueMicrotask(() => child.emit('exit', 0, null))
      return true
    },
    kill: () => true,
  }) as unknown as ChildProcess
  return child
}

describe('shutdown recovery proof', () => {
  it('persists worker.recovery_clean only after shutdown cleanup succeeds', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-recovery-clean-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    const { events, eventStore } = memoryStore()
    const child = childProcess()
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
      cleanupChildren: async () => [],
      shutdownTimeoutMs: 1_500,
      eventStore,
    })

    try {
      manager.launch('sess-1', () => {})
      const shutdown = manager.shutdown()
      await vi.advanceTimersByTimeAsync(1_500)
      await shutdown
      const interruptedAt = interruptedAtOf(namedDb)
      expect(interruptedAt).toEqual(expect.any(String))
      expect(sessionResumeAllowed(events, interruptedAt!)).toBe(true)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'worker.recovery_clean',
          data: { interruptedAt },
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks boot resume when shutdown child cleanup fails after the interruption marker', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-recovery-blocked-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    const { events, eventStore } = memoryStore()
    const child = childProcess()
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
      cleanupChildren: () => new Promise<number[]>(() => {}),
      shutdownTimeoutMs: 100,
      eventStore,
    })

    try {
      manager.launch('sess-1', () => {})
      const shutdown = manager.shutdown()
      const rejected = expect(shutdown).rejects.toThrow(/cleanup exceeded shutdown deadline/i)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      const interruptedAt = interruptedAtOf(namedDb)
      expect(interruptedAt).toEqual(expect.any(String))
      expect(sessionResumeAllowed(events, interruptedAt!)).toBe(false)
      expect(
        events.some(
          (event) =>
            event.type === 'worker.recovery_clean' &&
            (event.data as { interruptedAt?: string }).interruptedAt === interruptedAt,
        ),
      ).toBe(false)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'worker.recovery_blocked',
          data: { interruptedAt, reason: 'orphan_proof' },
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

function crashChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
    send: () => true,
    kill: () => true,
  }) as unknown as ChildProcess
}

function failFirstInterruptedClear(namedDb: Database.Database): Database.Database {
  let remaining = 1
  const prepare = namedDb.prepare.bind(namedDb)
  return {
    name: (namedDb as unknown as { name: string }).name,
    prepare: (sql: string) => {
      const stmt = prepare(sql)
      if (!sql.includes('interrupted_at = NULL')) return stmt
      const run = stmt.run.bind(stmt)
      return Object.assign(stmt, {
        run: (...args: Parameters<typeof stmt.run>) => {
          if (remaining > 0) {
            remaining -= 1
            throw new Error('clear interrupted_at failed')
          }
          return run(...args)
        },
      })
    },
    transaction: namedDb.transaction.bind(namedDb),
  } as unknown as Database.Database
}

async function retireThenStop(options: {
  workflow: boolean
  failCleanProofOnce?: boolean
  failClearOnce?: boolean
}): Promise<{
  queueMessage: ReturnType<typeof vi.fn>
  resumeInterruptedSession: ReturnType<typeof vi.fn>
  interruptedAt: string | null
  events: StoredEvent[]
}> {
  const { db, namedDb: realDb } = createDb(join(tmpdir(), `openfox-late-stop-${crypto.randomUUID()}.db`))
  openDbs.push(db)
  const namedDb = options.failClearOnce ? failFirstInterruptedClear(realDb) : realDb
  const events: StoredEvent[] = []
  let cleanProofAttempts = 0
  let resolveProof: (proof: OrphanInventoryCheck) => void = () => {}
  const proof = new Promise<OrphanInventoryCheck>((resolve) => {
    resolveProof = resolve
  })
  const queueMessage = vi.fn()
  const resumeInterruptedSession = vi.fn()
  const child = crashChild()
  const manager = new SessionWorkerManager({
    db: () => namedDb,
    config,
    sessionManager: {
      setRunning: () => {},
      getActiveWorkflowExecution: () => (options.workflow ? { id: 'exec-1', status: 'running' } : null),
      queueMessage,
      addMessage: () => ({ id: 'notice', role: 'user', content: 'interrupted' }),
    } as unknown as SessionManager,
    resumeInterruptedSession,
    isEnabled: () => true,
    broadcastForSession: () => {},
    processSupervisor: { spawnWorker: () => child } as never,
    captureInventory: (pid) => ({
      capturedAt: Date.now(),
      worker: { pid, startedAt: 'linux:42', pgid: 42 },
      children: [],
      groups: [],
      reservations: [],
      errors: [],
    }),
    cleanupChildren: async () => [],
    verifyInventory: () => proof,
    eventStore: () =>
      ({
        invalidateExternalSession: () => {},
        getEvents: () => [
          {
            seq: 1,
            timestamp: 1,
            sessionId: 'sess-1',
            type: 'message.start',
            data: { role: 'user', messageId: 'user-1' },
          },
          {
            seq: 2,
            timestamp: 2,
            sessionId: 'sess-1',
            type: 'tool.call',
            data: {
              messageId: 'assistant-1',
              toolCall: { id: 'call-1', name: 'run_command', arguments: { command: 'effect' } },
            },
          },
        ],
        append: (sessionId: string, event: { type: string; data?: unknown }) => {
          if (options.failCleanProofOnce && event.type === 'worker.recovery_clean' && cleanProofAttempts++ === 0) {
            throw new Error('proof persist failed')
          }
          events.push({
            seq: events.length + 1,
            timestamp: Date.now(),
            sessionId,
            type: event.type,
            data: event.data,
          } as StoredEvent)
        },
      }) as never,
  })

  manager.launch('sess-1', () => {})
  child.emit('exit', null, 'SIGKILL')
  await vi.waitFor(() => {
    expect(manager.lastCrashReport()).not.toBeNull()
    expect(events.some((event) => event.type === 'running.changed')).toBe(true)
    expect(manager.activeWorker('sess-1')).toBeNull()
  })
  manager.requestStop('sess-1')
  const capturedAt = manager.lastCrashReport()!.inventory.capturedAt
  resolveProof({
    checkedAt: capturedAt + 2_000,
    clean: true,
    survivingIdentities: [],
    survivingGroups: [],
    liveReservations: [],
    errors: [],
  })
  const waitMs = options.failClearOnce ? 800 : options.failCleanProofOnce ? 500 : 30
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return { queueMessage, resumeInterruptedSession, interruptedAt: interruptedAtOf(namedDb), events }
}

describe('deferred clean proof after Stop', () => {
  it('does not auto-prompt or relaunch a tool when Stop arrives after retire', async () => {
    const result = await retireThenStop({ workflow: false })
    expect(result.queueMessage).not.toHaveBeenCalled()
    expect(result.resumeInterruptedSession).not.toHaveBeenCalled()
    expect(result.events.filter((event) => event.type === 'tool.call')).toEqual([])
    expect(result.interruptedAt).toBeNull()
  })

  it('does not resume a workflow when Stop arrives after retire', async () => {
    const result = await retireThenStop({ workflow: true })
    expect(result.resumeInterruptedSession).not.toHaveBeenCalled()
    expect(result.queueMessage).not.toHaveBeenCalled()
    expect(result.interruptedAt).toBeNull()
  })

  it('cancels continuation when the clean proof persist is retried after Stop', async () => {
    const result = await retireThenStop({ workflow: false, failCleanProofOnce: true })
    expect(result.events.some((event) => event.type === 'worker.recovery_clean')).toBe(true)
    expect(result.queueMessage).not.toHaveBeenCalled()
    expect(result.resumeInterruptedSession).not.toHaveBeenCalled()
    expect(result.interruptedAt).toBeNull()
  })

  it.fails('keeps a late Stop stopped when clearing the marker fails and the callback is replayed', async () => {
    const result = await retireThenStop({ workflow: false, failClearOnce: true })
    expect(result.queueMessage).not.toHaveBeenCalled()
    expect(result.resumeInterruptedSession).not.toHaveBeenCalled()
    expect(result.events.filter((event) => event.type === 'tool.call')).toEqual([])
    expect(result.interruptedAt).toBeNull()
  })
})
