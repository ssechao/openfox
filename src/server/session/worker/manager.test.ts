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

  it('signals the worker, kills its children, waits for exit, and reports a shutdown timeout', async () => {
    const { db, namedDb } = createDb('/tmp/openfox-worker-manager-shutdown.db')
    openDbs.push(db)
    const order: string[] = []
    let settledOutcome: { crashed: boolean; error?: string } | undefined
    const token = assignWorkerToken(namedDb, 'sess-1')
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: () => {
        order.push('worker')
        return true
      },
    }) as unknown as ChildProcess
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: { setRunning: () => {} } as unknown as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
      cleanupChildren: async () => {
        order.push('children')
        return [99]
      },
      shutdownTimeoutMs: 25,
      eventStore: () =>
        ({
          invalidateExternalSession: () => {},
          getEvents: () => [],
          append: () => {},
        }) as never,
    })
    const active = Reflect.get(manager, 'active') as Map<string, unknown>
    active.set('sess-1', {
      sessionId: 'sess-1',
      token,
      child,
      childrenPath: '/tmp/test.children',
      doneReceived: false,
      doneOk: false,
      stderrTail: [],
      onSettled: (outcome: { crashed: boolean; error?: string }) => {
        settledOutcome = outcome
        order.push('settled')
      },
    })

    let completed = false
    const shutdown = manager.shutdown().then(() => {
      completed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['worker', 'children'])
    expect(completed).toBe(false)
    child.emit('exit', 0, null)
    await shutdown
    expect(order).toEqual(['worker', 'children', 'settled'])
    expect(settledOutcome).toMatchObject({ crashed: true, error: expect.stringMatching(/shutdown/i) })
    expect(manager.shouldUseWorker('sess-1')).toBe(false)
    expect(() => manager.launch('sess-1', () => {})).toThrow(/admissions.*closed|shutdown/i)
    const interrupted = namedDb.prepare(`SELECT interrupted_at FROM sessions WHERE id = 'sess-1'`).get() as {
      interrupted_at: string | null
    }
    expect(interrupted.interrupted_at).toBeTruthy()

    const timeoutToken = assignWorkerToken(namedDb, 'sess-1')
    const stuckChild = Object.assign(new EventEmitter(), {
      pid: 43,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess
    active.set('sess-1', {
      sessionId: 'sess-1',
      token: timeoutToken,
      child: stuckChild,
      childrenPath: '/tmp/test-timeout.children',
      doneReceived: false,
      doneOk: false,
      stderrTail: [],
      onSettled: () => {},
    })

    await expect(manager.shutdown()).rejects.toThrow(/worker.*did not exit within 25ms.*shutdown/i)
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
