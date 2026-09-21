/**
 * Mode-switch loop scenario (regression).
 *
 * A session that spent a long time in Planner keeps a CRITICAL "Plan Mode —
 * read-only … MUST NOT make any edits" instruction in its conversation. After
 * switching to Builder, a model anchored on that stale block kept refusing to
 * write while the workflow nudged it again and again — an infinite loop.
 *
 * This test reproduces the situation end to end at the orchestrator level:
 *  - the conversation carries the stale read-only block AND a Builder history,
 *  - `runAgentTurn` injects the per-turn reminder,
 *  - a scripted model that OBEYS the stale block unless it is explicitly
 *    superseded decides between refusing and calling write_file.
 *
 * It must FAIL when either fix is reverted:
 *  - `setMode` persisting the mode (the session must be seen as Builder), and
 *  - the superseding reminder (prompts.buildAgentSmallReminder).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getEventStoreMock,
  getContextMessagesMock,
  getCurrentContextWindowIdMock,
  getAllInstructionsMock,
  getToolRegistryForModeMock,
  createToolProgressHandlerMock,
  streamLLMPureMock,
  consumeStreamGeneratorMock,
  getConversationMessagesMock,
  processEventsForConversationMock,
} = vi.hoisted(() => ({
  getEventStoreMock: vi.fn(),
  getContextMessagesMock: vi.fn(),
  getCurrentContextWindowIdMock: vi.fn(),
  getAllInstructionsMock: vi.fn(),
  getToolRegistryForModeMock: vi.fn(),
  createToolProgressHandlerMock: vi.fn(() => undefined),
  streamLLMPureMock: vi.fn(),
  consumeStreamGeneratorMock: vi.fn(),
  getConversationMessagesMock: vi.fn(
    (_options?: unknown): import('./request-context.js').RequestContextMessage[] => [],
  ),
  processEventsForConversationMock: vi.fn(async () => []),
}))

vi.mock('../events/index.js', () => ({
  getEventStore: getEventStoreMock,
  getContextMessages: getContextMessagesMock,
  getCurrentContextWindowId: getCurrentContextWindowIdMock,
  getCurrentWindowMessageOptions: vi.fn((sessionId: string) => {
    const id = getCurrentContextWindowIdMock(sessionId)
    return id ? { contextWindowId: id } : undefined
  }),
}))

vi.mock('./conversation-history.js', () => ({
  getConversationMessages: getConversationMessagesMock,
  processEventsForConversation: processEventsForConversationMock,
}))

vi.mock('../db/settings.js', () => ({
  getSetting: vi.fn().mockReturnValue('false'),
  SETTINGS_KEYS: { LLM_DYNAMIC_SYSTEM_PROMPT: 'llm.dynamicSystemPrompt' },
}))

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: getAllInstructionsMock,
  toInjectedFiles: (files: unknown[]) => files as unknown,
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn(async () => []),
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn(() => ({
    mode: 'development',
    context: { maxTokens: 200000, compactionThreshold: 0.85, compactionTarget: 0.6 },
    agent: { toolTimeout: 120000 },
    llm: {
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      timeout: 30000,
      idleTimeout: 30000,
      backend: 'ollama',
    },
  })),
  setRuntimeConfig: vi.fn(),
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/openfox-test'),
}))

vi.mock('../tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/index.js')>()
  return {
    ...actual,
    getToolRegistryForMode: getToolRegistryForModeMock,
    getToolRegistryForAgent: vi.fn().mockImplementation((agentDef: { metadata?: { mode?: string } }) => {
      return getToolRegistryForModeMock(agentDef?.metadata?.mode ?? 'planner')
    }),
  }
})

vi.mock('./tool-streaming.js', () => ({
  createToolProgressHandler: createToolProgressHandlerMock,
}))

vi.mock('./stream-pure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stream-pure.js')>()
  return {
    ...actual,
    streamLLMPure: streamLLMPureMock,
    consumeStreamGenerator: consumeStreamGeneratorMock,
  }
})

vi.mock('../agents/registry.js', () => {
  const agents = [
    {
      metadata: {
        id: 'planner',
        name: 'Planner',
        description: 'Plans work',
        subagent: false,
        allowedTools: ['read_file', 'run_command'],
      },
      prompt:
        '# Plan Mode\n\nCRITICAL: Plan mode ACTIVE - you are in read-only phase.\n\n' +
        'You MUST NOT make any edits, implementations, commits, config changes, or other system modifications.',
    },
    {
      metadata: {
        id: 'builder',
        name: 'Builder',
        description: 'Builds work',
        subagent: false,
        allowedTools: ['read_file', 'write_file', 'edit_file', 'run_command'],
      },
      prompt:
        '# Build Mode\n\nCRITICAL: Build mode ACTIVE - implementation is now allowed.\n\n' +
        'You may read files, edit files, run commands, and use tools as needed.',
    },
  ]
  return {
    loadBuiltinAgents: vi.fn(async () => agents),
    loadAllAgentsDefault: vi.fn(async () => agents),
    findAgentById: vi.fn((id: string, list: Array<{ metadata: { id: string } }>) =>
      list.find((a) => a.metadata.id === id),
    ),
    getSubAgents: vi.fn((list: Array<{ metadata: { subagent: boolean } }>) => list.filter((a) => a.metadata.subagent)),
    resolveDefaultAgentId: vi.fn(() => 'planner'),
  }
})

import { TurnMetrics, runAgentTurn } from './orchestrator.js'

/** The stale instruction a long Planner history leaves in the conversation. */
const STALE_READ_ONLY_BLOCK =
  '# Plan Mode\n\nCRITICAL: Plan mode ACTIVE - you are in read-only phase.\n\n' +
  'You MUST NOT make any edits, implementations, commits, config changes, or other system modifications.'

