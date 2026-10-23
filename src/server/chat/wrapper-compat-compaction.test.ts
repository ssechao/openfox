import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import type { LLMToolDefinition } from '../llm/types.js'
import { createLLMClient } from '../llm/client.js'
import { buildSnapshotFromSessionState } from '../events/folding.js'

vi.mock('../events/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/index.js')>()
  return {
    ...actual,
    getCurrentContextWindowId: vi.fn((sessionId: string) => {
      const store = vi.mocked(getEventStore)()
      return store?.getCurrentWindowId(sessionId)
    }),
    getCurrentWindowMessageOptions: vi.fn((sessionId: string) => {
      const store = vi.mocked(getEventStore)()
      const contextWindowId = store?.getCurrentWindowId(sessionId)
      return contextWindowId ? { contextWindowId } : undefined
    }),
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
    agent: { toolTimeout: 5000 },
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

vi.mock('../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(async () => []),
  getSubAgents: vi.fn(() => []),
  resolveDefaultAgentId: vi.fn(() => 'planner'),
}))

vi.mock('./drain-queue.js', () => ({
  drainQueue: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('../db/settings.js', () => ({
  getSetting: vi.fn(),
  SETTINGS_KEYS: {
    AGENT_ALLOW_PARALLEL_SUB_AGENTS: 'agent.allowParallelSubAgents',
    LLM_DYNAMIC_SYSTEM_PROMPT: 'llm.dynamicSystemPrompt',
  },
}))

import { runTopLevelAgentLoop } from './agent-loop.js'
import { getConversationMessages } from './conversation-history.js'
import { getEventStore } from '../events/index.js'

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }
const READ_FILE_TOOL: LLMToolDefinition = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
}

const CHAT_OK_SSE = [
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }),
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
]

const RESPONSES_OK = [
  { type: 'response.created', response_id: 'resp_ok' },
  { type: 'response.output_text.delta', response_id: 'resp_ok', delta: 'done' },
  {
    type: 'response.completed',
    response_id: 'resp_ok',
    response: {
      id: 'resp_ok',
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  },
]

const RESPONSES_OK_NO_USAGE = [
  { type: 'response.created', response_id: 'resp_ok' },
  { type: 'response.output_text.delta', response_id: 'resp_ok', delta: 'done' },
  {
    type: 'response.completed',
    response_id: 'resp_ok',
    response: { id: 'resp_ok', status: 'completed', output: [] },
  },
]

type Protocol = 'chat' | 'responses'

function wireItems(protocol: Protocol, body: Record<string, unknown>): unknown[] {
  if (protocol === 'chat') return (body['messages'] as unknown[]) ?? []
  return (body['input'] as unknown[]) ?? []
}

async function startScriptedServer(
  protocol: Protocol,
  onHit: (body: Record<string, unknown>) => void,
  opts?: { noUsage?: boolean },
): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString()
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      onHit(body)
      count += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (protocol === 'chat') {
        for (const line of CHAT_OK_SSE) res.write(`data: ${line}\n\n`)
      } else {
        const events = opts?.noUsage ? RESPONSES_OK_NO_USAGE : RESPONSES_OK
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, hits: () => count }
}

function makeClient(port: number, protocol: Protocol) {
  if (protocol === 'responses') {
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
  return createLLMClient({
    llm: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeout: 5000,
      idleTimeout: 5000,
      model: 'gpt-5.6-sol',
      apiKey: 'test-key',
      backend: 'openai',
      apiProtocol: 'chat-completions',
    },
    context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
  } as never)
}

const W1_PAIRS = 12

