import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { LLMStreamEvent, LLMCompletionResponse } from '../llm/types.js'
import { EventStore } from '../events/store.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import type { RequestContextMessage } from './request-context.js'
import { convertMessages } from '../llm/client-pure.js'
import { buildResponsesRequest } from '../llm/responses-native.js'
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from '../llm/openai-types.js'

vi.mock('../events/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/index.js')>()
  return {
    ...actual,
    getCurrentContextWindowId: vi.fn(() => undefined),
    getCurrentWindowMessageOptions: vi.fn(() => undefined),
    getEventStore: vi.fn(),
  }
})

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: vi.fn(),
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn(),
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    mode: 'test',
    workdir: '/test',
    context: { compactionThreshold: 800000 },
    llm: {
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      timeout: 30000,
      idleTimeout: 30000,
      backend: 'ollama',
    },
  }),
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: vi.fn().mockReturnValue('/test/config'),
}))

vi.mock('../context/compactor.js', () => ({
  shouldCompact: vi.fn(() => false),
  appendCompactionPrompt: vi.fn(),
}))

vi.mock('../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(async () => []),
  getSubAgents: vi.fn(() => []),
}))

vi.mock('../drain-queue.js', () => ({
  drainQueue: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runTopLevelAgentLoop } from './agent-loop.js'
import { ensureRequestNotEndingWithAssistant, getConversationMessages } from './conversation-history.js'
import { getEventStore } from '../events/index.js'

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }

const okToolResponse: LLMCompletionResponse = {
  id: 'resp-ok',
  content: '',
  toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
  finishReason: 'tool_calls',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
}

function createSequencedClient(...eventSets: LLMStreamEvent[][]) {
  let attempt = 0
  return {
    complete: async () => {
      throw new Error('Not implemented')
    },
    getModel: () => 'test-model',
    getProfile: () => ({}) as never,
    getBackend: () => 'unknown' as const,
    setBackend: () => {},
    setModel: () => {},
    stream: async function* () {
      const events = eventSets[Math.min(attempt, eventSets.length - 1)]!
      attempt += 1
      for (const event of events) yield event
    },
  }
}

function snapshot(messages: RequestContextMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

function isPrefix(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  return a.every((msg, i) => msg.role === b[i]?.role && msg.content === b[i]?.content)
}

describe('wrapper-compat C1 history and empty tool-call content', () => {
  it('sends Chat tool-call-only assistants with content null, never a space', async () => {
    const result = await convertMessages(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'glob', arguments: { pattern: '*.ts' } }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'call-1' },
      ],
      false,
    )
    const assistant = result[1] as unknown as Record<string, unknown>
    expect(assistant['content']).toBeNull()
    expect(assistant['content']).not.toBe(' ')
  })

  it('omits a Responses assistant text item for a tool-call-only turn', async () => {
    const chat = (await convertMessages(
      [
        {
          role: 'assistant',
          content: ' ',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
        },
        { role: 'tool', content: 'file', toolCallId: 'call-1' },
      ],
      false,
    )) as ChatCompletionMessageParam[]
    const body = buildResponsesRequest({
      model: 'grok-4.6',
      messages: chat,
      stream: true,
    } as ChatCompletionCreateParamsStreaming)
    expect(JSON.stringify(body.input)).not.toContain('" "')
    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'file' },
    ])
  })

  it('does not invent an unpersisted continuation in getConversationMessages', () => {
    const events = [
      {
        seq: 1,
        sessionId: 'session-1',
        timestamp: 1,
        type: 'session.initialized' as const,
        data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'window-1' },
      },
      {
        seq: 2,
        sessionId: 'session-1',
        timestamp: 2,
        type: 'message.start' as const,
        data: { messageId: 'u1', role: 'user', content: 'Hello', contextWindowId: 'window-1' },
      },
      {
        seq: 3,
        sessionId: 'session-1',
        timestamp: 3,
        type: 'message.done' as const,
        data: { messageId: 'u1' },
      },
      {
        seq: 4,
        sessionId: 'session-1',
        timestamp: 4,
        type: 'message.start' as const,
        data: {
          messageId: 'a1',
          role: 'assistant',
          content: '## Conversation Summary',
          contextWindowId: 'window-1',
          isCompactionSummary: true,
        },
      },
      {
        seq: 5,
        sessionId: 'session-1',
        timestamp: 5,
        type: 'message.done' as const,
        data: { messageId: 'a1' },
      },
    ]
    vi.mocked(getEventStore).mockReturnValue({
      getReplayEvents: () => events,
    } as never)
    const result = getConversationMessages({ type: 'toplevel', sessionId: 'session-1' })
    expect(result.at(-1)?.role).toBe('assistant')
    expect(result.some((m) => m.content.includes('Continue your work'))).toBe(false)
    const withSynthetic = ensureRequestNotEndingWithAssistant(result)
    expect(withSynthetic).not.toBe(result)
    expect(withSynthetic.at(-1)?.role).toBe('user')
  })
})

