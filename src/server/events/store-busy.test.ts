import Database from 'better-sqlite3'
import { fork, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { createSession } from '../db/sessions.js'
import { assignWorkerToken, type WorkerToken } from '../session/worker/token.js'
import { logger } from '../utils/logger.js'
import { EventStore } from './store.js'

const SID = 'session-1'
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')
const HERE = dirname(fileURLToPath(import.meta.url))
const BUSY_WORKER = join(HERE, 'store-busy.test-child.ts')

interface BusyWorkerReady {
  type: 'ready'
  busyTimeoutMs: number
}

interface BusyWorkerResult {
  ok: boolean
  durations: number[]
  error?: string
  code?: unknown
}

function waitForMessage<T>(
  child: ChildProcess,
  accept: (message: unknown) => message is T,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Busy worker ${child.pid} timed out`)), timeoutMs)
    const onMessage = (message: unknown) => {
      if (!accept(message)) return
      clearTimeout(timer)
      child.off('message', onMessage)
      resolve(message)
    }
    child.on('message', onMessage)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Busy worker ${child.pid} exited before reporting: ${code}`))
    })
  })
}

function spawnBusyWorker(path: string, sessionId: string, token: WorkerToken, eventCount: number): ChildProcess {
  return fork(BUSY_WORKER, [], {
    execArgv: ['--import', 'tsx/esm'],
    env: {
      ...process.env,
      OPENFOX_BUSY_TEST_DB_PATH: path,
      OPENFOX_BUSY_TEST_SESSION_ID: sessionId,
      OPENFOX_BUSY_TEST_WORKER_ID: token.workerId,
      OPENFOX_BUSY_TEST_GENERATION: String(token.generation),
      OPENFOX_BUSY_TEST_EVENT_COUNT: String(eventCount),
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
}

async function holdWriteLockInAnotherProcess(
  path: string,
  holdMs: number,
): Promise<{ exited: Promise<number | null> }> {
  const code = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)})`,
    `const db = new Database(${JSON.stringify(path)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `process.stdout.write('locked\\n')`,
    `setTimeout(() => { db.exec('COMMIT'); db.pragma('wal_checkpoint(TRUNCATE)'); db.close() }, ${holdMs})`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  await new Promise((resolve) => child.stdout.once('data', resolve))
  return { exited }
}

function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
}

describe('database busy handling', () => {
  let directory: string
  let path: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'openfox-busy-'))
    path = join(directory, 'sessions.db')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps the gateway database busy timeout short', () => {
    const db = initDatabase({ ...loadConfig(), database: { path } })
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5)
  })

  it('appends once another process releases the write lock it was holding', async () => {
    const db = initDatabase({ ...loadConfig(), database: { path } })
    const store = new EventStore(db)
    const sessionId = createSession(createProject('Busy', directory).id, directory).id
    store.append(sessionId, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error')

    const { exited: holder } = await holdWriteLockInAnotherProcess(path, 300)
    const stored = store.append(sessionId, { type: 'message.done', data: { messageId: 'u1' } })

    expect(await holder).toBe(0)
    expect(stored.seq).toBe(2)
    expect(store.getEvents(sessionId).map((event) => event.type)).toEqual(['message.start', 'message.done'])
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps four worker processes and the gateway writing through a long transaction and checkpoint', async () => {
    const workerCount = 4
    const eventCount = 8
    const db = initDatabase({ ...loadConfig(), database: { path } })
    const store = new EventStore(db, {
      appendBusyDeadlineMs: 20,
      appendBusyInitialBackoffMs: 1,
      appendBusyMaxBackoffMs: 2,
      appendRecoveryDeadlineMs: 5_000,
    })
    const project = createProject('Concurrent busy', directory)
    const gatewaySession = createSession(project.id, directory).id
    const workerSessions = Array.from({ length: workerCount }, () => createSession(project.id, directory).id)
    const workers = workerSessions.map((sessionId) => {
      const token = assignWorkerToken(db, sessionId)
      return spawnBusyWorker(path, sessionId, token, eventCount)
    })

    const ready = await Promise.all(
      workers.map((child) =>
        waitForMessage(
          child,
          (message): message is BusyWorkerReady =>
            typeof message === 'object' && message !== null && 'type' in message && message.type === 'ready',
        ),
      ),
    )
    expect(ready.every((message) => message.busyTimeoutMs >= 10_000)).toBe(true)
    const results = workers.map((child) =>
      waitForMessage(
        child,
        (message): message is BusyWorkerResult => typeof message === 'object' && message !== null && 'ok' in message,
      ),
    )
    const { exited: holder } = await holdWriteLockInAnotherProcess(path, 300)
    for (const child of workers) child.send('start')

    const gatewayDurations: number[] = []
    const gatewayWrites = Array.from({ length: eventCount }, async (_, index) => {
      const startedAt = performance.now()
      await store.appendRecoverable(gatewaySession, {
        type: 'message.start',
        data: { messageId: `gateway-${index}`, role: 'assistant', content: 'contention' },
      })
      gatewayDurations.push(performance.now() - startedAt)
    })

    expect(await holder).toBe(0)
    const workerResults = await Promise.all(results)
    await Promise.all(gatewayWrites)
    const failures = workerResults.filter((result) => !result.ok)
    const durations = [...gatewayDurations, ...workerResults.flatMap((result) => result.durations)].sort(
      (left, right) => left - right,
    )
    const p99 = durations[Math.ceil(durations.length * 0.99) - 1] ?? 0
    logger.info('SQLite contention append latency', {
      writerProcesses: workerCount + 1,
      appendCount: durations.length,
      p99Ms: Math.round(p99),
      failedWorkers: failures.length,
    })

    expect(failures).toEqual([])
    expect(p99).toBeLessThan(5000)
    for (const sessionId of [gatewaySession, ...workerSessions]) {
      expect(store.getEvents(sessionId)).toHaveLength(eventCount)
    }
  }, 20_000)

  it('retries an append that hits SQLITE_BUSY a bounded number of times', () => {
    const db = new Database(path)
    const store = new EventStore(db, {
      appendBusyDeadlineMs: 25,
      appendBusyInitialBackoffMs: 1,
      appendBusyMaxBackoffMs: 2,
    })
    store.append(SID, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const prepare = db.prepare.bind(db)
    let failures = 2
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('INSERT INTO events')) return statement
      return {
        run: (...args: unknown[]) => {
          if (failures-- > 0) throw busyError()
          return statement.run(...args)
        },
      }
    }) as never)

    expect(store.append(SID, { type: 'message.done', data: { messageId: 'u1' } }).seq).toBe(2)
    expect(error).not.toHaveBeenCalled()

    failures = Number.POSITIVE_INFINITY
    expect(() => store.append(SID, { type: 'message.done', data: { messageId: 'u1' } })).toThrow(
      'Event append busy deadline exceeded',
    )
    expect(error).toHaveBeenCalledTimes(1)

    failures = 2
    expect(
      store
        .appendBatch(SID, [
          { type: 'message.done', data: { messageId: 'u2' } },
          { type: 'message.done', data: { messageId: 'u3' } },
        ])
        .map((event) => event.seq),
    ).toEqual([3, 4])
    expect(error).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('rejects a persistent recoverable timeout explicitly and accepts a later retry', async () => {
    const db = new Database(path, { timeout: 1 })
    db.pragma('journal_mode = WAL')
    const store = new EventStore(db, {
      appendBusyDeadlineMs: 5,
      appendBusyInitialBackoffMs: 1,
      appendBusyMaxBackoffMs: 2,
      appendRecoveryDeadlineMs: 40,
    })
    store.append(SID, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const holder = new Database(path)
    holder.exec('BEGIN IMMEDIATE')

    await expect(
      store.appendRecoverable(SID, { type: 'message.done', data: { messageId: 'u1' } }),
    ).rejects.toMatchObject({ code: 'EVENT_STORE_BUSY_TIMEOUT', deadlineMs: 40 })
    expect(error).toHaveBeenCalledTimes(1)

    holder.exec('ROLLBACK')
    holder.close()
    await expect(
      store.appendRecoverable(SID, { type: 'message.done', data: { messageId: 'u1' } }),
    ).resolves.toMatchObject({ seq: 2 })
    expect(store.getEvents(SID)).toHaveLength(2)
    db.close()
  })

  it('logs and reports an append that stays locked, then keeps working once the lock is released', () => {
    const db = new Database(path, { timeout: 20 })
    db.pragma('journal_mode = WAL')
    const store = new EventStore(db, {
      appendBusyDeadlineMs: 25,
      appendBusyInitialBackoffMs: 1,
      appendBusyMaxBackoffMs: 2,
    })
    store.append(SID, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const holder = new Database(path)
    holder.exec('BEGIN IMMEDIATE')

    expect(() => store.append(SID, { type: 'message.done', data: { messageId: 'u1' } })).toThrow(
      expect.objectContaining({ code: 'EVENT_STORE_BUSY_TIMEOUT' }),
    )
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toMatch(/lock/)
    expect(error.mock.calls[0]?.[1]).toMatchObject({ sessionId: SID, type: 'message.done' })

    holder.exec('ROLLBACK')
    holder.close()
    expect(store.append(SID, { type: 'message.done', data: { messageId: 'u1' } }).seq).toBe(2)
    db.close()
  })
})
