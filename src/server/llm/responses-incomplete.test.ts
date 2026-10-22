import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TurnMetrics } from '../chat/stream-pure.js'
import type { TopLevelLoopConfig } from '../chat/agent-loop.js'
import { parseResponsesEvent, parseResponsesResponse } from './responses-native.js'
import { LLMError } from '../utils/errors.js'

vi.mock('../events/store.js', () => ({
  getEventStore: vi.fn(),
}))

vi.mock('../events/index.js', () => ({
  getCurrentContextWindowId: vi.fn(() => undefined),
  getCurrentWindowMessageOptions: vi.fn(() => undefined),
}))

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

vi.mock('../chat/conversation-history.js', () => ({
  getConversationMessages: vi.fn().mockReturnValue([]),
  ensureRequestNotEndingWithAssistant: vi.fn((messages: unknown) => messages),
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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runTopLevelAgentLoop } from '../chat/agent-loop.js'
import { createLLMClient } from './client.js'

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }

const INCOMPLETE_TURN = [
  { type: 'response.created', response_id: 'resp_inc' },
  { type: 'response.output_text.delta', response_id: 'resp_inc', delta: 'Hello' },
  {
    type: 'response.incomplete',
    response_id: 'resp_inc',
    response: {
      id: 'resp_inc',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    },
  },
]

const INCOMPLETE_WITH_TOOLS = [
  { type: 'response.created', response_id: 'resp_inc_tools' },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read_file', arguments: '' },
  },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a.ts"}' },
  {
    type: 'response.incomplete',
    response_id: 'resp_inc_tools',
    response: {
      id: 'resp_inc_tools',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
      ],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    },
  },
]

const INCOMPLETE_SUMMARY = [
  { type: 'response.created', response_id: 'resp_inc_sum' },
  { type: 'response.output_text.delta', response_id: 'resp_inc_sum', delta: '## Conversation Summary\nPartial' },
  {
    type: 'response.incomplete',
    response_id: 'resp_inc_sum',
    response: {
      id: 'resp_inc_sum',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '## Conversation Summary\nPartial' }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    },
  },
]

const COMPLETED_SUMMARY = [
  { type: 'response.created', response_id: 'resp_sum' },
  { type: 'response.output_text.delta', response_id: 'resp_sum', delta: '## Conversation Summary\nDone' },
  {
    type: 'response.completed',
    response_id: 'resp_sum',
    response: {
      id: 'resp_sum',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '## Conversation Summary\nDone' }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    },
  },
]

async function startResponsesSequence(
  streams: unknown[][],
): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const events = streams[Math.min(count, streams.length - 1)]!
      count += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, port, hits: () => count }
}

