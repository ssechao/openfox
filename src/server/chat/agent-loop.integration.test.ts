import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionManager } from '../session/index.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import type { ToolCall } from '../../shared/types.js'

vi.mock('./stream-pure.js', () => ({
  streamLLMPure: vi.fn(),
  consumeStreamGenerator: vi.fn(),
  TurnMetrics: vi.fn(),
  createMessageStartEvent: vi.fn((messageId: string, role: string, content?: string, options?: any) => ({
    type: 'message.start',
    data: { messageId, role, content, ...options },
  })),
  createMessageDoneEvent: vi.fn((messageId: string, options?: any) => ({
    type: 'message.done',
    data: { messageId, ...options },
  })),
  createChatDoneEvent: vi.fn((messageId: string, reason: string) => ({
    type: 'chat.done',
    data: { messageId, reason },
  })),
  evaluateLLMRetry: vi.fn(() => ({ retry: true, delayMs: 0, attempt: 2 })),
  sleepThroughRetryBackoff: vi.fn(async () => 'waited' as const),
  recordLLMFailure: vi.fn(),
  clearLLMFailure: vi.fn(),
}))

vi.mock('./execute-tools.js', () => ({
  executeTools: vi.fn(),
}))

vi.mock('../context/compactor.js', () => ({
  shouldCompact: vi.fn().mockReturnValue(false),
  appendCompactionPrompt: vi.fn((_sessionId: string, append: (event: any) => void) => {
    append({
      type: 'message.start',
      data: {
        messageId: 'compact-prompt',
        role: 'user',
        content: 'You are a helpful AI assistant tasked with summarizing conversations for continuation.',
        isSystemGenerated: true,
        messageKind: 'auto-prompt',
        metadata: { type: 'compaction', name: 'Compaction', color: '#64748b' },
      },
    })
    append({ type: 'message.done', data: { messageId: 'compact-prompt' } })
  }),
}))

