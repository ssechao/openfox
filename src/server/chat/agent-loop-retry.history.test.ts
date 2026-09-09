/**
 * Agent Loop – Retry History (real EventStore + real streamLLMPure)
 *
 * Drives runTopLevelAgentLoop end-to-end against a real EventStore with a
 * scripted LLM client, verifying the two failure shapes end-to-end:
 *   - Case 1: request fails before content → nothing written; retry succeeds.
 *   - Case 2: mid-stream failure → partial kept + exactly one continuation,
 *     then the retry continues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { LLMStreamEvent, LLMCompletionResponse } from '../llm/types.js'
import { EventStore } from '../events/store.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ToolContext } from '../tools/types.js'
import { createLLMClient } from '../llm/client.js'
import { applyEvents } from '../events/apply-events.js'
import { buildContextMessagesFromStoredEvents } from '../events/folding.js'
import { runCommandTool } from '../tools/shell.js'
import { createStreamLifecycleTracker } from './terminal-cleanup.js'
import type { SnapshotMessage } from '../events/types.js'

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
    agent: { toolTimeout: 10000 },
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

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }

const okResponse: LLMCompletionResponse = {
  id: 'resp-ok',
  content: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
}

/** LLM client serving one event batch per stream() call (attempt). */
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
      for (const event of events) {
        yield event
      }
    },
  }
}