describe('wrapper-compat 2 — compaction applied to the request body', () => {
  const servers: Server[] = []
  let db: Database.Database
  let store: EventStore
  let mockSessionManager: any
  let mockTurnMetrics: TurnMetrics

  afterAll(() => {
    for (const server of servers) server.close()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    store = new EventStore(db)
    db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0, updated_at INTEGER)`,
    )
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
      getLspManager: vi.fn().mockReturnValue(undefined),
      drainAsapMessages: vi.fn().mockReturnValue([]),
      getSessionProjectId: vi.fn().mockReturnValue('test-project'),
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

  function seedCompactedSession(sessionId: string, opts?: { withSnapshot?: boolean }) {
    store.append(sessionId, {
      type: 'session.initialized',
      data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
    })
    for (let i = 0; i < W1_PAIRS; i++) {
      store.append(sessionId, {
        type: 'message.start',
        data: { messageId: `w1-user-${i}`, role: 'user', content: `W1-USER-${i}`, contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'message.done', data: { messageId: `w1-user-${i}` } })
      store.append(sessionId, {
        type: 'message.start',
        data: {
          messageId: `w1-asst-${i}`,
          role: 'assistant',
          content: `W1-ASST-${i}`,
          contextWindowId: 'w1',
        },
      })
      store.append(sessionId, { type: 'message.done', data: { messageId: `w1-asst-${i}` } })
    }
    store.append(sessionId, {
      type: 'context.compacted',
      data: {
        closedWindowId: 'w1',
        newWindowId: 'w2',
        beforeTokens: 300000,
        afterTokens: 0,
        summary: 'W2-SUMMARY',
      },
    })
    store.append(sessionId, {
      type: 'message.start',
      data: {
        messageId: 'w2-summary',
        role: 'assistant',
        content: 'W2-SUMMARY',
        contextWindowId: 'w2',
        isCompactionSummary: true,
      },
    })
    store.append(sessionId, { type: 'message.done', data: { messageId: 'w2-summary' } })
    store.append(sessionId, {
      type: 'message.start',
      data: { messageId: 'w2-user-0', role: 'user', content: 'W2-USER-0', contextWindowId: 'w2' },
    })
    store.append(sessionId, { type: 'message.done', data: { messageId: 'w2-user-0' } })

    if (opts?.withSnapshot) {
      const events = store.getReplayEvents(sessionId)
      const snapshot = buildSnapshotFromSessionState({
        session: { mode: 'planner', phase: 'plan', isRunning: false, criteria: [] },
        events,
        latestSeq: events[events.length - 1]!.seq,
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshot })
      store.append(sessionId, {
        type: 'message.start',
        data: { messageId: 'w2-user-1', role: 'user', content: 'W2-USER-1', contextWindowId: 'w2' },
      })
      store.append(sessionId, { type: 'message.done', data: { messageId: 'w2-user-1' } })
    }
  }

  async function runOneTurn(protocol: Protocol, opts?: { withSnapshot?: boolean }) {
    const sessionId = `sess-${protocol}${opts?.withSnapshot ? '-snap' : ''}`
    seedCompactedSession(sessionId, opts)
    const captured: Array<Record<string, unknown>> = []
    const mock = await startScriptedServer(protocol, (body) => {
      captured.push(body)
    })
    servers.push(mock.server)
    const llmClient = makeClient(mock.port, protocol)
    const config: TopLevelLoopConfig = {
      mode: 'planner',
      append: (event) => store.append(sessionId, event),
      sessionManager: mockSessionManager,
      sessionId,
      llmClient: llmClient as never,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
      assembleRequest: vi.fn(async ({ messages }) => ({
        systemPrompt: 'sys',
        messages,
        tools: [READ_FILE_TOOL],
      })),
      getToolRegistry: () =>
        ({
          tools: [{ name: 'read_file' }],
          definitions: [READ_FILE_TOOL],
          execute: vi.fn(async () => ({ success: true, output: 'file-ok', durationMs: 1, truncated: false })),
        }) as any,
      getConversationMessages: async () => getConversationMessages({ type: 'toplevel', sessionId }),
      llmRetryPolicy: FAST_POLICY,
    }
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    return { result, captured, hits: mock.hits() }
  }

  it.each(['chat', 'responses'] as const)(
    '%s request body only carries the current window after compaction',
    async (protocol) => {
      const { result, captured, hits } = await runOneTurn(protocol)
      expect(result.failed).toBeUndefined()
      expect(hits).toBe(1)
      const body = JSON.stringify(captured[0])
      expect(body).toContain('W2-SUMMARY')
      expect(body).toContain('W2-USER-0')
      expect(body).not.toContain('W1-USER-')
      expect(body).not.toContain('W1-ASST-')
      expect(wireItems(protocol, captured[0]!).length).toBeLessThan(W1_PAIRS)
    },
  )

  it.each(['chat', 'responses'] as const)(
    '%s request body only carries the current window when a snapshot covers the compaction',
    async (protocol) => {
      const { result, captured, hits } = await runOneTurn(protocol, { withSnapshot: true })
      expect(result.failed).toBeUndefined()
      expect(hits).toBe(1)
      const body = JSON.stringify(captured[0])
      expect(body).toContain('W2-SUMMARY')
      expect(body).toContain('W2-USER-1')
      expect(body).not.toContain('W1-USER-')
      expect(body).not.toContain('W1-ASST-')
      expect(wireItems(protocol, captured[0]!).length).toBeLessThan(W1_PAIRS)
    },
  )

  it.each(['chat', 'responses'] as const)(
    '%s live auto-compaction: the request after compaction only carries the new window',
    async (protocol) => {
      const sessionId = `sess-${protocol}-live`
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
      })
      for (let i = 0; i < W1_PAIRS; i++) {
        store.append(sessionId, {
          type: 'message.start',
          data: { messageId: `w1-user-${i}`, role: 'user', content: `W1-USER-${i}`, contextWindowId: 'w1' },
        })
        store.append(sessionId, { type: 'message.done', data: { messageId: `w1-user-${i}` } })
        store.append(sessionId, {
          type: 'message.start',
          data: {
            messageId: `w1-asst-${i}`,
            role: 'assistant',
            content: `W1-ASST-${i}`,
            contextWindowId: 'w1',
          },
        })
        store.append(sessionId, { type: 'message.done', data: { messageId: `w1-asst-${i}` } })
      }

      let currentTokens = 1_000_000
      mockSessionManager.getContextState.mockImplementation(() => ({
        currentTokens,
        maxTokens: 1048576,
        compactionCount: 0,
        dangerZone: false,
        canCompact: true,
        dynamicContextChanged: false,
      }))
      mockSessionManager.getCurrentModelContext.mockReturnValue(1048576)
      mockSessionManager.getModelCompactionThreshold.mockReturnValue(0.85)

      const captured: Array<Record<string, unknown>> = []
      const mock = await startScriptedServer(protocol, (body) => {
        captured.push(body)
        if (captured.length === 3) currentTokens = 2000
      })
      servers.push(mock.server)
      const llmClient = makeClient(mock.port, protocol)
      const config: TopLevelLoopConfig = {
        mode: 'planner',
        append: (event) => store.append(sessionId, event),
        sessionManager: mockSessionManager,
        sessionId,
        llmClient: llmClient as never,
        statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
        assembleRequest: vi.fn(async ({ messages }) => ({
          systemPrompt: 'sys',
          messages,
          tools: [READ_FILE_TOOL],
        })),
        getToolRegistry: () =>
          ({
            tools: [{ name: 'read_file' }],
            definitions: [READ_FILE_TOOL],
            execute: vi.fn(async () => ({ success: true, output: 'file-ok', durationMs: 1, truncated: false })),
          }) as any,
        getConversationMessages: async () => getConversationMessages({ type: 'toplevel', sessionId }),
        llmRetryPolicy: FAST_POLICY,
      }
      const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
      expect(result.failed).toBeUndefined()
      expect(mock.hits()).toBeGreaterThanOrEqual(3)

      const compactionEvents = store.getEvents(sessionId).filter((e) => e.type === 'context.compacted')
      expect(compactionEvents.length).toBe(1)

      const summaryBody = JSON.stringify(captured[1])
      expect(summaryBody).toContain('W1-USER-0')

      const afterBody = JSON.stringify(captured[2])
      expect(afterBody).not.toContain('W1-USER-')
      expect(afterBody).not.toContain('W1-ASST-')
      expect(wireItems(protocol, captured[2]!).length).toBeLessThan(10)
    },
  )

  it.each(['chat', 'responses'] as const)(
    '%s provider without usage reporting: local estimate still drives compaction, applied to the request body',
    async (protocol) => {
      const sessionId = `sess-${protocol}-no-usage`
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
      })
      for (let i = 0; i < W1_PAIRS; i++) {
        store.append(sessionId, {
          type: 'message.start',
          data: {
            messageId: `w1-user-${i}`,
            role: 'user',
            content: `W1-USER-${i}-${'x'.repeat(200)}`,
            contextWindowId: 'w1',
          },
        })
        store.append(sessionId, { type: 'message.done', data: { messageId: `w1-user-${i}` } })
        store.append(sessionId, {
          type: 'message.start',
          data: {
            messageId: `w1-asst-${i}`,
            role: 'assistant',
            content: `W1-ASST-${i}-${'y'.repeat(200)}`,
            contextWindowId: 'w1',
          },
        })
        store.append(sessionId, { type: 'message.done', data: { messageId: `w1-asst-${i}` } })
      }

      let recordedTokens = 0
      mockSessionManager.setCurrentContextSize.mockImplementation(
        (_sid: string, promptTokens: number, completionTokens = 0) => {
          recordedTokens = promptTokens + completionTokens
        },
      )
      mockSessionManager.getContextState.mockImplementation(() => ({
        currentTokens: recordedTokens,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: true,
        dynamicContextChanged: false,
      }))
      mockSessionManager.getCurrentModelContext.mockReturnValue(200000)
      mockSessionManager.getModelCompactionThreshold.mockReturnValue(0.001)

      const captured: Array<Record<string, unknown>> = []
      const mock = await startScriptedServer(
        protocol,
        (body) => {
          captured.push(body)
        },
        { noUsage: true },
      )
      servers.push(mock.server)
      const llmClient = makeClient(mock.port, protocol)
      const config: TopLevelLoopConfig = {
        mode: 'planner',
        append: (event) => store.append(sessionId, event),
        sessionManager: mockSessionManager,
        sessionId,
        llmClient: llmClient as never,
        statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
        assembleRequest: vi.fn(async ({ messages }) => ({
          systemPrompt: 'sys',
          messages,
          tools: [READ_FILE_TOOL],
        })),
        getToolRegistry: () =>
          ({
            tools: [{ name: 'read_file' }],
            definitions: [READ_FILE_TOOL],
            execute: vi.fn(async () => ({ success: true, output: 'file-ok', durationMs: 1, truncated: false })),
          }) as any,
        getConversationMessages: async () => getConversationMessages({ type: 'toplevel', sessionId }),
        llmRetryPolicy: FAST_POLICY,
      }
      const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
      expect(result.failed).toBeUndefined()
      expect(mock.hits()).toBe(3)

      const compactionEvents = store.getEvents(sessionId).filter((e) => e.type === 'context.compacted')
      expect(compactionEvents.length).toBe(1)

      const afterBody = JSON.stringify(captured[2])
      expect(afterBody).not.toContain('W1-USER-')
      expect(afterBody).not.toContain('W1-ASST-')
      expect(wireItems(protocol, captured[2]!).length).toBeLessThan(10)
    },
  )
})
