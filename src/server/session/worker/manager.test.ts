import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
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
    })
    Reflect.set(manager, 'active', {
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
    Reflect.set(manager, 'active', {
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
