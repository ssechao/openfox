import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMCompletionResponse, LLMStreamEvent } from '../llm/types.js'
import type { ToolCall } from '../../shared/types.js'

const { getEventStoreMock } = vi.hoisted(() => ({ getEventStoreMock: vi.fn() }))

vi.mock('../events/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/store.js')>()),
  getEventStore: getEventStoreMock,
}))

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
import { EventStore } from '../events/store.js'
import { setRuntimeConfig } from '../runtime-config.js'
import { SessionManager } from '../session/manager.js'
import { runChatTurn } from './orchestrator.js'

const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')
const directories: string[] = []

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

export function completion(toolCalls: ToolCall[], content = ''): LLMCompletionResponse {
  return {
    id: crypto.randomUUID(),
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

export function createScriptedClient(responses: LLMCompletionResponse[]) {
  let calls = 0
  return {
    complete: async () => completion([]),
    getModel: () => 'scripted-model',
    getProfile: () => ({}) as never,
    getBackend: () => 'unknown' as const,
    setBackend: () => {},
    setModel: () => {},
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      const response = responses[Math.min(calls, responses.length - 1)]!
      calls += 1
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

export async function holdWriteLockInAnotherProcess(path: string, holdMs: number): Promise<Promise<number | null>> {
  const code = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)})`,
    `const db = new Database(${JSON.stringify(path)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `process.stdout.write('locked\\n')`,
    `setTimeout(() => { db.exec('COMMIT'); db.close() }, ${holdMs})`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('write lock child did not become ready')), 5_000)
    child.once('error', reject)
    child.stdout.once('data', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  return exited
}

export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

afterEach(async () => {
  vi.restoreAllMocks()
  getEventStoreMock.mockReset()
  closeDatabase()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('turn event persistence', () => {
  it.fails('a turn stops with an explicit error when a turn event cannot be persisted', async () => {
    const fixture = await createHotfixFixture(100)
    appendUserMessage(fixture, 'Write the result.')
    const outputPath = join(fixture.directory, 'effect.txt')
    const toolCall: ToolCall = {
      id: 'exec-lock',
      name: 'write_file',
      arguments: { path: outputPath, content: 'executed' },
    }
    const client = createScriptedClient([completion([toolCall]), completion([], 'finished')])
    const holder = await holdWriteLockInAnotherProcess(fixture.dbPath, 130)

    await runHotfixTurn(fixture, client)
    expect(await holder).toBe(0)

    const events = fixture.store.getEvents(fixture.sessionId)
    const messageIds = new Set(
      events
        .filter((event) => event.type === 'message.start')
        .map((event) => (event.data as { messageId: string }).messageId),
    )
    const orphaned = events.filter(
      (event) =>
        (event.type === 'tool.call' || event.type === 'tool.result') &&
        !messageIds.has((event.data as { messageId: string }).messageId),
    )
    const chatErrors = events.filter((event) => event.type === 'chat.error')

    expect.soft(await pathExists(outputPath)).toBe(false)
    expect.soft(client.calls()).toBe(1)
    expect.soft(chatErrors).toHaveLength(1)
    expect.soft(orphaned).toEqual([])
    expect.soft(fixture.sessionManager.requireSession(fixture.sessionId).isRunning).toBe(false)
    expect.soft(fixture.sessionManager.getQueueState(fixture.sessionId)).toEqual([])
  })
})
