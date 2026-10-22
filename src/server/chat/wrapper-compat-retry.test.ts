import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import { evaluateLLMRetry, isRetryableLlmHttpStatus, MAX_LLM_RETRY_AFTER_MS, parseLlmHttpError } from './stream-pure.js'
import { parseRetryAfterMs } from '../llm/http-shared.js'

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
const POLICY = {
  backoffMs: [1000, 5000, 30_000],
  minIntervalMs: 60_000,
  maxDurationMs: 30 * 60_000,
  maxAttempts: 40,
}

async function startStatusServer(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      count += 1
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, port, hits: () => count }
}

describe('wrapper-compat C2 retry policy helpers', () => {
  it('retries only 408, 409, 429 and 5xx', () => {
    expect(isRetryableLlmHttpStatus(undefined)).toBe(true)
    expect(isRetryableLlmHttpStatus(408)).toBe(true)
    expect(isRetryableLlmHttpStatus(409)).toBe(true)
    expect(isRetryableLlmHttpStatus(429)).toBe(true)
    expect(isRetryableLlmHttpStatus(500)).toBe(true)
    expect(isRetryableLlmHttpStatus(503)).toBe(true)
    expect(isRetryableLlmHttpStatus(400)).toBe(false)
    expect(isRetryableLlmHttpStatus(401)).toBe(false)
    expect(isRetryableLlmHttpStatus(404)).toBe(false)
    expect(isRetryableLlmHttpStatus(422)).toBe(false)
  })

  it('parses Retry-After delta-seconds and HTTP-date', () => {
    expect(parseRetryAfterMs('12')).toBe(12_000)
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfterMs('nope')).toBeUndefined()
  })

  it('caps Retry-After at 120s and still honors the attempt backstop', () => {
    const now = 1_000_000
    const withHeader = evaluateLLMRetry(1, now, now, POLICY, { retryAfterMs: 3600_000 })
    expect(withHeader.retry).toBe(true)
    if (withHeader.retry) expect(withHeader.delayMs).toBe(MAX_LLM_RETRY_AFTER_MS)
    expect(MAX_LLM_RETRY_AFTER_MS).toBe(120_000)
    expect(evaluateLLMRetry(40, now, now, POLICY, { retryAfterMs: 1000 })).toEqual({ retry: false })
  })

  it('parses status and retry-after-ms from the LLM error string', () => {
    expect(parseLlmHttpError('HTTP 429 (retry-after-ms=5000): slow down')).toEqual({
      status: 429,
      retryAfterMs: 5000,
    })
    expect(parseLlmHttpError('HTTP 400: invalid_request_error')).toEqual({ status: 400 })
  })
})

describe('wrapper-compat C2 agent loop HTTP status', () => {
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

  async function runAgainst(status: number, body: string, headers: Record<string, string> = {}) {
    const mock = await startStatusServer(status, body, headers)
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
      sessionId: `retry-${status}`,
      llmClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: FAST_POLICY,
    }
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    return { result, events, relayed, hits: mock.hits() }
  }

  it('does not retry a deterministic 400 and surfaces the error', async () => {
    const { result, events, relayed, hits } = await runAgainst(
      400,
      JSON.stringify({ error: { message: 'pending_call_history_mismatch', type: 'invalid_request_error' } }),
    )
    expect(hits).toBe(1)
    expect(result.failed?.error).toMatch(/HTTP 400/)
    expect(relayed.find((m: any) => m?.type === 'chat.llm_retry_failed')?.payload.error).toMatch(/HTTP 400/)
    expect(events.filter((e: any) => e?.type === 'chat.done' && e.data.reason === 'complete')).toHaveLength(0)
  })

  it('does not retry 404 or 422', async () => {
    for (const status of [404, 422]) {
      const { result, hits } = await runAgainst(status, JSON.stringify({ error: { message: 'nope' } }))
      expect(hits).toBe(1)
      expect(result.failed?.error).toMatch(new RegExp(`HTTP ${status}`))
    }
  })
})

type HitSpec = { status: number; body: string; headers?: Record<string, string> } | { sse: unknown[] }

const SUCCESS_TURN = [
  { type: 'response.created', response_id: 'resp_ok' },
  { type: 'response.output_text.delta', response_id: 'resp_ok', delta: 'ok' },
  {
    type: 'response.completed',
    response_id: 'resp_ok',
    response: {
      id: 'resp_ok',
      status: 'completed',
      output: [],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    },
  },
]