const REFUSAL_TEXT = 'Je ne peux pas effectuer l’écriture : cette session est limitée à la lecture seule.'

function createEventStore() {
  const eventsBySession = new Map<
    string,
    Array<{ seq: number; sessionId: string; timestamp: number; type: string; data: unknown }>
  >()
  return {
    upsertMessageCheckpoint: vi.fn(),
    deleteMessageCheckpoint: vi.fn(),
    publish: vi.fn(),
    append: vi.fn((sessionId: string, event: { type: string; data: unknown }) => {
      const existing = eventsBySession.get(sessionId) ?? []
      const stored = { seq: existing.length + 1, sessionId, timestamp: Date.now(), type: event.type, data: event.data }
      eventsBySession.set(sessionId, [...existing, stored])
      return stored
    }),
    getEvents: vi.fn((sessionId: string) => eventsBySession.get(sessionId) ?? []),
    getAllEvents: vi.fn((sessionId: string) => eventsBySession.get(sessionId) ?? []),
    getLatestSeq: vi.fn((sessionId: string) => (eventsBySession.get(sessionId) ?? []).at(-1)?.seq ?? null),
    cleanupOldEvents: vi.fn(() => 0),
    getLatestSnapshot: vi.fn(() => undefined),
  }
}

/** A system-generated agent reminder, as the orchestrator writes them. */
function agentReminderEvent(name: string, content: string) {
  return {
    type: 'message.start',
    data: {
      messageId: `reminder-${name}-${Math.random()}`,
      role: 'user',
      content,
      isSystemGenerated: true,
      messageKind: 'auto-prompt',
      metadata: { type: 'agent', name },
    },
  }
}