describe('wrapper-compat C3 response.incomplete mapping', () => {
  it('maps incomplete status to length even without incomplete_details', () => {
    const response = parseResponsesResponse({
      id: 'resp_3',
      status: 'incomplete',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cut' }] }],
    })
    expect(response.choices[0]?.finish_reason).toBe('length')
  })

  it('maps incomplete with a non-max_output_tokens reason to length, never stop', () => {
    const response = parseResponsesResponse({
      id: 'resp_4',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
    })
    expect(response.choices[0]?.finish_reason).toBe('length')
    expect(response.choices[0]?.finish_reason).not.toBe('stop')
  })

  it('treats the response.incomplete SSE event as a length finish', () => {
    const chunk = parseResponsesEvent({
      type: 'response.incomplete',
      response_id: 'resp_inc',
      response: { id: 'resp_inc', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    })
    expect(chunk).not.toBeNull()
    expect((chunk as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason).toBe('length')
  })

  it('still raises response.failed as a visible LLM error', () => {
    expect(() =>
      parseResponsesEvent({
        type: 'response.failed',
        response: { id: 'resp_5', status: 'failed', output: [], error: { message: 'Codex Responses backend failed.' } },
      }),
    ).toThrow(new LLMError('Codex Responses backend failed.'))
  })
})

describe('wrapper-compat C3 agent loop surfaces incomplete in chat', () => {
  const servers: Server[] = []
  let mockSessionManager: any
  let mockTurnMetrics: TurnMetrics

  afterAll(() => {
    for (const server of servers) server.close()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
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

  it('does not end an incomplete Responses stream as chat.done complete', async () => {
    const mock = await startResponsesSequence([INCOMPLETE_TURN])
    servers.push(mock.server)
    const llmClient = createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        timeout: 5000,
        idleTimeout: 5000,
        model: 'gpt-5.6-luna',
        apiKey: 'test-key',
        backend: 'opencode-go',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)
    const append = vi.fn()
    const onMessage = vi.fn()
    const config: TopLevelLoopConfig = {
      mode: 'builder',
      append,
      onMessage,
      sessionManager: mockSessionManager,
      sessionId: 'responses-incomplete',
      llmClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: FAST_POLICY,
    }
    await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    const chatDone = events.filter((e: any) => e?.type === 'chat.done')
    expect(chatDone.some((e: any) => e.data.reason === 'complete')).toBe(false)
    expect(
      chatDone.some((e: any) => e.data.reason === 'truncated') ||
        relayed.some((m: any) => m?.type === 'chat.done' && m.payload?.reason === 'truncated') ||
        relayed.some((m: any) => m?.type === 'chat.llm_retry') ||
        JSON.stringify(events).toLowerCase().includes('truncat'),
    ).toBe(true)
  })

  it('surfaces incomplete with tools as truncation and does not execute the tools', async () => {
    const mock = await startResponsesSequence([INCOMPLETE_WITH_TOOLS])
    servers.push(mock.server)
    const execute = vi.fn()
    const llmClient = createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        timeout: 5000,
        idleTimeout: 5000,
        model: 'gpt-5.6-luna',
        apiKey: 'test-key',
        backend: 'opencode-go',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)
    const append = vi.fn()
    const onMessage = vi.fn()
    const config: TopLevelLoopConfig = {
      mode: 'builder',
      append,
      onMessage,
      sessionManager: mockSessionManager,
      sessionId: 'incomplete-with-tools',
      llmClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({
        systemPrompt: 'sys',
        messages: [],
        tools: [
          { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } },
        ],
      }),
      getToolRegistry: () => ({ tools: [{ name: 'read_file' }], definitions: [], execute }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: FAST_POLICY,
    }
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    expect(execute).not.toHaveBeenCalled()
    expect(result.failed).toBeUndefined()
    expect(events.some((e: any) => e?.type === 'chat.done' && e.data.reason === 'complete')).toBe(false)
    expect(
      events.some((e: any) => e?.type === 'chat.done' && e.data.reason === 'truncated') ||
        relayed.some((m: any) => m?.type === 'chat.done' && m.payload?.reason === 'truncated'),
    ).toBe(true)
  })

  it('does not commit a truncated compaction summary; previous context is kept', async () => {
    const mock = await startResponsesSequence([INCOMPLETE_SUMMARY])
    servers.push(mock.server)
    const rebuildCachedContext = vi.fn()
    const llmClient = createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        timeout: 5000,
        idleTimeout: 5000,
        model: 'gpt-5.6-luna',
        apiKey: 'test-key',
        backend: 'opencode-go',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)
    const append = vi.fn()
    const onMessage = vi.fn()
    const config: TopLevelLoopConfig = {
      mode: 'builder',
      append,
      onMessage,
      sessionManager: mockSessionManager,
      sessionId: 'incomplete-compaction',
      llmClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: FAST_POLICY,
      initialCompacting: true,
      rebuildCachedContext,
    }
    await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    expect(events.filter((e: any) => e?.type === 'context.compacted')).toHaveLength(0)
    expect(rebuildCachedContext).not.toHaveBeenCalled()
    expect(events.some((e: any) => e?.type === 'chat.done' && e.data.reason === 'complete')).toBe(false)
    expect(
      events.some((e: any) => e?.type === 'chat.done' && e.data.reason === 'truncated') ||
        relayed.some((m: any) => m?.type === 'chat.done' && m.payload?.reason === 'truncated'),
    ).toBe(true)
    expect(JSON.stringify(events)).toMatch(/keeping the previous context|tronqu/)
  })

  it('signals truncation before auto-compaction when incomplete crosses the threshold', async () => {
    const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
    ;(shouldCompact as any).mockReturnValueOnce(true)
    const mock = await startResponsesSequence([INCOMPLETE_TURN, COMPLETED_SUMMARY])
    servers.push(mock.server)
    const llmClient = createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        timeout: 5000,
        idleTimeout: 5000,
        model: 'gpt-5.6-luna',
        apiKey: 'test-key',
        backend: 'opencode-go',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)
    const append = vi.fn()
    const onMessage = vi.fn()
    const config: TopLevelLoopConfig = {
      mode: 'builder',
      append,
      onMessage,
      sessionManager: mockSessionManager,
      sessionId: 'incomplete-then-compact',
      llmClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: FAST_POLICY,
    }
    await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    const truncIdx = events.findIndex(
      (e: any) =>
        (e?.type === 'message.start' &&
          typeof e.data?.content === 'string' &&
          /truncated|tronqu/i.test(e.data.content)) ||
        e?.type === 'chat.error',
    )
    const compactIdx = events.findIndex((e: any) => e?.type === 'context.compacted')
    expect(truncIdx).toBeGreaterThanOrEqual(0)
    expect(
      relayed.some((m: any) => m?.type === 'chat.llm_retry') ||
        events.some((e: any) => e?.type === 'message.done' && e.data?.partial),
    ).toBe(true)
    expect(appendCompactionPrompt).toHaveBeenCalled()
    expect(compactIdx).toBeGreaterThan(truncIdx)
    expect(events.some((e: any) => e?.type === 'chat.done' && e.data.reason === 'complete')).toBe(true)
  })
})

async function startJsonServer(payload: unknown): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      count += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, hits: () => count }
}

describe('wrapper-compat C3 incomplete beats tool_calls (non-stream)', () => {
  const servers: Server[] = []

  afterAll(() => {
    for (const server of servers) server.close()
  })

  it('maps incomplete with function_call output to length, never tool_calls', () => {
    const response = parseResponsesResponse({
      id: 'resp_inc_tools',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
      ],
    })
    expect(response.choices[0]?.finish_reason).toBe('length')
    expect(response.choices[0]?.finish_reason).not.toBe('tool_calls')
    expect(response.choices[0]?.message['tool_calls']).toHaveLength(1)
  })

  it('maps a non-stream incomplete HTTP body with tools to finishReason length', async () => {
    const mock = await startJsonServer({
      id: 'resp_ns',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cut' }] },
      ],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    })
    servers.push(mock.server)
    const llmClient = createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        timeout: 5000,
        idleTimeout: 5000,
        model: 'gpt-5.6-luna',
        apiKey: 'test-key',
        backend: 'opencode-go',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)
    const result = await llmClient.complete({
      sessionId: 'incomplete-nonstream',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(mock.hits()).toBe(1)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls?.length).toBe(1)
  })
})
