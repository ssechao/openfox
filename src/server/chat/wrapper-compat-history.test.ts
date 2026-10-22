import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import { convertMessages } from '../llm/client-pure.js'
import { buildResponsesRequest } from '../llm/responses-native.js'
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from '../llm/openai-types.js'
import type { LLMToolDefinition } from '../llm/types.js'
import { createLLMClient } from '../llm/client.js'

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

vi.mock('../context/compactor.js', () => ({
  shouldCompact: vi.fn(() => false),
  appendCompactionPrompt: vi.fn(),
}))

vi.mock('../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(async () => []),
  getSubAgents: vi.fn(() => []),
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
import { ensureRequestNotEndingWithAssistant, getConversationMessages } from './conversation-history.js'
import { getEventStore } from '../events/index.js'

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }
const S_TEXT = 'Continue your work. Do NOT repeat what was already written.'
const READ_FILE_TOOL: LLMToolDefinition = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
}

const CHAT_TOOL_SSE = [
  JSON.stringify({
    id: 'c-tool',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '' } }],
        },
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'c-tool',
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] },
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({ id: 'c-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
]

const CHAT_OK_SSE = [
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }),
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
]

const RESPONSES_TOOL = [
  { type: 'response.created', response_id: 'resp_tool' },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read_file', arguments: '' },
  },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a.ts"}' },
  {
    type: 'response.completed',
    response_id: 'resp_tool',
    response: {
      id: 'resp_tool',
      status: 'completed',
      output: [],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    },
  },
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

type Protocol = 'chat' | 'responses'
type ScriptStep = 'cut' | 'tool' | 'ok'

function wireItems(protocol: Protocol, body: Record<string, unknown>): unknown[] {
  if (protocol === 'chat') return (body['messages'] as unknown[]) ?? []
  return (body['input'] as unknown[]) ?? []
}

function isPrefix(a: unknown[], b: unknown[]): boolean {
  return a.length <= b.length && a.every((item, i) => JSON.stringify(item) === JSON.stringify(b[i]))
}

function bodyContainsS(protocol: Protocol, body: Record<string, unknown>): boolean {
  return JSON.stringify(wireItems(protocol, body)).includes(S_TEXT)
}

function storeHasS(store: EventStore, sessionId: string, subAgentId?: string): { present: boolean; tagged: boolean } {
  const starts = store.getEvents(sessionId).filter((e) => {
    if (e.type !== 'message.start') return false
    const data = e.data as { content?: string; subAgentId?: string }
    return data.content === S_TEXT
  })
  const present = starts.length > 0
  const tagged = !subAgentId || starts.every((e) => (e.data as { subAgentId?: string }).subAgentId === subAgentId)
  return { present, tagged }
}

