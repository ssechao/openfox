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
})
