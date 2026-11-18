import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../shared/types.js'
import { loadConfig } from '../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { getEventStore, initEventStore } from '../events/index.js'
import { logger } from '../utils/logger.js'
import { SessionManager } from './manager.js'
import { configureAttentionService, getAttentionService, resetAttentionService } from './attention.js'

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

/**
 * Hold a real write lock on the database from ANOTHER process, exactly like the
 * production incident: the gateway connection only tolerates a 5 ms busy wait,
 * so the next append fails instead of waiting.
 */
async function holdWriteLock(databasePath: string): Promise<HeldLock> {
  const code = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)})`,
    `const db = new Database(${JSON.stringify(databasePath)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `db.exec('CREATE TABLE IF NOT EXISTS _lock_probe (id INTEGER)')`,
    `if (process.send) process.send('locked')`,
    `process.on('SIGUSR1', () => { db.exec('ROLLBACK'); db.close(); process.exit(0) })`,
    // Keep the child alive: without a live event loop it exits and releases the
    // lock before the caller ever observes contention.
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

const children: Array<{ child: ReturnType<typeof spawn>; exited: Promise<void> }> = []

describe('session attention append under a locked database', () => {
  let root: string
  let projectDir: string
  let config: Config
  let projectId: string
  let manager: SessionManager

  const configure = () =>
    configureAttentionService({
      now: () => 1_700_000_000_000,
      waitMs: 10 * 60 * 1000,
      notify: async () => {},
      getSessionTitle: (sessionId: string) => {
        const session = manager.getSession(sessionId)
        if (!session) return null
        return {
          title: session.metadata?.title ?? '',
          projectId: session.projectId,
          createdBy: session.createdBy ?? null,
        }
      },
    })

  const attentionEvents = (sessionId: string, type: string) =>
    getEventStore()
      .getEvents(sessionId)
      .filter((event) => event.type === type)

  beforeEach(async () => {
    closeDatabase()
    resetAttentionService()
    root = await mkdtemp(join(tmpdir(), 'openfox-attention-lock-'))
    projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    config = loadConfig()
    config.database.path = join(root, 'sessions.db')
    initDatabase(config)
    initEventStore(getDatabase())
    manager = new SessionManager(mockProviderManager())
    projectId = createProject('Attention lock', projectDir).id
    configure()
  })

  afterEach(async () => {
    for (const { child, exited } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
    resetAttentionService()
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it('a locked database during session.attention_required never takes the process down', async () => {
    const session = manager.createSession(projectId, 'Blocked run')
    manager.setSessionCreatedBy(session.id, 'session-creator')
    const errors: Array<Record<string, unknown>> = []
    const errorLog = vi.spyOn(logger, 'error').mockImplementation((_message, payload) => {
      if (payload && typeof payload === 'object') errors.push(payload as Record<string, unknown>)
    })
    const lock = await holdWriteLock(config.database.path)
    try {
      // With the lock held the append cannot succeed: it must be reported, not thrown.
      expect(() => getAttentionService().observeBlocked(session.id, 'HTTP 400')).not.toThrow()
      await vi.waitFor(
        () => {
          expect(errors.find((entry) => entry['eventType'] === 'session.attention_required')).toBeDefined()
        },
        { timeout: 5_000 },
      )
    } finally {
      errorLog.mockRestore()
      lock.release()
    }

    const failure = errors.find((entry) => entry['eventType'] === 'session.attention_required')
    expect(failure!['code']).toBe('EVENT_STORE_BUSY_TIMEOUT')
  })

  it('a locked database during session.attention_cleared never takes the process down', async () => {
    const session = manager.createSession(projectId, 'Cleared run')
    manager.setSessionCreatedBy(session.id, 'session-creator')
    const service = getAttentionService()
    service.observeBlocked(session.id, 'HTTP 400')
    await vi.waitFor(() => expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1), {
      timeout: 5_000,
    })

    const errors: Array<Record<string, unknown>> = []
    const errorLog = vi.spyOn(logger, 'error').mockImplementation((_message, payload) => {
      if (payload && typeof payload === 'object') errors.push(payload as Record<string, unknown>)
    })
    const lock = await holdWriteLock(config.database.path)
    try {
      expect(() => service.observeResumed(session.id)).not.toThrow()
      await vi.waitFor(
        () => {
          expect(errors.find((entry) => entry['eventType'] === 'session.attention_cleared')).toBeDefined()
        },
        { timeout: 5_000 },
      )
    } finally {
      errorLog.mockRestore()
      lock.release()
    }

    const failure = errors.find((entry) => entry['eventType'] === 'session.attention_cleared')
    expect(failure!['code']).toBe('EVENT_STORE_BUSY_TIMEOUT')
  })

  it('a required event still waiting for its retry is persisted before the cleared event that follows it', async () => {
    // Logical order: required, then cleared. If the cleared event took a
    // synchronous shortcut while the required one waits for its retry, the
    // stream would end on "cleared" and a replay would lose the alert.
    const session = manager.createSession(projectId, 'Ordered run')
    manager.setSessionCreatedBy(session.id, 'session-creator')
    const service = getAttentionService()
    const lock = await holdWriteLock(config.database.path)
    try {
      service.observeBlocked(session.id, 'HTTP 400')
      lock.release()
      service.observeResumed(session.id)
    } finally {
      lock.release()
    }

    await vi.waitFor(
      () => {
        const types = getEventStore()
          .getEvents(session.id)
          .map((event) => event.type)
          .filter((type) => type.startsWith('session.attention'))
        expect(types).toEqual(['session.attention_required', 'session.attention_cleared'])
      },
      { timeout: 10_000 },
    )
  })

  it('a new required event is persisted after the cleared event it follows', async () => {
    // Logical order: required, cleared, required. A synchronous shortcut on the
    // second required would erase an alert that is genuinely active.
    const session = manager.createSession(projectId, 'Re-armed run')
    manager.setSessionCreatedBy(session.id, 'session-creator')
    const service = getAttentionService()
    service.observeBlocked(session.id, 'HTTP 400')
    await vi.waitFor(() => expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1), {
      timeout: 5_000,
    })

    const lock = await holdWriteLock(config.database.path)
    try {
      service.observeResumed(session.id)
      lock.release()
      service.observeBlocked(session.id, 'HTTP 500')
    } finally {
      lock.release()
    }

    await vi.waitFor(
      () => {
        const types = getEventStore()
          .getEvents(session.id)
          .map((event) => event.type)
          .filter((type) => type.startsWith('session.attention'))
        expect(types).toEqual(['session.attention_required', 'session.attention_cleared', 'session.attention_required'])
      },
      { timeout: 10_000 },
    )
  })
})