vi.mock('./conversation-history.js', () => ({
  getConversationMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('../db/settings.js', () => ({
  getSetting: vi.fn(),
  SETTINGS_KEYS: { LLM_DYNAMIC_SYSTEM_PROMPT: 'llm.dynamicSystemPrompt' },
}))

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: vi.fn().mockResolvedValue({ content: '', files: [] }),
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn().mockResolvedValue([]),
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    mode: 'test',
    workdir: '/test',
    agent: {},
    context: { compactionThreshold: 0.8 },
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

vi.mock('../events/index.js', () => ({
  getCurrentContextWindowId: vi.fn().mockReturnValue(undefined),
  getCurrentWindowMessageOptions: vi.fn().mockReturnValue(undefined),
  getEventStore: vi.fn().mockReturnValue({ append: vi.fn(), getEvents: vi.fn().mockReturnValue([]) }),
}))

import { runTopLevelAgentLoop } from './agent-loop.js'
import { consumeStreamGenerator, streamLLMPure } from './stream-pure.js'
import { executeTools } from './execute-tools.js'

function createMockSessionManager(overrides?: Record<string, any>): SessionManager {
  return {
    requireSession: vi.fn().mockReturnValue({
      workdir: '/test',
      projectId: 'test-project',
      executionState: null,
      criteria: [],
      isRunning: false,
    }),
    getContextState: vi.fn().mockReturnValue({
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    }),
    getCurrentModelSettings: vi.fn().mockReturnValue({}),
    getCurrentModelContext: vi.fn().mockReturnValue(200000),
    getModelCompactionThreshold: vi.fn().mockReturnValue(undefined),
    setCurrentContextSize: vi.fn(),
    getDynamicContextChanged: vi.fn().mockReturnValue(false),
    setDynamicContextChanged: vi.fn(),
    getCachedPrompt: vi.fn().mockReturnValue(undefined),
    setCachedPrompt: vi.fn(),
    getLspManager: vi.fn(),
    getEffectiveWorkdir: vi.fn().mockReturnValue('/test'),
    getProjectWorkdir: vi.fn().mockReturnValue('/test'),
    drainAsapMessages: vi.fn().mockReturnValue([]),
    getCurrentWindowMessages: vi.fn().mockReturnValue([]),
    updateMessage: vi.fn(),
    getQueueState: vi.fn().mockReturnValue({ queued: 0, processing: false }),
    enterPauseGate: vi.fn().mockResolvedValue('released'),
    ...overrides,
  } as any
}

function makeConfig(overrides?: Partial<TopLevelLoopConfig>): TopLevelLoopConfig {
  return {
    mode: 'planner',
    append: vi.fn(),
    sessionManager: createMockSessionManager(),
    sessionId: 'test-session',
    llmClient: { getModel: vi.fn().mockReturnValue('test-model') } as any,
    statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
    assembleRequest: vi.fn().mockReturnValue({
      systemPrompt: 'test-prompt',
      messages: [],
    }),
    getToolRegistry: () => ({ definitions: [], execute: vi.fn() }) as any,
    getConversationMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function makeStreamResult(overrides?: Record<string, any>) {
  return {
    content: '',
    toolCalls: [],
    segments: [],
    usage: { promptTokens: 100, completionTokens: 50 },
    timing: {} as any,
    aborted: false,
    modelParams: {},
    finishReason: 'stop' as const,
    ...overrides,
  }
}

describe('agentLoop integration', () => {
  let turnMetrics: TurnMetrics

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(streamLLMPure).mockReset()
    vi.mocked(consumeStreamGenerator).mockReset()
    vi.mocked(executeTools).mockReset()
    turnMetrics = {
      addToolTime: vi.fn(),
      addLLMCall: vi.fn(),
      buildStats: vi.fn().mockReturnValue({}),
    } as any
    ;(consumeStreamGenerator as any).mockResolvedValue(makeStreamResult())
  })

  it('continues loop when tool calls are returned and executeTools produces messages', async () => {
    const append = vi.fn()
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: { command: 'echo hi' } }

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-1' }],
    })

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Should have called streamLLM twice (first for tool calls, second for final response)
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    // Should emit chat.done at the end
    const chatDoneEvents = append.mock.calls.filter((args: unknown[]) => (args[0] as any).type === 'chat.done')
    expect(chatDoneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('breaks loop when no tool calls and no queued messages', async () => {
    const append = vi.fn()

    ;(consumeStreamGenerator as any).mockResolvedValue(
      makeStreamResult({ content: 'Final answer', finishReason: 'stop' }),
    )
    // drainAsapMessages returns empty by default via createMockSessionManager

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Should have called streamLLM once
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(1)
    // Should emit chat.done
    const chatDoneEvents = append.mock.calls.filter((args: unknown[]) => (args[0] as any).type === 'chat.done')
    expect(chatDoneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('continues loop when retry pattern matches', async () => {
    const append = vi.fn()

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({
          content: 'bad format',
          finishReason: 'stop',
          patternMatch: { pattern: 'bad', field: 'content', matchedContent: 'bad format' },
        }),
      )
      .mockResolvedValueOnce(makeStreamResult({ content: 'good format', finishReason: 'stop' }))

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Should have called streamLLM twice
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    // Should have appended pattern.retry event
    const retryEvents = append.mock.calls.filter((args: unknown[]) => (args[0] as any).type === 'pattern.retry')
    expect(retryEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('retries on truncation (finishReason=length) up to MAX_TRUNCATION_RETRIES', async () => {
    const append = vi.fn()

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({ finishReason: 'length', toolCalls: [], usage: { promptTokens: 100, completionTokens: 50 } }),
      )
      .mockResolvedValueOnce(
        makeStreamResult({ finishReason: 'length', toolCalls: [], usage: { promptTokens: 100, completionTokens: 50 } }),
      )
      .mockResolvedValueOnce(
        makeStreamResult({ finishReason: 'length', toolCalls: [], usage: { promptTokens: 100, completionTokens: 50 } }),
      )
      .mockResolvedValueOnce(
        makeStreamResult({ content: 'Done', finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 50 } }),
      )

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Should have called streamLLM 4 times (3 retries + 1 success)
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(4)
    // Should emit chat.done
    const chatDoneEvents = append.mock.calls.filter((args: unknown[]) => (args[0] as any).type === 'chat.done')
    expect(chatDoneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('exhausts truncation retries and emits truncated', async () => {
    const append = vi.fn()

    ;(consumeStreamGenerator as any).mockResolvedValue(
      makeStreamResult({ finishReason: 'length', toolCalls: [], usage: { promptTokens: 100, completionTokens: 50 } }),
    )

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Should have called streamLLM 4 times (MAX_TRUNCATION_RETRIES retries + 1 final break)
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(4)
    // Should emit chat.done with 'truncated' reason
    const truncatedEvents = append.mock.calls.filter(
      (args: unknown[]) => (args[0] as any).type === 'chat.done' && (args[0] as any).data?.reason === 'truncated',
    )
    expect(truncatedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('requests a visible final response after step_done outside a workflow', async () => {
    const append = vi.fn()
    const toolCall: ToolCall = { id: 'call-1', name: 'step_done', arguments: {} }
    const finalSegments = [{ type: 'text', content: 'Implemented and verified the fix.' }]

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(
        makeStreamResult({
          content: 'Implemented and verified the fix.',
          segments: finalSegments,
          finishReason: 'stop',
        }),
      )
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [
        { role: 'tool', content: 'Step completion signal recorded.', source: 'history', toolCallId: 'call-1' },
      ],
      stepDoneCalled: true,
    })

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    expect(streamLLMPure).toHaveBeenNthCalledWith(2, expect.objectContaining({ toolChoice: 'none' }))
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.done', data: expect.objectContaining({ segments: finalSegments }) }),
    )
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.done', data: expect.objectContaining({ reason: 'step_done' }) }),
    )
  })

  it('confirms the tool result before completing a workflow step', async () => {
    const append = vi.fn()
    const toolCall: ToolCall = { id: 'call-1', name: 'step_done', arguments: {} }

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Confirmed.', finishReason: 'stop' }))
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [
        { role: 'tool', content: 'Step completion signal recorded.', source: 'history', toolCallId: 'call-1' },
      ],
      stepDoneCalled: true,
    })

    await runTopLevelAgentLoop(makeConfig({ append, stopOnStepDone: true }), turnMetrics)

    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    expect(streamLLMPure).toHaveBeenNthCalledWith(2, expect.objectContaining({ toolChoice: 'none' }))
    expect(executeTools).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.done', data: expect.objectContaining({ reason: 'step_done' }) }),
    )
  })

  it.each([true, false])(
    'resumes pending delivery without kickoff, new user prompt or repeated tool (result present=%s)',
    async (present) => {
      const prefix = [
        { role: 'user' as const, content: 'Original work' },
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'done', name: 'step_done', arguments: {} }] },
        ...(present
          ? [{ role: 'tool' as const, toolCallId: 'done', content: 'Step completion signal recorded.' }]
          : []),
      ]
      const history = [...prefix, { role: 'user' as const, content: 'NEW_PROMPT_AFTER_RESTART' }]
      const injectKickoff = vi.fn()
      const config = makeConfig({
        stopOnStepDone: true,
        resumeStepDoneCallId: 'done',
        injectKickoff,
        getConversationMessages: vi.fn().mockResolvedValue(history),
        assembleRequest: vi.fn().mockImplementation(({ messages }) => ({ systemPrompt: 'sys', messages })),
      })
      const result = await runTopLevelAgentLoop(config, turnMetrics)
      expect(injectKickoff).not.toHaveBeenCalled()
      expect(executeTools).not.toHaveBeenCalled()
      if (present) {
        expect(result.failed).toBeUndefined()
        expect(streamLLMPure).toHaveBeenCalledTimes(1)
        expect(vi.mocked(streamLLMPure).mock.calls[0]![0].messages).toEqual(prefix)
      } else {
        expect(result.failed).toBeDefined()
        expect(streamLLMPure).not.toHaveBeenCalled()
      }
      expect(history.at(-1)?.content).toBe('NEW_PROMPT_AFTER_RESTART')
    },
  )

  it('does not execute a tool returned against tool_choice none during workflow confirmation', async () => {
    const append = vi.fn()
    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({ toolCalls: [{ id: 'done', name: 'step_done', arguments: {} }], finishReason: 'tool_calls' }),
      )
      .mockResolvedValueOnce(
        makeStreamResult({
          toolCalls: [{ id: 'late', name: 'run_command', arguments: { command: 'should not execute' } }],
          finishReason: 'tool_calls',
        }),
      )
    ;(executeTools as any).mockResolvedValue({ toolMessages: [], stepDoneCalled: true })
    const result = await runTopLevelAgentLoop(makeConfig({ append, stopOnStepDone: true }), turnMetrics)
    expect(result.failed).toBeDefined()
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    expect(executeTools).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.done', data: expect.objectContaining({ reason: 'step_done' }) }),
    )
  })

  it('does not generate a confirmation after an explicit abort following step_done', async () => {
    const controller = new AbortController()
    ;(consumeStreamGenerator as any).mockResolvedValueOnce(
      makeStreamResult({ toolCalls: [{ id: 'done', name: 'step_done', arguments: {} }], finishReason: 'tool_calls' }),
    )
    ;(executeTools as any).mockImplementation(async () => {
      controller.abort()
      return { toolMessages: [], stepDoneCalled: true }
    })
    await expect(
      runTopLevelAgentLoop(makeConfig({ stopOnStepDone: true, signal: controller.signal }), turnMetrics),
    ).rejects.toThrow('Aborted')
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failed workflow confirmation or declare the step delivered', async () => {
    const append = vi.fn()
    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({ toolCalls: [{ id: 'done', name: 'step_done', arguments: {} }], finishReason: 'tool_calls' }),
      )
      .mockResolvedValueOnce(makeStreamResult({ error: 'connection lost after delivery' }))
    ;(executeTools as any).mockResolvedValue({ toolMessages: [], stepDoneCalled: true })
    const result = await runTopLevelAgentLoop(makeConfig({ append, stopOnStepDone: true }), turnMetrics)
    expect(result.failed).toBeDefined()
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    expect(executeTools).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.done', data: expect.objectContaining({ reason: 'step_done' }) }),
    )
  })

  it('keeps an interrupted confirmation unconfirmed without retrying', async () => {
    const append = vi.fn()
    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({ toolCalls: [{ id: 'done', name: 'step_done', arguments: {} }], finishReason: 'tool_calls' }),
      )
      .mockResolvedValueOnce(makeStreamResult({ aborted: true, content: 'Partial confirmation' }))
    ;(executeTools as any).mockResolvedValue({ toolMessages: [], stepDoneCalled: true })
    await expect(runTopLevelAgentLoop(makeConfig({ append, stopOnStepDone: true }), turnMetrics)).rejects.toThrow(
      'Aborted',
    )
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    expect(executeTools).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.done', data: expect.objectContaining({ reason: 'step_done' }) }),
    )
  })

  it.each(['content_filter', 'tool_calls', undefined])(
    'does not confirm a workflow without a successful stop terminal (%s)',
    async (finishReason) => {
      const append = vi.fn()
      ;(consumeStreamGenerator as any)
        .mockResolvedValueOnce(
          makeStreamResult({
            toolCalls: [{ id: 'done', name: 'step_done', arguments: {} }],
            finishReason: 'tool_calls',
          }),
        )
        .mockResolvedValueOnce(makeStreamResult({ finishReason, content: 'Not a confirmed terminal' }))
      ;(executeTools as any).mockResolvedValue({ toolMessages: [], stepDoneCalled: true })
      const result = await runTopLevelAgentLoop(makeConfig({ append, stopOnStepDone: true }), turnMetrics)
      expect(result.failed).toBeDefined()
      expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
      expect(executeTools).toHaveBeenCalledTimes(1)
      expect(append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat.done', data: expect.objectContaining({ reason: 'step_done' }) }),
      )
    },
  )

  it('continues loop when step_done is not called', async () => {
    const append = vi.fn()
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: { command: 'echo hi' } }

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-1' }],
      stepDoneCalled: false,
    })

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Should have called streamLLM twice (tool calls then final response)
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    // Should emit chat.done at the end
    const chatDoneEvents = append.mock.calls.filter((args: unknown[]) => (args[0] as any).type === 'chat.done')
    expect(chatDoneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('picks up a danger level change made mid-run on the next batch', async () => {
    const append = vi.fn()
    // requireSession simulates a fresh DB read per call, so each batch context
    // sees the danger level as it is at that moment.
    const state = { dangerLevel: 'normal' as 'normal' | 'dangerous' }
    const requireSession = vi.fn(() => ({
      workdir: '/test',
      projectId: 'test-project',
      executionState: null,
      criteria: [],
      isRunning: false,
      dangerLevel: state.dangerLevel,
    }))
    const sessionManager = createMockSessionManager({ requireSession })
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: { command: 'echo hi' } }

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
    ;(executeTools as any).mockImplementation(async () => {
      // Simulate the user switching the session to dangerous mode while batch 1 runs.
      state.dangerLevel = 'dangerous'
      return { toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-1' }] }
    })

    await runTopLevelAgentLoop(makeConfig({ sessionManager, append }), turnMetrics)

    // Guard: the danger level change must apply from the next batch (each batch
    // context is built from a fresh session read, not a run-start snapshot).
    const batchContexts = (executeTools as any).mock.calls.map((c: unknown[]) => c[2] as any)
    expect(batchContexts.length).toBeGreaterThanOrEqual(2)
    expect(batchContexts[0].dangerLevel).toBe('normal')
    expect(batchContexts[batchContexts.length - 1].dangerLevel).toBe('dangerous')
  })

  it('settles an accepted tool with the same catalogue before compacting', async () => {
    const append = vi.fn()
    const toolCall: ToolCall = { id: 'call-read', name: 'read_file', arguments: { path: 'synthetic.txt' } }
    const definitions = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]

    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Tool result settled', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    vi.mocked(executeTools).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'synthetic result', toolCallId: 'call-read' }],
      stepDoneCalled: false,
    } as any)
    const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
    vi.mocked(shouldCompact).mockReturnValueOnce(true).mockReturnValue(false)

    await runTopLevelAgentLoop(
      makeConfig({
        append,
        assembleRequest: vi.fn(async ({ promptTools }) => ({
          systemPrompt: 'test-prompt',
          messages: [],
          tools: promptTools,
        })),
        getToolRegistry: () => ({ definitions, execute: vi.fn() }) as any,
      }),
      turnMetrics,
    )

    expect(executeTools).toHaveBeenCalledTimes(1)
    expect(appendCompactionPrompt).toHaveBeenCalledTimes(1)
    const requests = vi.mocked(streamLLMPure).mock.calls.map(([request]) => request)
    expect(requests[1]?.toolChoice).toBe('auto')
    expect(requests[1]?.tools).toEqual(definitions)
    expect(requests[2]?.toolChoice).toBe('none')
    expect(requests[2]?.tools).toEqual([])
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(4)
  })

  it.each(['claude-opus-5', 'gpt-5.6-sol'])(
    'compacts an already-full %s session without overriding the client effort',
    async (model) => {
      const append = vi.fn()
      const sessionManager = createMockSessionManager({
        getContextState: vi.fn().mockReturnValue({
          currentTokens: 180000,
          maxTokens: 200000,
          compactionCount: 0,
          dangerZone: true,
          canCompact: true,
          dynamicContextChanged: false,
        }),
      })
      vi.mocked(consumeStreamGenerator)
        .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
        .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
      const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
      vi.mocked(shouldCompact).mockReturnValueOnce(true).mockReturnValue(false)

      await runTopLevelAgentLoop(
        makeConfig({ append, sessionManager, llmClient: { getModel: () => model } as any }),
        turnMetrics,
      )

      expect(appendCompactionPrompt).toHaveBeenCalledTimes(1)
      expect(vi.mocked(appendCompactionPrompt).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(consumeStreamGenerator).mock.invocationCallOrder[0]!,
      )
      expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
      for (const [request] of vi.mocked(streamLLMPure).mock.calls) {
        expect(request).not.toHaveProperty('reasoningEffort')
      }
    },
  )

  it('estimates unknown restored usage before the first request and compacts when near the limit', async () => {
    const append = vi.fn()
    const injectKickoff = vi.fn()
    const unknownState = {
      currentTokens: 0,
      currentTokensKnown: false,
      maxTokens: 50_000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    }
    const knownState = { ...unknownState, currentTokensKnown: true }
    const getContextState = vi
      .fn()
      .mockReturnValueOnce(unknownState)
      .mockReturnValueOnce(unknownState)
      .mockReturnValueOnce(unknownState)
      .mockReturnValue(knownState)
    const sessionManager = createMockSessionManager({
      getContextState,
      getCurrentModelContext: vi.fn().mockReturnValue(50_000),
    })
    const history = [{ role: 'user' as const, content: 'x'.repeat(44_000), source: 'history' as const }]
    const assembleRequest = vi.fn(async ({ messages, promptTools }) => ({
      systemPrompt: 'system',
      messages,
      tools: promptTools,
    }))
    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
    vi.mocked(shouldCompact).mockImplementation(
      (currentTokens, maxTokens, threshold) => currentTokens > maxTokens * threshold,
    )

    await runTopLevelAgentLoop(
      makeConfig({
        append,
        sessionManager,
        assembleRequest,
        injectKickoff,
        getConversationMessages: vi.fn().mockResolvedValue(history),
      }),
      turnMetrics,
    )

    expect(vi.mocked(shouldCompact).mock.calls[0]?.[0]).toBeGreaterThan(0)
    expect(injectKickoff).toHaveBeenCalledTimes(1)
    expect(appendCompactionPrompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendCompactionPrompt).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(consumeStreamGenerator).mock.invocationCallOrder[0]!,
    )
    expect(vi.mocked(streamLLMPure).mock.calls[0]?.[0].toolChoice).toBe('none')
  })

  it.each(['claude-opus-5', 'gpt-5.6-sol', 'qwen3.8-27b'])(
    'uses a tool-free request and bounded output without overriding the %s client effort',
    async (model) => {
      const definitions = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]
      const assembleRequest = vi.fn(async ({ promptTools }) => ({
        systemPrompt: 'test-prompt',
        messages: [],
        tools: promptTools,
      }))
      vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(
        makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }),
      )

      await runTopLevelAgentLoop(
        makeConfig({
          initialCompacting: true,
          llmClient: { getModel: () => model } as any,
          assembleRequest,
          getToolRegistry: () => ({ definitions, execute: vi.fn() }) as any,
        }),
        turnMetrics,
      )

      const request = vi.mocked(streamLLMPure).mock.calls[0]?.[0]
      expect(request).toBeDefined()
      expect(request!.toolChoice).toBe('none')
      expect(request!.tools).toEqual([])
      expect(request!.modelSettings?.maxTokens).toBe(8192)
      expect(request).not.toHaveProperty('reasoningEffort')
    },
  )

  it('compacts unknown usage with images without base64 overflow or cached tool overhead', async () => {
    const data = 'data:image/png;base64,' + 'YWJj'.repeat(100_000)
    const messages = [
      {
        role: 'user' as const,
        content: 'Summarize our work',
        source: 'history' as const,
        attachments: [{ id: 'img', filename: 'screen.png', mimeType: 'image/png', size: 300_000, data }],
      },
    ]
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 0,
        currentTokensKnown: false,
        maxTokens: 128_000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(128_000),
    })
    vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(
      makeStreamResult({ content: 'Summary', finishReason: 'stop' }),
    )
    const result = await runTopLevelAgentLoop(
      makeConfig({
        initialCompacting: true,
        sessionManager,
        getConversationMessages: vi.fn().mockResolvedValue(messages),
        assembleRequest: vi.fn(async ({ messages }) => ({
          systemPrompt: 'system',
          messages,
          tools: [{ type: 'function', function: { name: 'unused', description: 'x'.repeat(200_000) } }] as any,
        })),
      }),
      turnMetrics,
    )
    expect(result.failed).toBeUndefined()
    const request = vi.mocked(streamLLMPure).mock.calls[0]?.[0]
    expect(request).toBeDefined()
    expect(request!.tools).toEqual([])
    expect(request!.messages[0]!.attachments![0]!.data).toBe(data)
    expect(request!.modelSettings?.maxTokens).toBe(8192)
  })

  it.each(['claude-opus-5', 'gpt-5.6-sol'])(
    'counts an unknown %s context without overriding the client effort before compaction',
    async (model) => {
      const history = [{ role: 'user' as const, content: '\u0001'.repeat(200_000), source: 'history' as const }]
      const countInputTokens = vi.fn().mockResolvedValue(60_000)
      const sessionManager = createMockSessionManager({
        getContextState: vi.fn().mockReturnValue({
          currentTokens: 0,
          currentTokensKnown: false,
          maxTokens: 128_000,
          compactionCount: 0,
          dangerZone: false,
          canCompact: false,
        }),
        getCurrentModelContext: vi.fn().mockReturnValue(128_000),
      })
      vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(
        makeStreamResult({ content: 'Summary', finishReason: 'stop' }),
      )

      const result = await runTopLevelAgentLoop(
        makeConfig({
          initialCompacting: true,
          sessionManager,
          llmClient: { getModel: () => model, countInputTokens } as any,
          getConversationMessages: async () => history,
          assembleRequest: async ({ messages }) => ({ systemPrompt: 'system', messages, tools: [] }),
        }),
        turnMetrics,
      )

      expect(result.failed).toBeUndefined()
      expect(countInputTokens).toHaveBeenCalledTimes(1)
      expect(countInputTokens.mock.calls[0]![0]).not.toHaveProperty('reasoningEffort')
      expect(sessionManager.setCurrentContextSize).toHaveBeenCalledWith('test-session', 60_000, 0, undefined, 'planner')
      expect(streamLLMPure).toHaveBeenCalledTimes(1)
      expect(vi.mocked(streamLLMPure).mock.calls[0]![0].modelSettings?.maxTokens).toBe(8192)
    },
  )

  it('does not add a wrapper count request when the context usage is already known', async () => {
    const countInputTokens = vi.fn().mockResolvedValue(60_000)
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 40_000,
        currentTokensKnown: true,
        maxTokens: 128_000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: true,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(128_000),
    })
    vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(
      makeStreamResult({ content: 'Summary', finishReason: 'stop' }),
    )

    const result = await runTopLevelAgentLoop(
      makeConfig({
        initialCompacting: true,
        sessionManager,
        llmClient: { getModel: () => 'claude-opus-5', countInputTokens } as any,
      }),
      turnMetrics,
    )

    expect(result.failed).toBeUndefined()
    expect(countInputTokens).not.toHaveBeenCalled()
    expect(streamLLMPure).toHaveBeenCalledTimes(1)
  })

  it('refuses a genuinely oversized unknown context once, preserving history and gauge', async () => {
    const history = [{ role: 'user' as const, content: '\u0001'.repeat(200_000), source: 'history' as const }]
    const initial = JSON.stringify(history)
    const append = vi.fn()
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({ currentTokens: 0, currentTokensKnown: false, maxTokens: 128_000 }),
      getCurrentModelContext: vi.fn().mockReturnValue(128_000),
    })
    const result = await runTopLevelAgentLoop(
      makeConfig({
        initialCompacting: true,
        append,
        sessionManager,
        llmClient: { getModel: () => 'gpt-5.6-sol' } as any,
        getConversationMessages: async () => history,
        assembleRequest: async ({ messages }) => ({ systemPrompt: 'system', messages, tools: [] }),
      }),
      turnMetrics,
    )
    expect(result.failed?.error).toContain('Not enough context headroom')
    expect(streamLLMPure).not.toHaveBeenCalled()
    expect(sessionManager.setCurrentContextSize).not.toHaveBeenCalled()
    expect(append.mock.calls.some(([e]) => e.type === 'context.compacted')).toBe(false)
    expect(JSON.stringify(history)).toBe(initial)
  })

  it('fails compaction once without replacing history when the summary is incomplete', async () => {
    vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(
      makeStreamResult({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { path: 'synthetic.txt' } }],
      }),
    )
    const append = vi.fn()

    const result = await runTopLevelAgentLoop(makeConfig({ initialCompacting: true, append }), turnMetrics)

    expect(result.failed?.error).toBeTruthy()
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(1)
    expect(executeTools).not.toHaveBeenCalled()
    expect(append.mock.calls.some(([event]) => event.type === 'context.compacted')).toBe(false)
  })

  it('auto-compacts within the loop when threshold is exceeded, then continues normally', async () => {
    const append = vi.fn()
    const injectAgentReminder = vi.fn()

    // First call: normal response. Second call: compaction summary. Third call: normal response after compaction.
    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ content: 'Normal response', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Final response after compaction', finishReason: 'stop' }))

    // Trigger compaction after first LLM call, then return false thereafter
    const { shouldCompact } = await import('../context/compactor.js')
    ;(shouldCompact as any).mockReturnValueOnce(true)

    await runTopLevelAgentLoop(
      makeConfig({ append, injectAgentReminder, getConversationMessages: vi.fn().mockResolvedValue([]) }),
      turnMetrics,
    )

    // Should have called streamLLM 3 times (normal → compaction → normal)
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(3)

    // Should have emitted context.compacted
    const compactedEvents = append.mock.calls
      .map((args: unknown[]) => args[0] as any)
      .filter((e: any) => e.type === 'context.compacted')
    expect(compactedEvents.length).toBe(1)

    // Should have called injectAgentReminder after compaction
    expect(injectAgentReminder).toHaveBeenCalledTimes(1)

    // Should have appended the compaction prompt
    const promptEvents = append.mock.calls
      .map((args: unknown[]) => args[0] as any)
      .filter(
        (e: any) =>
          e.type === 'message.start' &&
          e.data?.messageKind === 'auto-prompt' &&
          e.data?.content?.includes('summarizing conversations'),
      )
    expect(promptEvents.length).toBe(1)

    // Should emit chat.done at the end (normal completion)
    const chatDoneEvents = append.mock.calls
      .map((args: unknown[]) => args[0] as any)
      .filter((e: any) => e.type === 'chat.done' && e.data?.reason === 'complete')
    expect(chatDoneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('sends tool-call assistant content as empty string to the next LLM call after a failed tool', async () => {
    const append = vi.fn()
    const toolCall: ToolCall = {
      id: 'call-1',
      name: 'run_command',
      arguments: { command: 'echo hi' },
    }

    // Stateful conversation: first iteration returns only the user prompt,
    // second iteration includes the assistant tool-call msg + tool result
    const getConversationMessagesMock = vi
      .fn()
      .mockResolvedValueOnce([{ role: 'user' as const, content: 'Run a command', source: 'history' as const }])
      .mockResolvedValueOnce([
        { role: 'user' as const, content: 'Run a command', source: 'history' as const },
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [toolCall],
          source: 'history' as const,
        },
        {
          role: 'tool' as const,
          content: 'Command failed: exit code 1',
          source: 'history' as const,
          toolCallId: 'call-1',
        },
      ])

    const assembleRequestMock = vi.fn().mockReturnValue({
      systemPrompt: 'test-prompt',
      messages: [],
      tools: [],
    })

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'Command failed: exit code 1', source: 'history', toolCallId: 'call-1' }],
      stepDoneCalled: false,
    })

    await runTopLevelAgentLoop(
      makeConfig({
        append,
        assembleRequest: assembleRequestMock,
        getConversationMessages: getConversationMessagesMock,
      }),
      turnMetrics,
    )

    // Should have called streamLLM 2 times (failed tool → then final without tools)
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    // executeTools called once (second LLM call returned no tools)
    expect(executeTools).toHaveBeenCalledTimes(1)

    // assembleRequest was called for each LLM iteration
    expect(assembleRequestMock).toHaveBeenCalledTimes(2)

    // Verify the second LLM call receives the assistant message with content: ''
    const secondCallArgs = assembleRequestMock.mock.calls[1]![0] as { messages: any[] }
    const assistantMsg = secondCallArgs.messages.find((m: any) => m.role === 'assistant' && m.toolCalls?.length > 0)
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.content).toBe('')
    expect(assistantMsg.toolCalls[0].name).toBe('run_command')
    expect(assistantMsg.toolCalls[0].id).toBe('call-1')

    // Tool result follows the assistant message
    const toolMsg = secondCallArgs.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toContain('failed')
    expect(toolMsg.toolCallId).toBe('call-1')

    // Should emit chat.done at the end (normal completion)
    const chatDoneEvents = append.mock.calls
      .map((args: unknown[]) => args[0] as any)
      .filter((e: any) => e.type === 'chat.done' && e.data?.reason === 'complete')
    expect(chatDoneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('compacts before the next request when a large tool result lands after the last usage report', async () => {
    const append = vi.fn()
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 100_000,
        currentTokensKnown: true,
        maxTokens: 200_000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: true,
        dynamicContextChanged: false,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(200_000),
    })
    const toolCall: ToolCall = { id: 'call-read', name: 'read_file', arguments: { path: 'huge.txt' } }

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({
          toolCalls: [toolCall],
          finishReason: 'tool_calls',
          usage: { promptTokens: 100_000, completionTokens: 50 },
        }),
      )
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'x'.repeat(400_000), source: 'history', toolCallId: 'call-read' }],
      stepDoneCalled: false,
    })
    const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
    vi.mocked(shouldCompact).mockImplementation(
      (currentTokens, maxTokens, threshold) => currentTokens > maxTokens * threshold,
    )

    await runTopLevelAgentLoop(makeConfig({ append, sessionManager }), turnMetrics)

    // The 400k-char tool result (~100k tokens) lands AFTER the provider's last
    // usage report, so the stale gauge (100k/200k) stays under the threshold.
    // The delta must be accounted for before the next request goes out.
    expect(appendCompactionPrompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendCompactionPrompt).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(consumeStreamGenerator).mock.invocationCallOrder[1]!,
    )
    expect(vi.mocked(streamLLMPure).mock.calls[1]?.[0].tools).toEqual([])
  })

  it('switches to compaction when the input keeps overflowing the context window', async () => {
    const append = vi.fn()
    const overflowError =
      "HTTP 400: This model's maximum context length is 128000 tokens. However, you requested 190000 tokens."

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ error: overflowError }))
      .mockResolvedValueOnce(makeStreamResult({ error: overflowError }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
    vi.mocked(shouldCompact).mockReturnValue(false)

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Halving maxTokens only shrinks the OUTPUT budget — it cannot fix an input
    // that already exceeds the window. A repeated overflow must compact.
    expect(appendCompactionPrompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamLLMPure).mock.calls[2]?.[0].tools).toEqual([])
  })

  it('shrinks the history instead of failing when manual compaction overflows the window', async () => {
    const append = vi.fn()
    const history = [
      { role: 'user' as const, content: 'do the thing', source: 'history' as const },
      { role: 'tool' as const, content: 'A'.repeat(200_000), source: 'history' as const, toolCallId: 'call-1' },
      { role: 'tool' as const, content: 'B'.repeat(200_000), source: 'history' as const, toolCallId: 'call-2' },
      { role: 'assistant' as const, content: 'partial work', source: 'history' as const },
    ]
    const assembleRequest = vi.fn(async ({ messages, promptTools }: any) => ({
      systemPrompt: 'system',
      messages,
      tools: promptTools,
    }))

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(
        makeStreamResult({ error: 'HTTP 400: prompt is too long: 420000 tokens > 200000 maximum' }),
      )
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
    const { shouldCompact } = await import('../context/compactor.js')
    vi.mocked(shouldCompact).mockReturnValue(false)

    const result = await runTopLevelAgentLoop(
      makeConfig({
        append,
        initialCompacting: true,
        assembleRequest,
        getConversationMessages: vi.fn().mockResolvedValue(history),
      }),
      turnMetrics,
    )

    // Manual compaction resends the very history the model just refused. It must
    // retry on a reduced history instead of failing the user's /compact.
    expect(result.failed).toBeUndefined()
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    const firstSize = JSON.stringify(vi.mocked(streamLLMPure).mock.calls[0]![0].messages).length
    const secondSize = JSON.stringify(vi.mocked(streamLLMPure).mock.calls[1]![0].messages).length
    expect(secondSize).toBeLessThan(firstSize)
  })

  it('measures the compaction threshold against the authoritative model window', async () => {
    const append = vi.fn()
    // The tracked window is stale (a 1M-context model was selected earlier) while
    // the session now runs a 262144-token model: 260240 tokens is 26% of the stale
    // window but 99% of the real one.
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 260_240,
        maxTokens: 1_000_000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: true,
        dynamicContextChanged: false,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(262_144),
    })
    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(makeStreamResult({ content: 'Working', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
    // The pre-request gate stays quiet so the POST-TURN threshold check — the
    // third and last shouldCompact site — is actually reached.
    vi.mocked(shouldCompact)
      .mockReturnValueOnce(false)
      .mockImplementationOnce((current, max, threshold) => current > max * threshold)
      .mockReturnValue(false)

    await runTopLevelAgentLoop(makeConfig({ append, sessionManager }), turnMetrics)

    // EVERY site must weigh the count against the window this turn requests
    // with — one stale-window site is enough to skip compaction entirely.
    const windows = vi.mocked(shouldCompact).mock.calls.map(([, max]) => max)
    expect(windows.length).toBeGreaterThanOrEqual(2)
    expect(new Set(windows)).toEqual(new Set([262_144]))
    expect(appendCompactionPrompt).toHaveBeenCalledTimes(1)
    // The gauge must be emitted against that same window: resolving it without
    // the turn's mode is how one count ends up shown against two windows.
    expect(sessionManager.setCurrentContextSize).toHaveBeenCalledWith(
      'test-session',
      expect.any(Number),
      expect.any(Number),
      undefined,
      'planner',
    )
  })

  it('reduces history instead of dead-ending manual compaction on a saturated window', async () => {
    const append = vi.fn()
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 261_974,
        maxTokens: 262_144,
        compactionCount: 0,
        dangerZone: true,
        canCompact: true,
        dynamicContextChanged: false,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(262_144),
    })
    vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(
      makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }),
    )

    // A session at 100% is exactly the one that needs compaction most: refusing to
    // summarize for lack of output headroom leaves the user with no way out.
    const result = await runTopLevelAgentLoop(
      makeConfig({ append, sessionManager, initialCompacting: true }),
      turnMetrics,
    )

    expect(result.failed).toBeUndefined()
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(1)
  })

  it('invalidates the stored provider chain before continuing an interrupted stream', async () => {
    const resetResponsesChain = vi.fn()
    const llmClient = { getModel: vi.fn().mockReturnValue('test-model'), resetResponsesChain } as any
    vi.mocked(consumeStreamGenerator)
      .mockImplementationOnce(async (_stream: any, onEvent: any) => {
        onEvent({ type: 'message.delta', data: { messageId: 'partial', content: 'half a tool call' } })
        return makeStreamResult({ content: 'half a tool call', error: 'HTTP 500: upstream hiccup' })
      })
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))

    await runTopLevelAgentLoop(makeConfig({ llmClient }), turnMetrics)

    // The provider kept a native context that may end on an unconfirmed tool
    // call; replaying a user message onto it is refused with a 409.
    expect(resetResponsesChain).toHaveBeenCalledWith('test-session:top')
    expect(resetResponsesChain.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(consumeStreamGenerator).mock.invocationCallOrder[1]!,
    )
  })

  it('invalidates the stored provider chain before the compaction prompt is sent', async () => {
    const resetResponsesChain = vi.fn()
    const llmClient = { getModel: vi.fn().mockReturnValue('test-model'), resetResponsesChain } as any
    const sessionManager = createMockSessionManager({
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 180_000,
        maxTokens: 200_000,
        compactionCount: 0,
        dangerZone: true,
        canCompact: true,
        dynamicContextChanged: false,
      }),
    })
    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(makeStreamResult({ content: 'Compacted summary', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    const { shouldCompact } = await import('../context/compactor.js')
    vi.mocked(shouldCompact).mockReturnValueOnce(true).mockReturnValue(false)

    await runTopLevelAgentLoop(makeConfig({ llmClient, sessionManager }), turnMetrics)

    expect(resetResponsesChain.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(consumeStreamGenerator).mock.invocationCallOrder[0]!,
    )
  })

  it('preserves the stored provider chain when queued messages land after tool output', async () => {
    const resetResponsesChain = vi.fn()
    const llmClient = { getModel: vi.fn().mockReturnValue('test-model'), resetResponsesChain } as any
    const drainAsapMessages = vi
      .fn()
      .mockReturnValueOnce([{ content: 'also do this' }])
      .mockReturnValue([])
    const sessionManager = createMockSessionManager({ drainAsapMessages })
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: { command: 'echo hi' } }

    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    vi.mocked(executeTools).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-1' }],
      stepDoneCalled: false,
    } as any)

    await runTopLevelAgentLoop(makeConfig({ llmClient, sessionManager }), turnMetrics)

    // The stored response is exactly the boundary that owns this tool call.
    // Keep it so the next request delivers the tool result and the queued user
    // prompt as a delta. Dropping it strands the server-side resident in
    // `awaiting_result` and a full-history replay is then refused with 409.
    expect(resetResponsesChain).not.toHaveBeenCalled()
  })

  it('settles an interrupted tool call before a user message is sent behind it', async () => {
    const assembleRequest = vi.fn(async ({ messages, promptTools }: any) => ({
      systemPrompt: 'system',
      messages,
      tools: promptTools,
    }))
    // An assistant turn whose tool call never got an answer (stream cut mid-way),
    // then a user message injected behind it — the exact shape that draws
    // "unconfirmed tool call, replay is refused" / "tool output cannot be
    // followed by queued user messages".
    const history = [
      { role: 'user' as const, content: 'edit the file', source: 'history' as const },
      {
        role: 'assistant' as const,
        content: '',
        source: 'history' as const,
        toolCalls: [{ id: 'call-cut', name: 'edit_file', arguments: {} }],
      },
      { role: 'user' as const, content: 'continue where you left off', source: 'history' as const },
    ]
    vi.mocked(consumeStreamGenerator).mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))

    await runTopLevelAgentLoop(
      makeConfig({ assembleRequest, getConversationMessages: vi.fn().mockResolvedValue(history) }),
      turnMetrics,
    )

    const sent = assembleRequest.mock.calls[0]![0].messages as any[]
    const callIndex = sent.findIndex((m) => m.role === 'assistant' && m.toolCalls?.length)
    // Every call must be answered, and the answer must come BEFORE the user turn.
    expect(sent[callIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'call-cut' })
    expect(sent[callIndex + 2]).toMatchObject({ role: 'user' })
    expect(sent.filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('drops the stored chain once per broken tool call, not on every rebuild', async () => {
    const resetResponsesChain = vi.fn()
    const llmClient = { getModel: vi.fn().mockReturnValue('test-model'), resetResponsesChain } as any
    // The synthetic answer lives in the request only, so the same break is
    // re-detected on every rebuild. Re-dropping the chain each time would cost
    // the session its provider-side continuity for the rest of the run.
    const history = [
      { role: 'user' as const, content: 'edit the file', source: 'history' as const },
      {
        role: 'assistant' as const,
        content: '',
        source: 'history' as const,
        toolCalls: [{ id: 'call-cut', name: 'edit_file', arguments: {} }],
      },
      { role: 'user' as const, content: 'continue where you left off', source: 'history' as const },
    ]
    const toolCall: ToolCall = { id: 'call-next', name: 'run_command', arguments: { command: 'echo hi' } }
    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(makeStreamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    vi.mocked(executeTools).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-next' }],
      stepDoneCalled: false,
    } as any)

    await runTopLevelAgentLoop(
      makeConfig({ llmClient, getConversationMessages: vi.fn().mockResolvedValue(history) }),
      turnMetrics,
    )

    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2)
    expect(resetResponsesChain).toHaveBeenCalledTimes(1)
  })

  it('raises the output budget when a truncated tool call yields unparsable arguments', async () => {
    const append = vi.fn()
    const truncatedToolCall = () =>
      makeStreamResult({
        finishReason: 'length',
        toolCalls: [
          {
            id: 'call-edit',
            name: 'edit_file',
            arguments: {},
            parseError: 'Failed to parse tool call arguments: Unterminated string',
          },
        ],
      })
    vi.mocked(consumeStreamGenerator)
      .mockResolvedValueOnce(truncatedToolCall())
      .mockResolvedValueOnce(truncatedToolCall())
      .mockResolvedValueOnce(truncatedToolCall())
      .mockResolvedValueOnce(makeStreamResult({ content: 'Done', finishReason: 'stop' }))
    vi.mocked(executeTools).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'Failed to parse tool call arguments', toolCallId: 'call-edit' }],
      stepDoneCalled: false,
    } as any)

    const result = await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // finishReason=length means the JSON was cut off, not malformed by the model:
    // counting it as a formatting fault stops the session after three strikes
    // while the output budget is never raised.
    expect(result.failed).toBeUndefined()
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(4)
    const budgets = vi.mocked(streamLLMPure).mock.calls.map(([request]) => request.modelSettings?.maxTokens)
    expect(budgets[1]).toBeGreaterThan(budgets[0]!)
  })

  it('stops instead of looping when a bigger output budget never closes the tool arguments', async () => {
    const append = vi.fn()
    const truncatedToolCall = () =>
      makeStreamResult({
        finishReason: 'length',
        toolCalls: [
          {
            id: 'call-edit',
            name: 'edit_file',
            arguments: {},
            parseError: 'Failed to parse tool call arguments: Unterminated string',
          },
        ],
      })
    vi.mocked(consumeStreamGenerator).mockResolvedValue(truncatedToolCall())
    vi.mocked(executeTools).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'Failed to parse tool call arguments', toolCallId: 'call-edit' }],
      stepDoneCalled: false,
    } as any)

    const result = await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Once the truncation retries are spent the budget stops growing, so the
    // cut-off exemption must hand back to the malformed-tool valve — otherwise
    // the loop has no cap left and burns tokens forever.
    expect(result.failed).toBeTruthy()
    // 3 truncation retries then 3 malformed strikes — anything beyond that is
    // the runaway loop this guards against.
    expect(vi.mocked(consumeStreamGenerator).mock.calls.length).toBeLessThanOrEqual(8)
  })
})