async function startScriptedServer(
  protocol: Protocol,
  script: ScriptStep[],
  onHit: (body: Record<string, unknown>) => void,
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
      const step = script[Math.min(count, script.length - 1)]!
      count += 1
      if (step === 'cut') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (protocol === 'chat') {
          res.write(
            `data: ${JSON.stringify({ id: 'c-cut', choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }] })}\n\n`,
          )
        } else {
          res.write(`data: ${JSON.stringify({ type: 'response.created', response_id: 'resp_cut' })}\n\n`)
          res.write(
            `data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_cut', delta: 'partial ' })}\n\n`,
          )
        }
        res.destroy()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (protocol === 'chat') {
        const lines = step === 'tool' ? CHAT_TOOL_SSE : CHAT_OK_SSE
        for (const line of lines) res.write(`data: ${line}\n\n`)
        res.write('data: [DONE]\n\n')
      } else {
        const events = step === 'tool' ? RESPONSES_TOOL : RESPONSES_OK
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
        res.write('data: [DONE]\n\n')
      }
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

describe('wrapper-compat C1 HTTP prefix, persisted S, cut then tool', () => {
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

  function seed(sessionId: string, subAgent?: { subAgentId: string; subAgentType: string }) {
    store.append(sessionId, {
      type: 'session.initialized',
      data: { projectId: 'p1', workdir: '/tmp', contextWindowId: 'w1' },
    })
    store.append(sessionId, {
      type: 'message.start',
      data: {
        messageId: 'user-1',
        role: 'user',
        content: 'hi',
        contextWindowId: 'w1',
        ...(subAgent ?? {}),
      },
    })
    store.append(sessionId, { type: 'message.done', data: { messageId: 'user-1' } })
    store.append(sessionId, {
      type: 'message.start',
      data: {
        messageId: 'sum-1',
        role: 'assistant',
        content: '## Conversation Summary',
        contextWindowId: 'w1',
        isCompactionSummary: true,
        ...(subAgent ?? {}),
      },
    })
    store.append(sessionId, { type: 'message.done', data: { messageId: 'sum-1' } })
  }

  async function runCutThenTool(protocol: Protocol, subAgent?: { subAgentId: string; subAgentType: string }) {
    const sessionId = `sess-${protocol}${subAgent ? '-sub' : ''}`
    seed(sessionId, subAgent)
    const captured: Array<{ body: Record<string, unknown>; sAtSend: { present: boolean; tagged: boolean } }> = []
    const mock = await startScriptedServer(protocol, ['cut', 'cut', 'tool', 'ok'], (body) => {
      captured.push({
        body,
        sAtSend: storeHasS(store, sessionId, subAgent?.subAgentId),
      })
    })
    servers.push(mock.server)
    const llmClient = makeClient(mock.port, protocol)
    const scope = subAgent
      ? { type: 'subagent' as const, sessionId, ...subAgent }
      : { type: 'toplevel' as const, sessionId }
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
      getConversationMessages: async () => getConversationMessages(scope),
      llmRetryPolicy: FAST_POLICY,
      ...(subAgent ? { subAgentMetadata: subAgent } : {}),
    }
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
    return { result, captured, hits: mock.hits() }
  }

  it.each(['chat', 'responses'] as const)(
    '%s consecutive HTTP bodies are prefixes; S is in the store at send; cut then tool keeps S',
    async (protocol) => {
      const { result, captured, hits } = await runCutThenTool(protocol)
      expect(result.failed).toBeUndefined()
      expect(hits).toBeGreaterThanOrEqual(4)
      expect(captured.length).toBe(hits)
      const wires = captured.map((c) => wireItems(protocol, c.body))
      for (let i = 0; i < wires.length - 1; i++) {
        expect(isPrefix(wires[i]!, wires[i + 1]!)).toBe(true)
      }
      for (const hit of captured) {
        expect(hit.sAtSend.present).toBe(true)
        expect(bodyContainsS(protocol, hit.body)).toBe(true)
      }
      const toolHit = captured[2]!
      const afterTool = captured[3]!
      expect(bodyContainsS(protocol, toolHit.body)).toBe(true)
      expect(bodyContainsS(protocol, afterTool.body)).toBe(true)
    },
  )

  it('scopes S with sub-agent tags so a cut-then-tool prefix survives rebuild', async () => {
    const subAgent = { subAgentId: 'sub-1', subAgentType: 'explorer' }
    const { result, captured, hits } = await runCutThenTool('responses', subAgent)
    expect(result.failed).toBeUndefined()
    expect(hits).toBeGreaterThanOrEqual(4)
    for (const hit of captured) {
      expect(hit.sAtSend.present).toBe(true)
      expect(hit.sAtSend.tagged).toBe(true)
      expect(bodyContainsS('responses', hit.body)).toBe(true)
    }
    const wires = captured.map((c) => wireItems('responses', c.body))
    for (let i = 0; i < wires.length - 1; i++) {
      expect(isPrefix(wires[i]!, wires[i + 1]!)).toBe(true)
    }
    const stored = store
      .getEvents('sess-responses-sub')
      .filter((e) => e.type === 'message.start' && (e.data as { content?: string }).content === S_TEXT)
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every((e) => (e.data as { subAgentId?: string }).subAgentId === 'sub-1')).toBe(true)
  })
})