describe('agent loop retry history (real EventStore)', () => {
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
    store.append('session-1', { type: 'message.start', data: { messageId: 'user-1', role: 'user', content: 'hi' } })
    store.append('session-1', { type: 'message.done', data: { messageId: 'user-1' } })

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
      getLspManager: vi.fn(),
      drainAsapMessages: vi.fn(() => []),
    }
    mockTurnMetrics = {
      addToolTime: vi.fn(),
      addLLMCall: vi.fn(),
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

  function makeConfig(overrides?: Partial<TopLevelLoopConfig>): TopLevelLoopConfig {
    return {
      mode: 'planner',
      append: (event) => store.append('session-1', event),
      sessionManager: mockSessionManager,
      sessionId: 'session-1',
      llmClient: { getModel: () => 'test-model' } as never,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [], tools: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      ...overrides,
    }
  }

  it('aborts and closes the producer when a persistence callback throws during a flush', async () => {
    let requestSignal: AbortSignal | undefined
    let release = () => {}
    let closed = false
    const client = createSequencedClient([])
    const stream = async function* (request: { signal?: AbortSignal }): AsyncGenerator<LLMStreamEvent> {
      requestSignal = request.signal
      try {
        yield { type: 'thinking_delta', content: 'partial thinking' }
        await new Promise<void>((resolve) => {
          release = resolve
          request.signal?.addEventListener('abort', resolve.bind(null, undefined), { once: true })
        })
      } finally {
        closed = true
      }
    }
    try {
      await expect(
        runTopLevelAgentLoop(
          makeConfig({
            llmClient: { ...client, stream } as never,
            append: (event) => {
              if (event.type === 'message.thinking') throw new Error('persistence callback failed')
              store.append('session-1', event)
            },
          }),
          mockTurnMetrics,
        ),
      ).rejects.toThrow('persistence callback failed')
      expect(requestSignal?.aborted).toBe(true)
      expect(closed).toBe(true)
    } finally {
      release()
    }
  })

  // Real HTTP -> parser -> stream consumer -> SQLite -> tool dispatch -> next
  // request. Only model responses and the first controlled tool error are scripted.
  async function runFixture(bodies: string[], execute = vi.fn()) {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        requests.push(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(bodies[requests.length - 1] ?? frame({}, 'stop'))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const client = createLLMClient({
        llm: {
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          model: 'qwen3-32b',
          backend: 'vllm',
          timeout: 10000,
          idleTimeout: 10000,
        },
        context: { maxTokens: 128000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      } as never)
      const tracker = createStreamLifecycleTracker()
      const append: TopLevelLoopConfig['append'] = (event) => {
        store.append('session-1', event)
        tracker.observe(event)
      }
      append({ type: 'running.changed', data: { isRunning: true } })
      let outcome
      try {
        outcome = await runTopLevelAgentLoop(
          makeConfig({
            llmClient: client,
            append,
            llmRetryPolicy: { ...FAST_POLICY, maxAttempts: 1 },
            getToolRegistry: () => ({ tools: [], definitions: [], execute }),
            getConversationMessages: async () =>
              buildContextMessagesFromStoredEvents(store.getEvents('session-1')) as never,
            assembleRequest: async (input) => ({ systemPrompt: 'local fixture', messages: input.messages, tools: [] }),
          }),
          mockTurnMetrics,
        )
      } finally {
        tracker.finalize(append)
        append({ type: 'running.changed', data: { isRunning: false } })
      }
      return {
        requests,
        outcome,
        messages: applyEvents<SnapshotMessage>([], store.getEvents('session-1'), { timestampAsNumber: true }),
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
  }

  function toolFrames(name: string, args: string): string {
    const parts = [frame({ tool_calls: [{ index: 0, id: `call-${name}`, function: { name, arguments: '' } }] })]
    for (let i = 0; i < args.length; i += 89) {
      parts.push(frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 89) } }] }))
    }
    return parts.join('') + frame({}, 'tool_calls')
  }

  it('completes a long thinking/tool failure/recovery session with intact arguments and resumable state', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'openfox-long-session-'))
    try {
      mockSessionManager.getEffectiveWorkdir.mockReturnValue(workdir)
      mockSessionManager.getProjectWorkdir.mockReturnValue(workdir)
      for (let i = 0; i < 673; i++) {
        store.append('session-1', {
          type: 'message.start',
          data: { messageId: `history-${i}`, role: 'user', content: `History ${i}` },
        })
      }
      const thinking = '**Inspect** Rust references &self and &mut.\n'.repeat(1600)
      const content = 'fn borrow(&self) { let text = "quoted \\"value\\""; }\n'.repeat(400)
      const args = { path: 'widget.rs', content }
      expect(Buffer.byteLength(JSON.stringify(args))).toBeGreaterThan(15 * 1024)
      const command = `cat <<'RUST' > widget.rs\n${content}RUST\n`
      const execute = vi.fn(async (name: string, arguments_: Record<string, unknown>, context: ToolContext) => {
        if (name === 'write_file') {
          expect(arguments_).toEqual(args)
          return { success: false, error: 'controlled fixture failure', durationMs: 0, truncated: false }
        }
        return runCommandTool.execute(arguments_, context)
      })
      const first = Array.from({ length: 4000 }, (_, i) =>
        frame({ reasoning_content: thinking.slice(i * 17, (i + 1) * 17) }),
      ).join('')
      const firstThinking = thinking.slice(0, 68000)
      const completion = await runFixture(
        [
          first + toolFrames('write_file', JSON.stringify(args)),
          toolFrames('run_command', JSON.stringify({ command })),
          frame({ content: 'Recovered successfully' }, 'stop'),
        ],
        execute,
      )
      expect(completion.outcome?.failed).toBeUndefined()
      expect(completion.requests).toHaveLength(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(
        completion.requests[1]?.messages.some(
          (message) => message.role === 'tool' && message.content.includes('controlled fixture failure'),
        ),
      ).toBe(true)
      expect(await readFile(join(workdir, 'widget.rs'), 'utf8')).toBe(content)
      expect(completion.messages.filter((message) => message.isStreaming)).toHaveLength(0)
      expect(completion.messages.find((message) => message.thinkingContent)?.thinkingContent).toBe(firstThinking)
      const deltaRows = store.getEvents('session-1').filter((event) => event.type === 'message.thinking')
      expect(deltaRows.length).toBeLessThan(40)
      const resumed = await runFixture([frame({ content: 'Resumed normally' }, 'stop')])
      expect(resumed.requests).toHaveLength(1)
      expect(resumed.messages.at(-1)).toMatchObject({ content: 'Resumed normally', isStreaming: false })
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  it('terminates repeated malformed tool calls without executing a tool and persists the failure', async () => {
    const execute = vi.fn()
    const malformed = toolFrames('write_file', '{"content":"unterminated')
    const fixture = await runFixture(
      Array.from({ length: 5 }, () => malformed),
      execute,
    )
    expect(execute).not.toHaveBeenCalled()
    expect(fixture.requests).toHaveLength(3)
    expect(fixture.outcome?.failed?.error).toMatch(/malformed/i)
    expect(store.getEvents('session-1').some((event) => event.type === 'chat.error')).toBe(true)
    expect(fixture.messages.some((message) => message.isStreaming)).toBe(false)
  })

  it('persists an abrupt EOF failure after thinking and can resume on the next turn', async () => {
    const execute = vi.fn()
    const failed = await runFixture([frame({ reasoning_content: 'unfinished thought' })], execute)
    expect(execute).not.toHaveBeenCalled()
    expect(failed.requests).toHaveLength(1)
    expect(failed.outcome?.failed?.error).toMatch(/terminal/i)
    expect(store.getEvents('session-1').some((event) => event.type === 'chat.error')).toBe(true)
    expect(failed.messages.some((message) => message.isStreaming)).toBe(false)
    const resumed = await runFixture([frame({ content: 'Resume after EOF' }, 'stop')])
    expect(resumed.messages.at(-1)).toMatchObject({ content: 'Resume after EOF', isStreaming: false })
  })

  it('case 1 — failed-before-content retry writes nothing, success writes the exact expected events', async () => {
    const client = createSequencedClient(
      [{ type: 'error', error: 'boom' }],
      [
        { type: 'text_delta', content: 'ok' },
        { type: 'done', response: okResponse },
      ],
    )

    const config = makeConfig({ llmClient: client as never, llmRetryPolicy: FAST_POLICY })
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)

    expect(result.failed).toBeUndefined()
    const events = store.getEvents('session-1').map((e) => e.type)
    // Seed user message + only the successful attempt's assistant message
    expect(events).toEqual([
      'message.start',
      'message.done',
      'message.start',
      'message.delta',
      'message.done',
      'chat.done',
    ])
    const delta = store.getEvents('session-1')[3]!
    expect((delta.data as { content: string }).content).toBe('ok')
  })

  it('case 2 — keeps partial content plus exactly one continuation, then retries', async () => {
    const client = createSequencedClient(
      [
        { type: 'text_delta', content: 'partial ' },
        { type: 'error', error: 'stream died' },
      ],
      [
        { type: 'text_delta', content: 'final' },
        { type: 'done', response: okResponse },
      ],
    )

    const config = makeConfig({ llmClient: client as never, llmRetryPolicy: FAST_POLICY })
    const result = await runTopLevelAgentLoop(config, mockTurnMetrics)

    expect(result.failed).toBeUndefined()
    const events = store.getEvents('session-1')
    const types = events.map((e) => e.type)
    // Seed + partial attempt (kept) + one continuation + successful retry
    expect(types).toEqual([
      'message.start',
      'message.done',
      // partial attempt: assistant start + delta + done(partial)
      'message.start',
      'message.delta',
      'message.done',
      // continuation user message
      'message.start',
      'message.done',
      // successful retry
      'message.start',
      'message.delta',
      'message.done',
      'chat.done',
    ])
    const partialDone = events[4]!
    expect((partialDone.data as { partial?: boolean }).partial).toBe(true)
    const continueMsg = events[5]!
    expect((continueMsg.data as { content?: string }).content).toContain('interrupted')
    // No chat.error, nothing removed
    expect(types.includes('chat.error')).toBe(false)
    const finalDelta = events[8]!
    expect((finalDelta.data as { content: string }).content).toBe('final')
  })
})
