import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'

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

vi.mock('./conversation-history.js', () => ({
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

import { runTopLevelAgentLoop } from './agent-loop.js'
import { createLLMClient } from '../llm/client.js'

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }
const SINGLE_ATTEMPT_POLICY = { backoffMs: [0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 1 }

const WRAPPER_BACKEND_FAILURE = [
  {
    type: 'response.created',
    response: { id: 'resp_failed', object: 'response', status: 'in_progress', output: [], usage: null },
  },
  {
    type: 'response.failed',
    sequence_number: 1,
    response: {
      id: 'resp_failed',
      object: 'response',
      status: 'failed',
      output: [],
      usage: null,
      error: {
        code: 'backend_error',
        type: 'server_error',
        status: 503,
        message: 'Codex Responses backend failed.',
        should_retry: true,
      },
    },
  },
]

const RECOVERED_TURN = [
  { type: 'response.created', response_id: 'resp_ok' },
  { type: 'response.output_text.delta', response_id: 'resp_ok', delta: 'Reprise' },
  {
    type: 'response.completed',
    response_id: 'resp_ok',
    response: {
      id: 'resp_ok',
      status: 'completed',
      output: [],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
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

describe('agent loop against a Responses backend that reports response.failed', () => {
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

  async function runAgainst(streams: unknown[][], sessionId: string, llmRetryPolicy: typeof FAST_POLICY) {
    const mock = await startResponsesSequence(streams)
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
      sessionId,
      llmClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy,
    }
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    return { result, events, relayed, hits: mock.hits() }
  }

  it('retries the request instead of ending the turn silently as complete', async () => {
    const { result, events, relayed, hits } = await runAgainst(
      [WRAPPER_BACKEND_FAILURE, RECOVERED_TURN],
      'responses-failed-retry',
      FAST_POLICY,
    )

    expect(hits).toBe(2)
    expect(result.failed).toBeUndefined()
    expect(relayed.find((m: any) => m?.type === 'chat.llm_retry')?.payload.error).toBe(
      'Codex Responses backend failed.',
    )
    const deltas = events.filter((e: any) => e?.type === 'message.delta').map((e: any) => e.data.content)
    expect(deltas).toEqual(['Reprise'])
    const chatDone = events.filter((e: any) => e?.type === 'chat.done')
    expect(chatDone).toHaveLength(1)
    expect(chatDone[0].data.reason).toBe('complete')
  })

  it('reports the failure to the caller once the retry window is exhausted', async () => {
    const { result, events, relayed, hits } = await runAgainst(
      [WRAPPER_BACKEND_FAILURE],
      'responses-failed-exhausted',
      SINGLE_ATTEMPT_POLICY,
    )

    expect(hits).toBe(1)
    expect(result.failed?.error).toBe('Codex Responses backend failed.')
    expect(relayed.find((m: any) => m?.type === 'chat.llm_retry_failed')?.payload.error).toBe(
      'Codex Responses backend failed.',
    )
    expect(events.filter((e: any) => e?.type === 'chat.done')).toHaveLength(0)
  })
})
