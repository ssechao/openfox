import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Config } from '../../../shared/types.js'
import type { SessionManager } from '../manager.js'
import { SessionRuntimeRegistry } from '../runtime.js'
import { SessionWorkerManager } from './manager.js'
import { assignWorkerToken } from './token.js'
import { logger } from '../../utils/logger.js'

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
  it('worker log lines are relayed to the gateway log with session and worker ids', () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-log-relay.db')
    openDbs.push(db)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
    })

    try {
      manager.launch('sess-1', () => {})
      const token = manager.activeWorker('sess-1')!.token
      child.stdout!.emit('data', Buffer.from('first line\nsecond line\n'))
      child.stderr!.emit('data', Buffer.from('failure line\n'))

      expect(info).toHaveBeenCalledWith('Session worker output', {
        sessionId: 'sess-1',
        workerId: token.workerId,
        generation: token.generation,
        stream: 'stdout',
        line: 'first line',
      })
      expect(info).toHaveBeenCalledWith('Session worker output', {
        sessionId: 'sess-1',
        workerId: token.workerId,
        generation: token.generation,
        stream: 'stdout',
        line: 'second line',
      })
      expect(error).toHaveBeenCalledWith('Session worker output', {
        sessionId: 'sess-1',
        workerId: token.workerId,
        generation: token.generation,
        stream: 'stderr',
        line: 'failure line',
      })
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })

  it.fails('worker output without newline stays bounded and is relayed with an omission marker', () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-bounded-output.db')
    openDbs.push(db)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
    })

    try {
      manager.launch('sess-1', () => {})
      child.stdout!.emit('data', Buffer.from('x'.repeat(128 * 1024)))
      child.stdout!.emit('data', Buffer.from('\n'))

      const output = info.mock.calls.find(([message]) => message === 'Session worker output')
      expect(output).toBeDefined()
      const context = output![1] as { line: string }
      expect(context.line).toMatch(/\[\d+ bytes omitted\]/)
      expect(Buffer.byteLength(context.line)).toBeLessThanOrEqual(64 * 1024)
    } finally {
      info.mockRestore()
    }
  })

  it.fails('worker log flood is rate limited without blocking control messages', () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-rate-limit.db')
    openDbs.push(db)
    const initialActivity = '2024-01-01T00:00:00.000Z'
    namedDb.prepare(`UPDATE sessions SET updated_at = ? WHERE id = 'sess-1'`).run(initialActivity)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
    })

    try {
      manager.launch('sess-1', () => {})
      const token = manager.activeWorker('sess-1')!.token
      child.stdout!.emit('data', Buffer.from(`${'line\n'.repeat(10_000)}tail`))
      child.emit('message', { ...token, type: 'health', data: {} })

      const outputCalls = info.mock.calls.filter(([message]) => message === 'Session worker output')
      expect(outputCalls.length).toBeLessThanOrEqual(101)
      expect(outputCalls.some(([, context]) => String((context as { line: string }).line).includes('rate limit'))).toBe(
        true,
      )
      const row = namedDb.prepare(`SELECT updated_at FROM sessions WHERE id = 'sess-1'`).get() as {
        updated_at: string
      }
      expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(initialActivity).getTime())
    } finally {
      info.mockRestore()
    }
  })

  it('lastActivityAt advances while a worker turn is running', () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-activity.db')
    openDbs.push(db)
    const initialActivity = '2024-01-01T00:00:00.000Z'
    namedDb.prepare(`UPDATE sessions SET updated_at = ? WHERE id = 'sess-1'`).run(initialActivity)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
    })

    manager.launch('sess-1', () => {})
    const token = manager.activeWorker('sess-1')!.token
    child.emit('message', { ...token, type: 'health', data: {} })

    const row = namedDb.prepare(`SELECT updated_at FROM sessions WHERE id = 'sess-1'`).get() as {
      updated_at: string
    }
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(initialActivity).getTime())
  })

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

  it('settles the runtime before starting the next queued command for the same session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-worker-serial-command-'))
    const { db, namedDb } = createDb(join(root, 'sessions.db'))
    openDbs.push(db)
    const children = [42, 43].map(
      (pid) =>
        Object.assign(new EventEmitter(), {
          pid,
          exitCode: null,
          signalCode: null,
          stderr: new EventEmitter(),
          send: vi.fn(() => true),
          kill: () => true,
        }) as unknown as ChildProcess,
    )
    const spawnWorker = vi.fn(() => children[spawnWorker.mock.calls.length - 1]!)
    const order: string[] = []
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      maxProcesses: 1,
      processSupervisor: { spawnWorker } as never,
      eventStore: () => ({ invalidateExternalSession: () => {} }) as never,
    })

    try {
      expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', () => order.push('settled-1')))).toBe(
        'started',
      )
      expect(
        manager.requestTurn('sess-1', () => {
          order.push('start-2')
          manager.launch('sess-1', () => order.push('settled-2'))
        }),
      ).toBe('waiting')

      const first = manager.activeWorker('sess-1')!
      children[0]!.emit('message', { ...first.token, type: 'done', ok: true })
      children[0]!.emit('exit', 0, null)
      await vi.waitFor(() => expect(manager.activeWorker('sess-1')?.pid).toBe(43))
      expect(order).toEqual(['settled-1', 'start-2'])

      const second = manager.activeWorker('sess-1')!
      children[1]!.emit('message', { ...second.token, type: 'done', ok: true })
      children[1]!.emit('exit', 0, null)
      await vi.waitFor(() => expect(manager.activeWorker('sess-1')).toBeNull())
      expect(order).toEqual(['settled-1', 'start-2', 'settled-2'])
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

  it('aborts immediately, escalates at 500 ms intervals, and interrupts a forced stop', async () => {
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
    const queuedStart = vi.fn()
    const runtime = new SessionRuntimeRegistry().get('sess-1')
    const appended: string[] = []
    const cleanupChildren = vi.fn(async () => [99])
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
      cleanupChildren,
      processSupervisor: { spawnWorker: () => child } as never,
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
          append: (_sessionId: string, event: { type: string }) => appended.push(event.type),
        }) as never,
      captureInventory: (pid) => ({
        capturedAt: 1_000,
        worker: { pid, startedAt: 'linux:42', pgid: 42 },
        children: [],
        groups: [],
        reservations: [],
        errors: [],
      }),
      verifyInventory: async (inventory) => ({
        checkedAt: inventory.capturedAt + 2_000,
        clean: true,
        survivingIdentities: [],
        survivingGroups: [],
        liveReservations: [],
        errors: [],
      }),
    })

    try {
      expect(
        manager.requestTurn('sess-1', () => {
          const handle = runtime.acquire('chat')
          manager.launch('sess-1', (outcome) => {
            settled(outcome)
            runtime.release(handle)
          })
        }),
      ).toBe('started')
      expect(
        manager.requestTurn('sess-1', () => {
          queuedStart()
          runtime.acquire('compact')
        }),
      ).toBe('waiting')
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
      expect(settled).toHaveBeenCalledWith({ crashed: true })
      expect(appended).toContain('tool.reconciliation_required')
      expect(manager.activeWorker('sess-1')).toBeNull()
      expect(queuedStart).not.toHaveBeenCalled()
      expect(runtime.state).toBe('idle')
      const interrupted = namedDb.prepare(`SELECT interrupted_at FROM sessions WHERE id = 'sess-1'`).get() as {
        interrupted_at: string | null
      }
      expect(interrupted.interrupted_at).toBeTruthy()
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

  it('rejects shutdown when child cleanup exceeds the global deadline', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-worker-manager-deadline-${crypto.randomUUID()}.db`))
    openDbs.push(db)
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
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
      cleanupChildren: () => new Promise<number[]>(() => {}),
      shutdownTimeoutMs: 100,
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })

    try {
      manager.launch('sess-1', vi.fn())
      const shutdown = manager.shutdown()
      const rejected = expect(shutdown).rejects.toThrow(/cleanup exceeded shutdown deadline/i)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds forced Stop when inventory capture and child cleanup never settle', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-worker-manager-rpc-deadline-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    const kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
      return true
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill,
    }) as unknown as ChildProcess
    const settled = vi.fn()
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
      processSupervisor: {
        spawnWorker: () => child,
        captureWorkerInventory: () => new Promise(() => {}),
        cleanupWorkerChildren: () => new Promise(() => {}),
        verifyWorkerInventory: () => new Promise(() => {}),
      } as never,
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })

    try {
      manager.launch('sess-1', settled)
      expect(manager.requestStop('sess-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(kill).toHaveBeenCalledWith('SIGTERM')
      await vi.advanceTimersByTimeAsync(500)
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1_000)

      expect(settled).toHaveBeenCalledWith({
        crashed: true,
        error: expect.stringMatching(/cleanup.*Stop settlement.*background/i),
      })
      expect(manager.lastCrashReport()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a stopped worker within two seconds of exit while cleanup continues', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(
      join(tmpdir(), `openfox-worker-manager-cleanup-background-${crypto.randomUUID()}.db`),
    )
    openDbs.push(db)
    let finishCleanup: (pids: number[]) => void = () => {}
    let cleanupCompleted = false
    const cleanup = new Promise<number[]>((resolve) => {
      finishCleanup = resolve
    }).then((pids) => {
      cleanupCompleted = true
      return pids
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn((message: { type?: string; workerId?: string; generation?: number }) => {
        if (message.type === 'abort') {
          queueMicrotask(() => {
            child.emit('message', {
              workerId: message.workerId,
              generation: message.generation,
              type: 'done',
              ok: true,
            })
            child.emit('exit', 0, null)
          })
        }
        return true
      }),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const settled = vi.fn()
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
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
      cleanupChildren: () => cleanup,
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })

    try {
      manager.launch('sess-1', settled)
      expect(manager.requestStop('sess-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(settled).toHaveBeenCalledWith({
        crashed: false,
        error: expect.stringMatching(/cleanup.*Stop settlement.*background/i),
      })
      expect(cleanupCompleted).toBe(false)
      expect(manager.activeWorker('sess-1')).toBeNull()

      finishCleanup([99])
      await Promise.resolve()
      expect(cleanupCompleted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks queued and direct launches while crash cleanup is suspended', async () => {
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-worker-manager-crash-barrier-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    let finishCleanup: (pids: number[]) => void = () => {}
    const cleanup = new Promise<number[]>((resolve) => {
      finishCleanup = resolve
    })
    const cleanupChildren = vi.fn(() => cleanup)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const spawnWorker = vi.fn(() => child)
    const settled = vi.fn()
    const queuedStart = vi.fn()
    const directSettled = vi.fn()
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: {
        getActiveWorkflowExecution: () => null,
        addMessage: () => ({ id: 'notice', role: 'user', content: 'interrupted' }),
      } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      maxProcesses: 1,
      processSupervisor: { spawnWorker } as never,
      captureInventory: (pid) => ({
        capturedAt: Date.now(),
        worker: { pid, startedAt: `linux:${pid}`, pgid: pid },
        children: [],
        groups: [],
        reservations: [],
        errors: [],
      }),
      cleanupChildren,
      verifyInventory: async (inventory) => ({
        checkedAt: inventory.capturedAt + 2_000,
        clean: true,
        survivingIdentities: [],
        survivingGroups: [],
        liveReservations: [],
        errors: [],
      }),
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })

    expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', settled))).toBe('started')
    child.emit('exit', null, 'SIGKILL')
    await vi.waitFor(() => expect(cleanupChildren).toHaveBeenCalledOnce())

    expect(manager.requestTurn('sess-1', queuedStart)).toBe('full')
    expect(() => manager.launch('sess-1', directSettled)).toThrow(/interruption/i)

    finishCleanup([])
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ crashed: true }))
    expect(queuedStart).not.toHaveBeenCalled()
    expect(directSettled).not.toHaveBeenCalled()
  })

  it('keeps a successor generation admitted when stopped-worker cleanup finishes after T+2', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(
      join(tmpdir(), `openfox-worker-manager-cleanup-background-${crypto.randomUUID()}.db`),
    )
    openDbs.push(db)
    namedDb.prepare(`INSERT INTO sessions (id) VALUES ('sess-2')`).run()
    let finishCleanup: (pids: number[]) => void = () => {}
    let cleanupCompleted = false
    const cleanup = new Promise<number[]>((resolve) => {
      finishCleanup = resolve
    }).then((pids) => {
      cleanupCompleted = true
      return pids
    })
    const stoppedChild = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn((message: { type?: string }) => {
        if (message.type === 'abort') queueMicrotask(() => stoppedChild.emit('exit', null, 'SIGTERM'))
        return true
      }),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const successorChild = Object.assign(new EventEmitter(), {
      pid: 43,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const spawnWorker = vi.fn().mockReturnValueOnce(stoppedChild).mockReturnValueOnce(successorChild)
    const settled = vi.fn()
    const successorSettled = vi.fn()
    const waitingStart = vi.fn()
    const setRunning = vi.fn()
    const broadcastForSession = vi.fn()
    const invalidateExternalSession = vi.fn()
    const append = vi.fn()
    const addMessage = vi.fn(() => ({ id: 'notice', role: 'user', content: 'interrupted' }))
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: {
        setRunning,
        getActiveWorkflowExecution: () => null,
        addMessage,
      } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession,
      maxProcesses: 1,
      processSupervisor: { spawnWorker } as never,
      captureInventory: (pid) => ({
        capturedAt: Date.now(),
        worker: { pid, startedAt: `linux:${pid}`, pgid: pid },
        children: [],
        groups: [],
        reservations: [],
        errors: [],
      }),
      cleanupChildren: () => cleanup,
      verifyInventory: async (inventory) => ({
        checkedAt: inventory.capturedAt + 2_000,
        clean: true,
        survivingIdentities: [],
        survivingGroups: [],
        liveReservations: [],
        errors: [],
      }),
      eventStore: () =>
        ({
          invalidateExternalSession,
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
          append,
        }) as never,
    })

    try {
      expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', settled))).toBe('started')
      expect(manager.requestStop('sess-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(settled).toHaveBeenCalledOnce()
      expect(settled).toHaveBeenCalledWith({
        crashed: true,
        error: expect.stringMatching(/cleanup.*Stop settlement.*background/i),
      })
      expect(cleanupCompleted).toBe(false)
      expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', successorSettled))).toBe('started')
      const successor = manager.activeWorker('sess-1')
      expect(successor?.pid).toBe(43)
      expect(manager.requestTurn('sess-2', waitingStart)).toBe('waiting')

      finishCleanup([99])
      await vi.advanceTimersByTimeAsync(0)

      expect(cleanupCompleted).toBe(true)
      expect(manager.activeWorker('sess-1')?.token).toEqual(successor?.token)
      expect(waitingStart).not.toHaveBeenCalled()
      expect(setRunning).not.toHaveBeenCalled()
      expect(invalidateExternalSession).not.toHaveBeenCalled()
      expect(append).not.toHaveBeenCalled()
      expect(addMessage).not.toHaveBeenCalled()
      expect(broadcastForSession).not.toHaveBeenCalled()
      expect(settled).toHaveBeenCalledOnce()
      expect(successorSettled).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects late stopped-worker finalization after a newer generation already finished', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(
      join(tmpdir(), `openfox-worker-manager-finished-successor-${crypto.randomUUID()}.db`),
    )
    openDbs.push(db)
    let finishCleanup: (pids: number[]) => void = () => {}
    const cleanup = new Promise<number[]>((resolve) => {
      finishCleanup = resolve
    })
    const stoppedChild = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn((message: { type?: string }) => {
        if (message.type === 'abort') queueMicrotask(() => stoppedChild.emit('exit', null, 'SIGTERM'))
        return true
      }),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const successorChild = Object.assign(new EventEmitter(), {
      pid: 43,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess
    const spawnWorker = vi.fn().mockReturnValueOnce(stoppedChild).mockReturnValueOnce(successorChild)
    const settled = vi.fn()
    const successorSettled = vi.fn()
    const setRunning = vi.fn()
    const broadcastForSession = vi.fn()
    const invalidateExternalSession = vi.fn()
    const append = vi.fn()
    const addMessage = vi.fn(() => ({ id: 'notice', role: 'user', content: 'interrupted' }))
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: {
        setRunning,
        getActiveWorkflowExecution: () => null,
        addMessage,
      } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession,
      maxProcesses: 1,
      processSupervisor: { spawnWorker } as never,
      captureInventory: (pid) => ({
        capturedAt: Date.now(),
        worker: { pid, startedAt: `linux:${pid}`, pgid: pid },
        children: [],
        groups: [],
        reservations: [],
        errors: [],
      }),
      cleanupChildren: () => cleanup,
      verifyInventory: async (inventory) => ({
        checkedAt: inventory.capturedAt + 2_000,
        clean: true,
        survivingIdentities: [],
        survivingGroups: [],
        liveReservations: [],
        errors: [],
      }),
      eventStore: () =>
        ({
          invalidateExternalSession,
          getEvents: () => [],
          append,
        }) as never,
    })

    try {
      expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', settled))).toBe('started')
      expect(manager.requestStop('sess-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settled).toHaveBeenCalledOnce()

      expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', successorSettled))).toBe('started')
      const successor = manager.activeWorker('sess-1')
      successorChild.emit('message', { ...successor!.token, type: 'done', ok: true })
      successorChild.emit('exit', 0, null)
      await vi.advanceTimersByTimeAsync(0)
      expect(successorSettled).toHaveBeenCalledOnce()
      expect(manager.activeWorker('sess-1')).toBeNull()
      expect(namedDb.prepare(`SELECT worker_id, worker_generation FROM sessions WHERE id = 'sess-1'`).get()).toEqual({
        worker_id: null,
        worker_generation: 2,
      })
      invalidateExternalSession.mockClear()

      finishCleanup([99])
      await vi.advanceTimersByTimeAsync(0)

      expect(namedDb.prepare(`SELECT interrupted_at FROM sessions WHERE id = 'sess-1'`).get()).toEqual({
        interrupted_at: null,
      })
      expect(setRunning).not.toHaveBeenCalled()
      expect(invalidateExternalSession).not.toHaveBeenCalled()
      expect(append).not.toHaveBeenCalled()
      expect(addMessage).not.toHaveBeenCalled()
      expect(broadcastForSession).not.toHaveBeenCalled()
      expect(settled).toHaveBeenCalledOnce()
      expect(successorSettled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles Stop failure at two seconds without releasing a live worker slot', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-worker-manager-stop-deadline-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    namedDb.prepare(`INSERT INTO sessions (id) VALUES ('sess-2')`).run()
    const kill = vi.fn(() => true)
    const killVerified = vi.fn(async () => {
      throw new Error('Worker start identity changed; signal refused')
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill,
      killVerified,
    }) as unknown as ChildProcess
    const settled = vi.fn()
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      maxProcesses: 1,
      processSupervisor: {
        spawnWorker: () => child,
        captureWorkerInventory: (workerPid: number, _path: string, worker: unknown, capturedAt: number) =>
          Promise.resolve({
            capturedAt,
            worker: worker ?? { pid: workerPid, startedAt: 'linux:42', pgid: 42 },
            children: [],
            groups: [],
            reservations: [],
            errors: [],
          }),
      } as never,
    })

    try {
      expect(manager.requestTurn('sess-1', () => manager.launch('sess-1', settled))).toBe('started')
      expect(manager.requestStop('sess-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(settled).toHaveBeenCalledOnce()
      expect(settled).toHaveBeenCalledWith({
        crashed: true,
        error: expect.stringMatching(/did not exit.*Stop deadline.*identity changed/i),
      })
      expect(killVerified).toHaveBeenCalledTimes(2)
      expect(kill).not.toHaveBeenCalled()
      expect(manager.activeWorker('sess-1')).not.toBeNull()
      const waitingStart = vi.fn()
      expect(manager.requestTurn('sess-2', waitingStart)).toBe('waiting')
      expect(waitingStart).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes orphan state at T+2 even when child cleanup misses the recovery deadline', async () => {
    vi.useFakeTimers()
    const { db, namedDb } = createDb(join(tmpdir(), `openfox-worker-manager-proof-deadline-${crypto.randomUUID()}.db`))
    openDbs.push(db)
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
        return true
      }),
    }) as unknown as ChildProcess
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
      processSupervisor: { spawnWorker: () => child } as never,
      captureInventory: (pid) => ({
        capturedAt: Date.now(),
        worker: { pid, startedAt: 'linux:42', pgid: 42 },
        children: [],
        groups: [],
        reservations: [],
        errors: [],
      }),
      cleanupChildren: () => new Promise<number[]>(() => {}),
      verifyInventory: async (inventory) => {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(0, inventory.capturedAt + 2_000 - Date.now())),
        )
        return {
          checkedAt: Date.now(),
          clean: true,
          survivingIdentities: [],
          survivingGroups: [],
          liveReservations: [],
          errors: [],
        }
      },
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })

    try {
      manager.launch('sess-1', vi.fn())
      const stopStartedAt = Date.now()
      manager.requestStop('sess-1')
      await vi.advanceTimersByTimeAsync(4_000)

      expect(manager.lastCrashReport()).toMatchObject({
        cleanupError: expect.stringMatching(/deadline/i),
        orphanCheck: {
          checkedAt: stopStartedAt + 2_000,
          clean: true,
          errors: [],
        },
      })
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
      captureInventory: (pid) => ({
        capturedAt: 100,
        worker: { pid, startedAt: 'linux:42', pgid: 42 },
        children: [{ pid: 99, startedAt: 'linux:99', pgid: 99 }],
        groups: [99],
        reservations: [],
        errors: [],
      }),
      verifyInventory: async (inventory) => ({
        checkedAt: inventory.capturedAt + 2_000,
        clean: true,
        survivingIdentities: [],
        survivingGroups: [],
        liveReservations: [],
        errors: [],
      }),
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
      await vi.waitFor(() => expect(manager.lastCrashReport()?.orphanCheck?.clean).toBe(true))
      expect(manager.lastCrashReport()).toMatchObject({
        cleanupError: expect.stringMatching(/reservation scan failed/),
        inventory: {
          worker: { pid: 42, startedAt: 'linux:42', pgid: 42 },
          children: [{ pid: 99, startedAt: 'linux:99', pgid: 99 }],
        },
      })
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