async function startScriptedStatusServer(script: HitSpec[]): Promise<{
  server: Server
  port: number
  hits: () => number
  hitAt: () => number[]
  bodies: () => Record<string, unknown>[]
}> {
  let count = 0
  const hitAt: number[] = []
  const bodies: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString()
    })
    req.on('end', () => {
      hitAt.push(Date.now())
      try {
        bodies.push(JSON.parse(raw || '{}') as Record<string, unknown>)
      } catch {
        bodies.push({ raw })
      }
      const spec = script[Math.min(count, script.length - 1)]!
      count += 1
      if ('sse' in spec) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const event of spec.sse) {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(spec.status, { 'Content-Type': 'application/json', ...(spec.headers ?? {}) })
      res.end(spec.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, port, hits: () => count, hitAt: () => hitAt, bodies: () => bodies }
}

describe('wrapper-compat C2 context_length exception and in-loop Retry-After', () => {
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

  function makeClient(port: number) {
    return createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${port}`,
        timeout: 5000,
        idleTimeout: 5000,
        model: 'gpt-5.6-luna',
        apiKey: 'test-key',
        backend: 'opencode-go',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)
  }

  async function runScript(
    script: HitSpec[],
    policy: { backoffMs: number[]; minIntervalMs: number; maxDurationMs: number; maxAttempts: number } = FAST_POLICY,
  ) {
    const mock = await startScriptedStatusServer(script)
    servers.push(mock.server)
    const append = vi.fn()
    const onMessage = vi.fn()
    const config: TopLevelLoopConfig = {
      mode: 'builder',
      append,
      onMessage,
      sessionManager: mockSessionManager,
      sessionId: `retry-script-${servers.length}`,
      llmClient: makeClient(mock.port),
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'gpt-5.6-luna' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: policy,
    }
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    const events = append.mock.calls.map((c: any[]) => c[0])
    const relayed = onMessage.mock.calls.map((c: any[]) => c[0])
    return { result, events, relayed, hits: mock.hits(), hitAt: mock.hitAt(), bodies: mock.bodies() }
  }

  it('retries HTTP 400 context_length up to 3 times because maxTokens changes, then fails visibly', async () => {
    const body = JSON.stringify({
      error: {
        message: "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens.",
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    })
    const { result, events, relayed, hits, bodies } = await runScript(
      Array.from({ length: 6 }, () => ({ status: 400, body })),
    )
    expect(hits).toBe(4)
    const maxTokens = bodies.map((b) => b['max_output_tokens'] as number)
    expect(maxTokens).toEqual([4096, 2048, 1024, 512])
    expect(result.failed?.error).toMatch(/HTTP 400/)
    expect(result.failed?.error).toMatch(/context length/i)
    expect(relayed.find((m: any) => m?.type === 'chat.llm_retry_failed')?.payload.error).toMatch(/HTTP 400/)
    expect(events.filter((e: any) => e?.type === 'chat.done' && e.data.reason === 'complete')).toHaveLength(0)
  })

  it('waits in-loop for a 429 Retry-After delta-seconds before the next HTTP hit', async () => {
    const { result, hits, hitAt } = await runScript([
      { status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), headers: { 'Retry-After': '1' } },
      { sse: SUCCESS_TURN },
    ])
    expect(hits).toBe(2)
    expect(result.failed).toBeUndefined()
    expect(hitAt[1]! - hitAt[0]!).toBeGreaterThanOrEqual(900)
  })

  it('waits in-loop for a 503 Retry-After HTTP-date before the next HTTP hit', async () => {
    const when = new Date(Date.now() + 2500).toUTCString()
    const { result, hits, hitAt } = await runScript([
      { status: 503, body: JSON.stringify({ error: { message: 'unavailable' } }), headers: { 'Retry-After': when } },
      { sse: SUCCESS_TURN },
    ])
    expect(hits).toBe(2)
    expect(result.failed).toBeUndefined()
    expect(hitAt[1]! - hitAt[0]!).toBeGreaterThanOrEqual(800)
  })

  it('uses the backoff ladder for 429 when Retry-After is absent', async () => {
    const policy = { backoffMs: [400], minIntervalMs: 400, maxDurationMs: 60_000, maxAttempts: 40 }
    const { result, hits, hitAt } = await runScript(
      [{ status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) }, { sse: SUCCESS_TURN }],
      policy,
    )
    expect(hits).toBe(2)
    expect(result.failed).toBeUndefined()
    const gap = hitAt[1]! - hitAt[0]!
    expect(gap).toBeGreaterThanOrEqual(300)
    expect(gap).toBeLessThan(900)
  })
})
