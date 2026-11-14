import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type MockInstance } from 'vitest'
import type { LLMCompletionResponse, LLMStreamEvent } from '../llm/types.js'
import type { ToolCall } from '../../shared/types.js'
import type { AgentDefinition } from '../agents/types.js'
import type { ToolRegistry } from '../tools/types.js'
import type { TurnEvent } from '../events/types.js'

const { getEventStoreMock, getToolRegistryForAgentMock, toolRegistryFactory } = vi.hoisted(() => ({
  getEventStoreMock: vi.fn(),
  getToolRegistryForAgentMock: vi.fn(),
  toolRegistryFactory: {
    current: undefined as unknown as (agentDef: AgentDefinition, sessionId?: string) => ToolRegistry,
  },
}))

vi.mock('../events/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/store.js')>()),
  getEventStore: getEventStoreMock,
}))

vi.mock('../tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/index.js')>()
  toolRegistryFactory.current = actual.getToolRegistryForAgent
  getToolRegistryForAgentMock.mockImplementation(actual.getToolRegistryForAgent)
  return { ...actual, getToolRegistryForAgent: getToolRegistryForAgentMock }
})

vi.mock('../lsp/index.js', () => ({
  getLspManager: vi.fn(() => undefined),
  shutdownLspManager: vi.fn(async () => {}),
}))

vi.mock('../git/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/workspace.js')>()),
  getGitBranch: vi.fn(async () => null),
}))

import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { EventStore, EventStoreBusyTimeoutError } from '../events/store.js'
import { setRuntimeConfig } from '../runtime-config.js'
import { SessionManager } from '../session/manager.js'
import { loadAllAgentsDefault } from '../agents/registry.js'
import { runChatTurn } from './orchestrator.js'

const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')
const directories: string[] = []
const locks: ControlledWriteLock[] = []

const providerManager = {
  getCurrentModelContext: vi.fn(() => 200_000),
  getLLMClient: vi.fn(),
  createClient: vi.fn(() => undefined),
  getActiveProviderId: vi.fn(() => undefined),
  getActiveProvider: vi.fn(() => undefined),
  getCurrentModel: vi.fn(() => 'scripted-model'),
  getProviders: vi.fn(() => []),
  getDefaultModelSelection: vi.fn(() => undefined),
  getModelSettings: vi.fn(() => undefined),
  resolveModelEffort: vi.fn(() => undefined),
}

export interface HotfixFixture {
  directory: string
  dbPath: string
  sessionId: string
  sessionManager: SessionManager
  store: EventStore
}

export interface ControlledWriteLock {
  child: ChildProcess
  exited: Promise<number | null>
  release: () => void
}

type RetryBusy = <T>(sessionId: string, eventType: string, operation: () => T, reportTimeout?: boolean) => T

export interface BusyAppendObservation {
  spy: MockInstance<EventStore['append']>
  retrySpy: MockInstance<RetryBusy>
}