describe('wrapper-compat C1 persisted prefix across consecutive requests', () => {
  let db: Database.Database
  let store: EventStore
  let mockSessionManager: any
  let mockTurnMetrics: TurnMetrics

  beforeEach(async () => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    store = new EventStore(db)
    db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0, updated_at INTEGER)`,
    )
    store.append('session-1', {
      type: 'session.initialized',
      data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
    })
    store.append('session-1', {
      type: 'message.start',
      data: { messageId: 'user-1', role: 'user', content: 'hi', contextWindowId: 'w1' },
    })
    store.append('session-1', { type: 'message.done', data: { messageId: 'user-1' } })
    store.append('session-1', {
      type: 'message.start',
      data: {
        messageId: 'sum-1',
        role: 'assistant',
        content: '## Conversation Summary',
        contextWindowId: 'w1',
        isCompactionSummary: true,
      },
    })
    store.append('session-1', { type: 'message.done', data: { messageId: 'sum-1' } })
    vi.mocked(getEventStore).mockReturnValue(store)

    mockSessionManager = {
      enterPauseGate: vi.fn().mockResolvedValue('released'),
      requireSession: vi.fn().mockReturnValue({
        workdir: '/test',
        projectId: 'test-project',
        executionState: null,
        criteria: [],
        isRunning: false,
      }),
      getEffectiveWorkdir: vi.fn().mockReturnValue('/test'),
      getProjectWorkdir: vi.fn().mockReturnValue('/test'),
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 0,
        maxTokens: 128000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(128000),
      getCurrentModelSettings: vi.fn().mockReturnValue({ maxTokens: 4096 }),
      getModelCompactionThreshold: vi.fn().mockReturnValue(800000),
      setCurrentContextSize: vi.fn(),
      getCachedPrompt: vi.fn().mockReturnValue(undefined),
      setCachedPrompt: vi.fn(),
      getReadFiles: vi.fn().mockReturnValue({}),
    }
    mockTurnMetrics = {
      addToolTime: vi.fn(),
      addLLMCall: vi.fn(),
      addThinkingTime: vi.fn(),
      buildStats: vi.fn().mockReturnValue({ durationMs: 0 }),
    } as unknown as TurnMetrics

    const { getAllInstructions } = await import('../context/instructions.js')
    const { getEnabledSkillMetadata } = await import('../skills/registry.js')
    ;(getAllInstructions as any).mockResolvedValue({ content: 'test instructions', files: [] })
    ;(getEnabledSkillMetadata as any).mockResolvedValue([])
  })

  afterEach(() => {
    db.close()
  })

  it('persists a trailing user continuation before send and keeps consecutive requests as prefixes', async () => {
    const captured: RequestContextMessage[][] = []
    const client = createSequencedClient(
      [
        { type: 'text_delta', content: 'partial-a ' },
        { type: 'error', error: 'cut-1' },
      ],
      [
        { type: 'text_delta', content: 'partial-b ' },
        { type: 'error', error: 'cut-2' },
      ],
      [
        { type: 'text_delta', content: 'ok' },
        { type: 'done', response: { ...okToolResponse, content: 'ok', toolCalls: [] } },
      ],
    )

    const config: TopLevelLoopConfig = {
      mode: 'planner',
      append: (event) => store.append('session-1', event),
      sessionManager: mockSessionManager,
      sessionId: 'session-1',
      llmClient: client as never,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
      assembleRequest: vi.fn(async ({ messages }: { messages: RequestContextMessage[] }) => {
        captured.push(messages.map((m) => ({ ...m })))
        return { systemPrompt: 'sys', messages: [], tools: [] }
      }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: async () => getConversationMessages({ type: 'toplevel', sessionId: 'session-1' }),
      llmRetryPolicy: FAST_POLICY,
    }

    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    expect(result.failed).toBeUndefined()
    expect(captured.length).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < captured.length - 1; i++) {
      expect(isPrefix(snapshot(captured[i]!), snapshot(captured[i + 1]!))).toBe(true)
    }
    for (const req of captured) {
      const last = req.at(-1)
      if (last?.role === 'user' && last.content.includes('Continue your work')) {
        const stored = store
          .getEvents('session-1')
          .some((e) => e.type === 'message.start' && (e.data as { content?: string }).content === last.content)
        expect(stored).toBe(true)
      }
    }
  })
})