function createSessionManager(state: Record<string, any>) {
  const contextState = {
    currentTokens: 0,
    maxTokens: 200000,
    compactionCount: 0,
    dangerZone: false,
    canCompact: false,
    dynamicContextChanged: false,
  }
  return {
    requireSession: vi.fn(() => structuredClone(state['current'])),
    getSession: vi.fn(() => structuredClone(state['current'])),
    getCurrentWindowMessages: vi.fn(() => state['current'].messages ?? []),
    getContextState: vi.fn(() => ({ ...contextState })),
    getCurrentModelContext: vi.fn(() => 200000),
    setCurrentContextSize: vi.fn(),
    addTokensUsed: vi.fn(),
    getCurrentModelSettings: vi.fn(() => undefined),
    getLspManager: vi.fn(() => ({ name: 'lsp' })),
    getEffectiveWorkdir: vi.fn(() => state['current']?.workdir ?? '/test'),
    getProjectWorkdir: vi.fn(() => state['current']?.workdir ?? '/test'),
    setRunning: vi.fn(),
    getCachedPrompt: vi.fn(() => undefined),
    setCachedPrompt: vi.fn(),
    getDynamicContextChanged: vi.fn(() => false),
    setDynamicContextChanged: vi.fn(),
    getAnnouncedPromptHash: vi.fn(() => undefined),
    setAnnouncedPromptHash: vi.fn(),
    getAnnouncedToolFingerprint: vi.fn(() => undefined),
    setAnnouncedToolFingerprint: vi.fn(),
    clearDebugDump: vi.fn(),
    updateCriterionStatus: vi.fn(),
    addCriterionAttempt: vi.fn(),
    addMessage: vi.fn(() => ({
      id: crypto.randomUUID(),
      role: 'user',
      content: '',
      timestamp: new Date().toISOString(),
    })),
    addAssistantMessage: vi.fn(() => ({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    })),
    updateMessage: vi.fn(),
    updateMessageStats: vi.fn(),
    drainAsapMessages: vi.fn(() => []),
    updateExecutionState: vi.fn(),
    getModelCompactionThreshold: vi.fn(() => undefined),
    getProviderManager: vi.fn(() => ({
      getLLMClient: () => ({ getModel: () => 'test-model' }),
      createClient: vi.fn(),
      getProviders: vi.fn(() => []),
    })),
    createClientForAgent: vi.fn(() => ({ getModel: () => 'test-model' })),
    enterPauseGate: vi.fn().mockResolvedValue('released'),
  }
}

function makeTurnResponse(content: string, toolCalls: Array<{ id: string; name: string; arguments: unknown }>) {
  return {
    content,
    toolCalls,
    segments: content ? [{ type: 'text' as const, content }] : [],
    usage: { promptTokens: 20, completionTokens: 8 },
    timing: { ttft: 1, completionTime: 2, tps: 4, prefillTps: 20 },
    aborted: false,
    finishReason: 'stop',
  }
}