export function completion(toolCalls: ToolCall[], content = ''): LLMCompletionResponse {
  return {
    id: crypto.randomUUID(),
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

export function createScriptedClient(
  responses: LLMCompletionResponse[],
  beforeResponse?: (call: number) => void | Promise<void>,
) {
  let calls = 0
  return {
    complete: async () => completion([]),
    getModel: () => 'scripted-model',
    getProfile: () => ({}) as never,
    getBackend: () => 'unknown' as const,
    setBackend: () => {},
    setModel: () => {},
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      const call = calls
      const response = responses[Math.min(call, responses.length - 1)]!
      calls += 1
      await beforeResponse?.(call)
      if (response.content) yield { type: 'text_delta', content: response.content }
      for (const [index, toolCall] of (response.toolCalls ?? []).entries()) {
        yield { type: 'tool_call_delta', index, id: toolCall.id, name: toolCall.name }
        yield { type: 'tool_call_delta', index, arguments: JSON.stringify(toolCall.arguments) }
      }
      yield { type: 'done', response }
    },
    calls: () => calls,
  }
}

export async function createHotfixFixture(appendBusyDeadlineMs = 100): Promise<HotfixFixture> {
  closeDatabase()
  const directory = await mkdtemp(join(tmpdir(), 'openfox-db-lock-turn-'))
  directories.push(directory)
  const dbPath = join(directory, 'sessions.db')
  const config = loadConfig()
  config.mode = 'test'
  config.database.path = dbPath
  config.context.snapshotEveryEvents = 10_000
  setRuntimeConfig(config)
  const db = initDatabase(config)
  const store = new EventStore(db, {
    appendBusyDeadlineMs,
    appendBusyInitialBackoffMs: 1,
    appendBusyMaxBackoffMs: 2,
    appendRecoveryDeadlineMs: 1_000,
  })
  getEventStoreMock.mockReturnValue(store)
  const sessionManager = new SessionManager(providerManager as never)
  const project = createProject('DB lock turn persistence', directory)
  const session = sessionManager.createSession(project.id)
  sessionManager.setMode(session.id, 'builder')
  return { directory, dbPath, sessionId: session.id, sessionManager, store }
}

export function appendUserMessage(fixture: HotfixFixture, content: string): void {
  const messageId = crypto.randomUUID()
  fixture.store.append(fixture.sessionId, {
    type: 'message.start',
    data: { messageId, role: 'user', content },
  })
  fixture.store.append(fixture.sessionId, { type: 'message.done', data: { messageId } })
}

export async function runHotfixTurn(
  fixture: HotfixFixture,
  client: ReturnType<typeof createScriptedClient>,
): Promise<void> {
  await runChatTurn({
    sessionManager: fixture.sessionManager,
    sessionId: fixture.sessionId,
    llmClient: client as never,
    skipAgentReminder: true,
  })
}

export async function createRealToolRegistrySpy(
  fixture: HotfixFixture,
): Promise<{ registry: ToolRegistry; executeSpy: ReturnType<typeof vi.spyOn> }> {
  const agents = await loadAllAgentsDefault(fixture.directory)
  const builder = agents.find((agent) => agent.metadata.id === 'builder')
  if (!builder) throw new Error('builder agent unavailable')
  const registry = toolRegistryFactory.current(builder, fixture.sessionId)
  getToolRegistryForAgentMock.mockReturnValue(registry)
  return { registry, executeSpy: vi.spyOn(registry, 'execute') }
}

export async function holdWriteLockInAnotherProcess(path: string): Promise<ControlledWriteLock> {
  const code = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)})`,
    `const db = new Database(${JSON.stringify(path)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `if (process.send) process.send('locked')`,
    `process.on('SIGUSR1', () => { db.exec('COMMIT'); db.close(); process.exit(0) })`,
    `process.on('message', () => {})`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('write lock child did not become ready')), 5_000)
    child.once('error', reject)
    child.once('message', (message) => {
      if (message !== 'locked') return
      clearTimeout(timeout)
      resolve()
    })
  })
  let released = false
  const lock = {
    child,
    exited,
    release: () => {
      if (released) return
      released = true
      if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid, 'SIGUSR1')
    },
  }
  locks.push(lock)
  return lock
}

export function observeBusyAppend(
  store: EventStore,
  eventType: TurnEvent['type'],
  getLock: () => ControlledWriteLock | undefined,
): BusyAppendObservation {
  const retryTarget = store as unknown as { retryBusy: RetryBusy }
  const originalRetryBusy = retryTarget.retryBusy.bind(retryTarget)
  const spy = vi.spyOn(store, 'append')
  const retrySpy = vi.spyOn(retryTarget, 'retryBusy')
  retrySpy.mockImplementation(((sessionId, currentEventType, operation, reportTimeout) => {
    try {
      return originalRetryBusy(sessionId, currentEventType, operation, reportTimeout)
    } catch (error) {
      if (currentEventType === eventType && error instanceof EventStoreBusyTimeoutError) getLock()?.release()
      throw error
    }
  }) as RetryBusy)
  return { spy, retrySpy }
}

export function findBusyAppendThrow(
  observation: BusyAppendObservation,
  eventType: TurnEvent['type'],
): { event: TurnEvent; error: EventStoreBusyTimeoutError; callIndex: number } | undefined {
  for (const [callIndex, [, event]] of observation.spy.mock.calls.entries()) {
    const result = observation.spy.mock.results[callIndex]
    if (event.type !== eventType || result?.type !== 'throw' || !(result.value instanceof EventStoreBusyTimeoutError)) {
      continue
    }
    return { event, error: result.value, callIndex }
  }
  return undefined
}

export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

export async function cleanupDbLockFixtures(): Promise<void> {
  const activeLocks = locks.splice(0)
  for (const lock of activeLocks) lock.release()
  await Promise.all(activeLocks.map((lock) => lock.exited))
  const { setMcpTools } = await import('../tools/index.js')
  setMcpTools([])
  vi.restoreAllMocks()
  getEventStoreMock.mockReset()
  getToolRegistryForAgentMock.mockReset()
  getToolRegistryForAgentMock.mockImplementation(toolRegistryFactory.current)
  closeDatabase()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
}
