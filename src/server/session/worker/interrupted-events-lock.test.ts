import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../shared/types.js'
import { loadConfig } from '../../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../../db/index.js'
import { createProject } from '../../db/projects.js'
import { getEventStore, initEventStore } from '../../events/index.js'
import { logger } from '../../utils/logger.js'
import { SessionManager } from '../manager.js'
import { prepareInterruptedEventsRecoverable } from './manager.js'

const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')

const mockProviderManager = () =>
  ({
    getCurrentModelContext: () => 200_000,
    getLLMClient: () => ({ getModel: () => 'm', stream: vi.fn(), complete: vi.fn() }),
    createClient: () => undefined,
    getActiveProviderId: () => 'test-provider',
    getCurrentModel: () => 'm',
    getProviders: () => [],
    getDefaultModelSelection: () => undefined,
    getModelSettings: () => undefined,
    resolveModelEffort: () => undefined,
  }) as unknown as ConstructorParameters<typeof SessionManager>[0]

interface HeldLock {
  release(): void
}

const children: Array<{ child: ReturnType<typeof spawn>; exited: Promise<void> }> = []

async function holdWriteLock(databasePath: string): Promise<HeldLock> {
  const code = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)})`,
    `const db = new Database(${JSON.stringify(databasePath)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `db.exec('CREATE TABLE IF NOT EXISTS _lock_probe (id INTEGER)')`,
    `if (process.send) process.send('locked')`,
    `process.on('SIGUSR1', () => { db.exec('ROLLBACK'); db.close(); process.exit(0) })`,
    `setInterval(() => {}, 1000)`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  children.push({ child, exited })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('write lock child did not become ready')), 5_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('message', (message) => {
      if (message !== 'locked') return
      clearTimeout(timer)
      resolve()
    })
  })
  return {
    release: () => {
      if (child.exitCode === null && child.signalCode === null) process.kill(child.pid!, 'SIGUSR1')
    },
  }
}

describe('interruption events under a locked database', () => {
  let root: string
  let projectDir: string
  let config: Config
  let projectId: string
  let manager: SessionManager
  let sessionId: string

  beforeEach(async () => {
    closeDatabase()
    root = await mkdtemp(join(tmpdir(), 'openfox-interrupted-lock-'))
    projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    config = loadConfig()
    config.database.path = join(root, 'sessions.db')
    initDatabase(config)
    initEventStore(getDatabase())
    manager = new SessionManager(mockProviderManager())
    projectId = createProject('Interrupted lock', projectDir).id
    sessionId = manager.createSession(projectId, 'Worker run').id
    // A pending tool call is what makes the interruption settle an outcome.
    getEventStore().append(sessionId, { type: 'message.start', data: { messageId: 'user-1', role: 'user' } })
    getEventStore().append(sessionId, {
      type: 'tool.call',
      data: {
        messageId: 'assistant-1',
        toolCall: { id: 'call-1', name: 'run_command', arguments: { command: 'effect' } },
      },
    })
  })

  afterEach(async () => {
    for (const { child, exited } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it('a locked database during settle/shutdown preparation never takes the gateway down', async () => {
    const errors: Array<Record<string, unknown>> = []
    const errorLog = vi.spyOn(logger, 'error').mockImplementation((_message, payload) => {
      if (payload && typeof payload === 'object') errors.push(payload as Record<string, unknown>)
    })
    const lock = await holdWriteLock(config.database.path)
    let prepared: unknown[] = []
    try {
      // This is the call both settle() and shutdown() make, outside any turn.
      expect(() => {
        prepared = prepareInterruptedEventsRecoverable(getEventStore(), sessionId)
      }).not.toThrow()
    } finally {
      errorLog.mockRestore()
    }
    expect(prepared).toEqual([])

    const failure = errors.find((entry) => entry['code'] === 'EVENT_STORE_BUSY_TIMEOUT')
    expect(failure).toBeDefined()

    // Released: the recoverable queue settles the outcome instead of losing it.
    lock.release()
    await vi.waitFor(
      () => {
        const settled = getEventStore()
          .getEvents(sessionId)
          .filter((event) => event.type === 'tool.result')
        expect(settled).toHaveLength(1)
      },
      { timeout: 10_000 },
    )
  })
})