describe('mode-switch loop: a stale read-only history must not block a builder turn', () => {
  beforeEach(() => {
    getEventStoreMock.mockReset()
    getContextMessagesMock.mockReset().mockReturnValue([])
    getCurrentContextWindowIdMock.mockReset().mockReturnValue(undefined)
    getConversationMessagesMock.mockReset().mockReturnValue([])
    processEventsForConversationMock.mockReset().mockResolvedValue([])
    getAllInstructionsMock.mockReset().mockResolvedValue({ content: '', files: [] })
    getToolRegistryForModeMock.mockReset()
    createToolProgressHandlerMock.mockClear()
    streamLLMPureMock.mockReset()
    consumeStreamGeneratorMock.mockReset()
  })

  it('calls write_file instead of refusing, because the reminder supersedes the stale block', async () => {
    const store = createEventStore()
    getEventStoreMock.mockReturnValue(store)

    // History: the Planner reminder (carrying the stale read-only block), then a
    // Builder reminder — so the per-turn reminder takes the SMALL path, which is
    // exactly where the superseding notice lives.
    store.append('session-1', agentReminderEvent('Planner', STALE_READ_ONLY_BLOCK))
    store.append('session-1', agentReminderEvent('Builder', '# Build Mode'))

    // The conversation still contains the stale read-only block (a long Planner
    // history) plus the user's actual request. Agent reminders injected into the
    // event store are appended, as the real conversation builder does.
    const seededConversation = [
      { role: 'user', content: STALE_READ_ONLY_BLOCK, source: 'history' },
      { role: 'assistant', content: 'Je ne peux pas écrire : session en lecture seule.', source: 'history' },
      { role: 'user', content: 'Écris le fichier résultat.txt', source: 'history' },
    ]
    getConversationMessagesMock.mockImplementation((options?: unknown) => {
      const sessionId = (options as { sessionId?: string } | undefined)?.sessionId ?? 'session-1'
      const injected = (store.getAllEvents(sessionId) ?? [])
        .filter((e) => {
          const data = e.data as { isSystemGenerated?: boolean; metadata?: { type?: string } }
          return e.type === 'message.start' && data?.isSystemGenerated === true && data?.metadata?.type === 'agent'
        })
        .map((e) => ({ role: 'user', content: (e.data as { content: string }).content, source: 'history' }))
      return [...seededConversation, ...injected] as never
    })

    const execute = vi.fn().mockResolvedValue({ success: true, output: 'written', durationMs: 1, truncated: false })
    getToolRegistryForModeMock.mockReturnValue({
      tools: [{ name: 'write_file' }],
      definitions: [{ type: 'function', function: { name: 'write_file', description: 'Write', parameters: {} } }],
      execute,
    })

    // The scripted model: it OBEYS the stale read-only block unless the context
    // explicitly supersedes it (this is the anchoring behaviour that looped).
    let contextText = ''
    streamLLMPureMock.mockImplementation((request: { messages: Array<{ content?: unknown }> }) => {
      contextText = JSON.stringify(request.messages ?? [])
      return { kind: 'stream' }
    })
    let llmCall = 0
    consumeStreamGeneratorMock.mockImplementation(() => {
      llmCall += 1
      const staleBlockPresent = /Plan Mode/i.test(contextText) && /read-only/i.test(contextText)
      const superseded = /superseded/i.test(contextText)
      if (staleBlockPresent && !superseded) {
        return makeTurnResponse(REFUSAL_TEXT, [])
      }
      // Act once, then finish the turn (otherwise the loop would call the tool
      // forever — which is what a real refusal-free model would do).
      if (llmCall === 1) {
        return makeTurnResponse('', [
          { id: 'call-1', name: 'write_file', arguments: { path: 'résultat.txt', content: 'fait' } },
        ])
      }
      return makeTurnResponse('Terminé.', [])
    })

    const append = vi.fn()
    const sessionManager = createSessionManager({
      current: {
        id: 'session-1',
        projectId: 'project-1',
        workdir: '/tmp/project',
        mode: 'builder',
        phase: 'build',
        isRunning: true,
        criteria: [],
        executionState: { currentTokenCount: 0, compactionCount: 0 },
        messages: [{ id: 'user-1', role: 'user', content: 'Écris le fichier résultat.txt' }],
        metadataEntries: {},
      },
    })

    await runAgentTurn(
      {
        sessionManager: sessionManager as never,
        sessionId: 'session-1',
        llmClient: { getModel: () => 'test-model' } as never,
        onMessage: vi.fn(),
      },
      new TurnMetrics(),
      'builder',
      append,
    )

    // 1) The injected reminder must explicitly supersede the stale instruction.
    expect(contextText).toMatch(/superseded/i)
    // 2) The model therefore attempted the write instead of repeating a refusal.
    const appendedEvents = append.mock.calls.map((call: unknown[]) => call[0] as { type: string; data?: unknown })
    expect(appendedEvents.map((e) => e.type)).toContain('tool.call')
    const toolCallEvent = appendedEvents.find((e) => e.type === 'tool.call')
    const toolCallData = toolCallEvent?.data as { toolCall?: { name?: string } } | undefined
    expect(toolCallData?.toolCall?.name).toBe('write_file')
    // 3) The refusal text is never produced.
    expect(contextText).not.toContain(REFUSAL_TEXT)
    expect(consumeStreamGeneratorMock).toHaveBeenCalled()
  })
})
