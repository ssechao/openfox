import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import type { LLMToolDefinition } from '../llm/types.js'
import { createLLMClient } from '../llm/client.js'

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

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 5_000, maxAttempts: 6 }
const READ_FILE_TOOL: LLMToolDefinition = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
}

const INPUT_OVERFLOW_BODY = JSON.stringify({
  error: {
    message:
      'The client transcript exceeds this model context window (input_tokens=291082, max_context_tokens=262144).',
    code: 'cold_replay_context_exceeded',
  },
})

type Protocol = 'chat' | 'responses'

async function startInputOverflowServer(
  onHit: (body: Record<string, unknown>) => void,
): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString()
    })
    req.on('end', () => {
      onHit(JSON.parse(raw || '{}') as Record<string, unknown>)
      count += 1
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(INPUT_OVERFLOW_BODY)
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

function requestMaxTokens(protocol: Protocol, body: Record<string, unknown>): unknown {
  return protocol === 'chat' ? body['max_completion_tokens'] : body['max_output_tokens']
}

describe('wrapper-compat 2 — input overflow (cold_replay_context_exceeded)', () => {
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
      getModelCompactionThreshold: vi.fn().mockReturnValue(0.85),
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

  function seed(sessionId: string) {
    store.append(sessionId, {
      type: 'session.initialized',
      data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
    })
    store.append(sessionId, {
      type: 'message.start',
      data: { messageId: 'u1', role: 'user', content: 'hi', contextWindowId: 'w1' },
    })
    store.append(sessionId, { type: 'message.done', data: { messageId: 'u1' } })
  }

  it.each(['chat', 'responses'] as const)(
    '%s input overflow triggers a compaction attempt then fails visibly, never halves maxTokens',
    async (protocol) => {
      const sessionId = `sess-${protocol}-overflow`
      seed(sessionId)
      const captured: Array<Record<string, unknown>> = []
      const mock = await startInputOverflowServer((body) => {
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

      expect(result.failed).toBeDefined()
      expect(result.failed?.error).toContain('cold_replay_context_exceeded')
      expect(mock.hits()).toBe(2)
      for (const body of captured) {
        expect(requestMaxTokens(protocol, body)).toBe(4096)
      }
      const events = store.getEvents(sessionId)
      const compactionPrompts = events.filter(
        (e) => e.type === 'message.start' && (e.data as { messageKind?: string }).messageKind === 'auto-prompt',
      )
      expect(compactionPrompts.length).toBe(1)
      const visibleErrors = events.filter((e) => e.type === 'chat.error')
      expect(visibleErrors.length).toBeGreaterThanOrEqual(1)
    },
  )
})
