/**
 * Stream batching through the agent loop (real EventStore + real streamLLMPure).
 *
 * Fragments are persisted in batches while every fragment still reaches the
 * live subscribers (WebSocket clients) one by one, and the persisted content
 * is byte-identical to what was streamed — on completion, abort and error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { LLMStreamEvent, LLMCompletionResponse } from '../llm/types.js'
import { EventStore } from '../events/store.js'
import { foldTurnEventsToSnapshotMessages } from '../events/folding.js'
import type { StoredEvent } from '../events/types.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'

vi.mock('../events/index.js', () => ({
  getCurrentContextWindowId: vi.fn(() => undefined),
  getCurrentWindowMessageOptions: vi.fn(() => undefined),
}))

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: vi.fn(async () => ({ content: '', files: [] })),
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn(async () => []),
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

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runTopLevelAgentLoop } from './agent-loop.js'

const SID = 'session-1'
const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }

const okResponse: LLMCompletionResponse = {
  id: 'resp-ok',
  content: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
}

function makeFragments(prefix: string, count: number): string[] {
  const alphabet = ['é', '🦊', ' ', '\n', '"', '\\', 'z']
  return Array.from({ length: count }, (_, i) => `${prefix}${i}${alphabet[i % alphabet.length]}`)
}

function scriptedClient(attempts: Array<(signal: AbortSignal | undefined) => AsyncGenerator<LLMStreamEvent>>) {
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
    stream: (request: { signal?: AbortSignal }) => {
      const run = attempts[Math.min(attempt, attempts.length - 1)]!
      attempt += 1
      return run(request.signal)
    },
  }
}

function contentByType(events: StoredEvent[], type: 'message.thinking' | 'message.delta', messageId?: string): string {
  return events
    .filter(
      (event) =>
        event.type === type &&
        (messageId === undefined || (event.data as { messageId: string }).messageId === messageId),
    )
    .map((event) => (event.data as { content: string }).content)
    .join('')
}

function lastThinkingIndex(events: StoredEvent[]): number {
  return events.map((event) => event.type).lastIndexOf('message.thinking')
}

describe('agent loop stream batching (real EventStore)', () => {
  let db: Database.Database
  let store: EventStore
  let live: StoredEvent[]
  let unsubscribe: () => void
  let turnMetrics: TurnMetrics
  let sessionManager: any

  beforeEach(() => {
    db = new Database(':memory:')
    store = new EventStore(db)
    store.append(SID, { type: 'message.start', data: { messageId: 'user-1', role: 'user', content: 'hi' } })
    store.append(SID, { type: 'message.done', data: { messageId: 'user-1' } })

    live = []
    const subscription = store.subscribeAll()
    unsubscribe = subscription.unsubscribe
    void (async () => {
      for await (const event of subscription.iterator) live.push(event)
    })()

    sessionManager = {
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
      getReadFiles: vi.fn().mockReturnValue([]),
    }
    turnMetrics = {
      addToolTime: vi.fn(),
      addLLMCall: vi.fn(),
      addThinkingTime: vi.fn(),
      buildStats: vi.fn().mockReturnValue({ durationMs: 0 }),
    } as unknown as TurnMetrics
  })

  afterEach(() => {
    unsubscribe()
    db.close()
  })

  function makeConfig(overrides?: Partial<TopLevelLoopConfig>): TopLevelLoopConfig {
    return {
      mode: 'planner',
      append: (event) => store.append(SID, event),
      appendStreaming: (event) => store.appendStreaming(SID, event),
      flushStreaming: () => {
        store.tryFlushStreaming(SID)
      },
      sessionManager,
      sessionId: SID,
      llmClient: { getModel: () => 'test-model' } as never,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [], tools: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      llmRetryPolicy: FAST_POLICY,
      ...overrides,
    }
  }

  const drain = () => new Promise((resolve) => setImmediate(resolve))

  it('streams 10 000 thinking fragments into fewer than 200 stored events with byte-identical content', async () => {
    const thinkingFragments = makeFragments('t', 10_000)
    const textFragments = makeFragments('x', 500)
    const client = scriptedClient([
      async function* () {
        for (const content of thinkingFragments) yield { type: 'thinking_delta', content }
        for (const content of textFragments) yield { type: 'text_delta', content }
        yield { type: 'done', response: okResponse }
      },
    ])

    await runTopLevelAgentLoop(makeConfig({ llmClient: client as never }), turnMetrics)
    await drain()

    const stored = store.getEvents(SID)
    expect(stored.length).toBeLessThan(200)
    expect(contentByType(stored, 'message.thinking')).toBe(thinkingFragments.join(''))
    expect(contentByType(stored, 'message.delta')).toBe(textFragments.join(''))

    const liveThinking = live.filter((event) => event.type === 'message.thinking')
    const liveText = live.filter((event) => event.type === 'message.delta')
    expect(liveThinking.map((event) => (event.data as { content: string }).content)).toEqual(thinkingFragments)
    expect(liveText.map((event) => (event.data as { content: string }).content)).toEqual(textFragments)

    const assistant = foldTurnEventsToSnapshotMessages(stored).find((message) => message.role === 'assistant')
    expect(assistant?.thinkingContent).toBe(thinkingFragments.join(''))
    expect(assistant?.content).toBe(textFragments.join(''))
  })

  it('an abort in the middle of the stream keeps every fragment already received', async () => {
    const controller = new AbortController()
    const fragments = makeFragments('a', 10_000)
    const client = scriptedClient([
      async function* () {
        for (const [i, content] of fragments.entries()) {
          yield { type: 'thinking_delta', content }
          if (i === 6_000) controller.abort()
        }
        yield { type: 'done', response: okResponse }
      },
    ])

    await expect(
      runTopLevelAgentLoop(makeConfig({ llmClient: client as never, signal: controller.signal }), turnMetrics),
    ).rejects.toThrow('Aborted')
    await drain()

    const received = live
      .filter((event) => event.type === 'message.thinking')
      .map((event) => (event.data as { content: string }).content)
    expect(received.length).toBeGreaterThan(6_000)
    expect(received.length).toBeLessThan(fragments.length)

    const stored = store.getEvents(SID)
    expect(contentByType(stored, 'message.thinking')).toBe(received.join(''))
    const done = stored.filter((event) => event.type === 'message.done').at(-1)
    expect((done?.data as { partial?: boolean }).partial).toBe(true)
    expect(stored.indexOf(done!)).toBeGreaterThan(lastThinkingIndex(stored))
  })

  it('a stream error keeps the partial fragments before the continuation', async () => {
    const partial = makeFragments('p', 3_000)
    const client = scriptedClient([
      async function* () {
        for (const content of partial) yield { type: 'thinking_delta', content }
        yield { type: 'error', error: 'stream died' }
      },
      async function* () {
        yield { type: 'text_delta', content: 'final' }
        yield { type: 'done', response: okResponse }
      },
    ])

    const result = await runTopLevelAgentLoop(makeConfig({ llmClient: client as never }), turnMetrics)
    expect(result.failed).toBeUndefined()

    const stored = store.getEvents(SID)
    const partialMessageId = (stored.find((event) => event.type === 'message.thinking')!.data as { messageId: string })
      .messageId
    expect(contentByType(stored, 'message.thinking', partialMessageId)).toBe(partial.join(''))
    expect(stored.filter((event) => event.type === 'message.thinking').length).toBeLessThan(50)
    const partialDoneIndex = stored.findIndex(
      (event) => event.type === 'message.done' && (event.data as { messageId: string }).messageId === partialMessageId,
    )
    expect(partialDoneIndex).toBeGreaterThan(lastThinkingIndex(stored))
  })
})
