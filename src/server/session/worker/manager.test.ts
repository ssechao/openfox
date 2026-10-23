import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Config } from '../../../shared/types.js'
import type { SessionManager } from '../manager.js'
import { SessionWorkerManager } from './manager.js'
import { assignWorkerToken } from './token.js'

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
  globalConfigPath: '/tmp/openfox-worker-manager-test.json',
} satisfies Config

const openDbs: Database.Database[] = []

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close()
})

describe('SessionWorkerManager', () => {
  it('starts a saturated turn later and sends its command over worker IPC', () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-worker-command-'))
    const { db, namedDb } = createDb(join(root, 'sessions.db'))
    openDbs.push(db)
    namedDb.prepare(`INSERT INTO sessions (id) VALUES ('sess-2')`).run()
    const send = vi.fn(() => true)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send,
      kill: () => true,
    }) as unknown as ChildProcess
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      maxProcesses: 1,
      processSupervisor: { spawnWorker: () => child } as never,
    })

    try {
      expect(manager.requestTurn('sess-1', () => {})).toBe('started')
      expect(manager.requestTurn('sess-2', () => manager.launch('sess-2', () => {}, { kind: 'compact' }))).toBe(
        'waiting',
      )
      expect(send).not.toHaveBeenCalled()

      expect(manager.releaseTurn('sess-1')).toBe(true)
      const active = manager.activeWorker('sess-2')
      expect(active).not.toBeNull()
      child.emit('message', { ...active!.token, type: 'ready', pid: 42 })

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start', sessionId: 'sess-2', command: { kind: 'compact' } }),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cancels a waiting session without assigning a worker generation', () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-waiting-stop.db')
    openDbs.push(db)
    namedDb.prepare(`INSERT INTO sessions (id) VALUES ('sess-2')`).run()
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      maxProcesses: 1,
    })
    const activeStart = vi.fn()
    const waitingStart = vi.fn()

    expect(manager.requestTurn('sess-1', activeStart)).toBe('started')
    expect(manager.requestTurn('sess-2', waitingStart)).toBe('waiting')
    expect(manager.requestStop('sess-2')).toBe(true)
    expect(waitingStart).not.toHaveBeenCalled()
    expect(manager.activeWorker('sess-2')).toBeNull()
    expect(namedDb.prepare(`SELECT worker_id, worker_generation FROM sessions WHERE id = 'sess-2'`).get()).toEqual({
      worker_id: null,
      worker_generation: 0,
    })
  })

  it('aborts immediately, escalates at 500 ms intervals, and settles an intentional stop', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-worker-manager-stop-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    const send = vi.fn(() => true)
    const kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
      }
      return true
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send,
      kill,
    }) as unknown as ChildProcess
    const settled = vi.fn()
    const cleanupChildren = vi.fn(async () => [99])
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      cleanupChildren,
      processSupervisor: { spawnWorker: () => child } as never,
      eventStore: () => ({ invalidateExternalSession: () => {} }) as never,
    })

    try {
      manager.launch('sess-1', settled)
      expect(manager.requestStop('sess-1')).toBe(true)
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'abort' }))
      expect(kill).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(499)
      expect(kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(kill).toHaveBeenCalledWith('SIGTERM')
      await vi.advanceTimersByTimeAsync(500)
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(999)

      expect(cleanupChildren).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith({ crashed: false })
      expect(manager.activeWorker('sess-1')).toBeNull()
      expect(namedDb.prepare(`SELECT interrupted_at FROM sessions WHERE id = 'sess-1'`).get()).toEqual({
        interrupted_at: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes admissions before parallel abort and escalates every worker at one and two seconds', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-shutdown.db')
    openDbs.push(db)
    namedDb.prepare(`INSERT INTO sessions (id) VALUES ('sess-2')`).run()
    const order: string[] = []
    const settled: Array<{ sessionId: string; outcome: { crashed: boolean; error?: string } }> = []
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      cleanupChildren: async (path) => {
        order.push(`cleanup:${path}`)
        return [99]
      },
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })
    const active = Reflect.get(manager, 'active') as Map<string, unknown>

    for (const [index, sessionId] of ['sess-1', 'sess-2'].entries()) {
      const token = assignWorkerToken(namedDb, sessionId)
      const child = Object.assign(new EventEmitter(), {
        pid: 42 + index,
        exitCode: null,
        signalCode: null,
        send: (message: { type?: string }) => {
          order.push(`send:${sessionId}:${message.type}`)
          return true
        },
        kill: (signal: NodeJS.Signals) => {
          order.push(`kill:${sessionId}:${signal}`)
          if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
          return true
        },
      }) as unknown as ChildProcess
      active.set(sessionId, {
        sessionId,
        token,
        child,
        childrenPath: `/tmp/${sessionId}.children`,
        doneReceived: false,
        doneOk: false,
        stderrTail: [],
        onSettled: (outcome: { crashed: boolean; error?: string }) => settled.push({ sessionId, outcome }),
      })
    }

    try {
      const shutdown = manager.shutdown()
      expect(manager.shouldUseWorker('sess-1')).toBe(false)
      expect(order).toEqual(['send:sess-1:abort', 'send:sess-2:abort'])
      expect(() => manager.launch('sess-1', () => {})).toThrow(/admissions.*closed|shutdown/i)

      await vi.advanceTimersByTimeAsync(999)
      expect(order.filter((entry) => entry.startsWith('kill:'))).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(order.filter((entry) => entry.includes('SIGTERM'))).toEqual(['kill:sess-1:SIGTERM', 'kill:sess-2:SIGTERM'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(order.filter((entry) => entry.includes('SIGKILL'))).toEqual(['kill:sess-1:SIGKILL', 'kill:sess-2:SIGKILL'])
      await shutdown

      expect(settled).toHaveLength(2)
      expect(settled.every(({ outcome }) => outcome.crashed && outcome.error?.includes('shutdown'))).toBe(true)
      expect(order.filter((entry) => entry.startsWith('cleanup:'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalizes crash interruption when child cleanup fails and preserves the sidecar', async () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-cleanup-error.db')
    openDbs.push(db)
    const dir = mkdtempSync(join(tmpdir(), 'openfox-worker-cleanup-error-'))
    const childrenPath = join(dir, 'worker.children')
    writeFileSync(childrenPath, 'pending cleanup', 'utf-8')
    const appended: string[] = []
    let cleanupCalls = 0
    let settled = false
    const token = assignWorkerToken(namedDb, 'sess-1')
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: {
        setRunning: () => {},
        getActiveWorkflowExecution: () => null,
        addMessage: () => ({ id: 'notice', role: 'user', content: 'interrupted' }),
      } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      cleanupChildren: async () => {
        cleanupCalls += 1
        throw new Error('reservation scan failed')
      },
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [
            { seq: 1, timestamp: 1, sessionId: 'sess-1', type: 'message.start', data: { role: 'user' } },
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
          append: (_sessionId: string, event: { type: string }) => {
            appended.push(event.type)
          },
        }) as never,
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: 'SIGKILL',
    }) as unknown as ChildProcess
    const worker = {
      sessionId: 'sess-1',
      token,
      child,
      childrenPath,
      doneReceived: false,
      doneOk: false,
      stderrTail: [],
      onSettled: () => {
        settled = true
      },
    }

    try {
      const settle = Reflect.get(manager, 'settle') as (
        candidate: typeof worker,
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => Promise<void>
      await settle.call(manager, worker, null, 'SIGKILL')

      const interrupted = namedDb.prepare(`SELECT interrupted_at FROM sessions WHERE id = 'sess-1'`).get() as {
        interrupted_at: string | null
      }
      expect(cleanupCalls).toBe(1)
      expect(interrupted.interrupted_at).toBeTruthy()
      expect(appended).toContain('tool.reconciliation_required')
      expect(manager.lastCrashReport()?.cleanupError).toMatch(/reservation scan failed/)
      expect(existsSync(childrenPath)).toBe(true)
      expect(settled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails before spawning when the child sidecar cannot be initialized', () => {
    const { db, namedDb } = createDb('/missing/openfox/sessions.db')
    openDbs.push(db)
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
    })

    expect(() => manager.launch('sess-1', () => {})).toThrow(/sidecar|ENOENT/i)
    expect(manager.activeWorker()).toBeNull()
    const row = namedDb.prepare(`SELECT worker_id FROM sessions WHERE id = 'sess-1'`).get() as {
      worker_id: string | null
    }
    expect(row.worker_id).toBeNull()
  })
})
