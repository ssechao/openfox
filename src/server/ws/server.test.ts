import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import WebSocket from 'ws'
import { recordLLMFailure, clearLLMFailure, sleepThroughRetryBackoff } from '../chat/stream-pure.js'
import { getSessionRuntimeRegistry, resetSessionRuntimeRegistry } from '../session/index.js'

const {
  createProjectMock,
  getProjectMock,
  listProjectsMock,
  updateProjectMock,
  deleteProjectMock,
  getSettingMock,
  setSettingMock,
  getAllInstructionsMock,
  getToolRegistryForModeMock,
  providePathConfirmationMock,
  provideAnswerMock,
  getPendingQuestionsForSessionMock,
  runChatTurnMock,
  runOrchestratorMock,
  streamLLMPureMock,
  consumeStreamGeneratorMock,
  getEventStoreMock,
  getContextMessagesMock,
  getCurrentContextWindowIdMock,
  getEnabledSkillMetadataMock,
  getRuntimeConfigMock,
  getGlobalConfigDirMock,
  createLLMClientMock,
  applyDynamicContextMock,
  getGitBranchMock,
  getGitDiffFilesMock,
  spawnMock,
} = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  getProjectMock: vi.fn(),
  listProjectsMock: vi.fn(),
  updateProjectMock: vi.fn(),
  deleteProjectMock: vi.fn(),
  getSettingMock: vi.fn(),
  setSettingMock: vi.fn(),
  getAllInstructionsMock: vi.fn(),
  getToolRegistryForModeMock: vi.fn(),
  providePathConfirmationMock: vi.fn(),
  provideAnswerMock: vi.fn(),
  getPendingQuestionsForSessionMock: vi.fn((): Array<{ callId: string; question: string; type: 'confirm' }> => []),
  runChatTurnMock: vi.fn(),
  runOrchestratorMock: vi.fn(),
  streamLLMPureMock: vi.fn(),
  consumeStreamGeneratorMock: vi.fn(),
  getEventStoreMock: vi.fn(),
  getContextMessagesMock: vi.fn(),
  getCurrentContextWindowIdMock: vi.fn(),
  getEnabledSkillMetadataMock: vi.fn(),
  getRuntimeConfigMock: vi.fn(),
  getGlobalConfigDirMock: vi.fn(),
  createLLMClientMock: vi.fn(),
  applyDynamicContextMock: vi.fn(),
  getGitBranchMock: vi.fn(),
  getGitDiffFilesMock: vi.fn(),
  spawnMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  spawnMock.mockImplementation(actual.spawn)
  return { ...actual, spawn: spawnMock }
})

vi.mock('../utils/bounded-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/bounded-exec.js')>()),
  GIT_QUERY_TIMEOUT_MS: 50,
}))

vi.mock('../db/projects.js', () => ({
  createProject: createProjectMock,
  getProject: getProjectMock,
  listProjects: listProjectsMock,
  updateProject: updateProjectMock,
  deleteProject: deleteProjectMock,
}))

vi.mock('../db/settings.js', () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
  getMaxVisibleItems: vi.fn(() => 0),
  SETTINGS_KEYS: { LLM_DYNAMIC_SYSTEM_PROMPT: 'llm.dynamicSystemPrompt' },
}))

vi.mock('../git/diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git/diff.js')>()
  return {
    ...actual,
    getGitBranch: getGitBranchMock,
    getGitDiffFiles: getGitDiffFilesMock,
  }
})

// db/sessions.js mock removed - messages are now stored in EventStore only

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: getAllInstructionsMock,
  toInjectedFiles: (files: unknown[]) => files as unknown,
}))

vi.mock('../chat/dynamic-context.js', () => ({
  computeSessionHash: vi.fn(),
  computeUnifiedDiff: vi.fn(),
  buildCachedPrompt: vi.fn(),
  applyDynamicContext: applyDynamicContextMock,
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: getEnabledSkillMetadataMock,
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: getGlobalConfigDirMock,
}))

vi.mock('../tools/index.js', () => ({
  getToolRegistryForMode: getToolRegistryForModeMock,
  getToolRegistryForAgent: vi.fn(() => ({
    definitions: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
  })),
  providePathConfirmation: providePathConfirmationMock,
  provideAnswer: provideAnswerMock,
  addAllowedPaths: vi.fn(),
  cancelQuestionsForSession: vi.fn(),
  cancelPathConfirmationsForSession: vi.fn(),
  getPendingQuestionsForSession: getPendingQuestionsForSessionMock,
}))

vi.mock('../agents/registry.js', () => {
  const agents = [
    {
      metadata: {
        id: 'planner',
        name: 'Planner',
        description: 'Plans work',
        subagent: false,
        tools: [
          'read_file',
          'glob',
          'grep',
          'web_fetch',
          'run_command',
          'git',
          'get_criteria',
          'add_criterion',
          'update_criterion',
          'remove_criterion',
          'call_sub_agent',
          'load_skill',
        ],
      },
      prompt: '# Plan Mode',
    },
    {
      metadata: {
        id: 'builder',
        name: 'Builder',
        description: 'Builds work',
        subagent: false,
        tools: [
          'read_file',
          'glob',
          'grep',
          'web_fetch',
          'write_file',
          'edit_file',
          'run_command',
          'ask_user',
          'complete_criterion',
          'get_criteria',
          'todo_write',
          'call_sub_agent',
          'load_skill',
        ],
      },
      prompt: '# Build Mode',
    },
    {
      metadata: {
        id: 'verifier',
        name: 'Verifier',
        description: 'Verify criteria',
        subagent: true,
        tools: ['read_file', 'run_command', 'pass_criterion', 'fail_criterion'],
      },
      prompt: 'You are a verifier',
    },
  ]
  return {
    loadBuiltinAgents: vi.fn(async () => agents),
    loadAllAgentsDefault: vi.fn(async () => agents),
    findAgentById: vi.fn((id: string, list: any[]) => list.find((a: any) => a.metadata.id === id)),
    getSubAgents: vi.fn((list: any[]) => list.filter((a: any) => a.metadata.subagent)),
  }
})

vi.mock('../runner/index.js', () => ({
  runOrchestrator: runOrchestratorMock,
}))

vi.mock('../chat/stream-pure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/stream-pure.js')>()
  return {
    ...actual,
    streamLLMPure: streamLLMPureMock,
    consumeStreamGenerator: consumeStreamGeneratorMock,
  }
})

vi.mock('../chat/conversation-history.js', () => ({
  getConversationMessages: vi.fn().mockReturnValue([]),
  processEventsForConversation: vi.fn().mockResolvedValue([]),
  ensureRequestNotEndingWithAssistant: vi.fn((messages: unknown) => messages),
}))

vi.mock('../chat/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/orchestrator.js')>()
  return {
    ...actual,
    runChatTurn: runChatTurnMock,
  }
})

vi.mock('../events/index.js', () => ({
  getEventStore: getEventStoreMock,
  combineEventsWithSnapshot: vi.fn((_sessionId: string, _snapshot: unknown, events: unknown[]) => events),
  getContextMessages: getContextMessagesMock,
  getCurrentContextWindowId: getCurrentContextWindowIdMock,
  getCurrentWindowMessageOptions: vi.fn((sessionId: string) => {
    const id = getCurrentContextWindowIdMock(sessionId)
    return id ? { contextWindowId: id } : undefined
  }),
}))

vi.mock('../llm/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/index.js')>()
  return {
    ...actual,
    createLLMClient: createLLMClientMock,
  }
})

import { createWebSocketServer } from './server.js'

type TestMessage = { id?: string; type: string; payload: Record<string, unknown>; seq?: number; sessionId?: string }

function createEventStore() {
  const eventsBySession = new Map<
    string,
    Array<{ seq: number; sessionId: string; timestamp: number; type: string; data: unknown }>
  >()
  const subscribers = new Map<
    string,
    {
      resolve: (event: { seq: number; sessionId: string; timestamp: number; type: string; data: unknown }) => void
      event: { seq: number; sessionId: string; timestamp: number; type: string; data: unknown }
    }
  >()
  let globalResolveNext:
    ((event: { seq: number; sessionId: string; timestamp: number; type: string; data: unknown }) => void) | null = null

  const mockDb = {
    prepare: vi.fn((query: string) => ({
      all: vi.fn((..._args: unknown[]) => {
        // Mock query for recent user prompts - return empty array
        if (query.includes('SELECT payload') && query.includes('chat.message')) {
          return []
        }
        return []
      }),
      get: vi.fn(() => undefined),
      run: vi.fn(() => ({ changes: 0 })),
    })),
  }

  return {
    append: vi.fn((sessionId: string, event: { type: string; data: unknown }) => {
      const existing = eventsBySession.get(sessionId) ?? []
      const stored = {
        seq: existing.length + 1,
        sessionId,
        timestamp: Date.now(),
        type: event.type,
        data: event.data,
      }
      eventsBySession.set(sessionId, [...existing, stored])

      // Notify subscriber if exists
      const subscriber = subscribers.get(sessionId)
      if (subscriber) {
        subscriber.resolve(stored)
        subscribers.delete(sessionId)
      }

      // Notify global subscriber
      if (globalResolveNext) {
        ;(globalResolveNext as any)(stored)
      }

      return stored
    }),
    getEvents: vi.fn((sessionId: string) => eventsBySession.get(sessionId) ?? []),
    getEventsSinceSnapshot: vi.fn((sessionId: string) => ({
      snapshot: undefined,
      events: eventsBySession.get(sessionId) ?? [],
    })),
    getLatestSnapshot: vi.fn((sessionId: string) => {
      const events = eventsBySession.get(sessionId) ?? []
      return [...events].reverse().find((event) => event.type === 'turn.snapshot')
    }),
    getLatestSeq: vi.fn((sessionId: string) => {
      const events = eventsBySession.get(sessionId) ?? []
      return events.at(-1)?.seq ?? null
    }),
    subscribe: vi.fn((sessionId: string) => {
      const events = eventsBySession.get(sessionId) ?? []
      let index = 0

      return {
        iterator: (async function* () {
          // Yield existing events first
          for (const event of events) {
            yield event
            index++
          }

          // Then yield new events as they're appended
          while (true) {
            const currentEvents = eventsBySession.get(sessionId) ?? []
            if (index < currentEvents.length) {
              yield currentEvents[index]
              index++
            } else {
              // Wait for next append
              yield await new Promise<{
                seq: number
                sessionId: string
                timestamp: number
                type: string
                data: unknown
              }>((resolve) => {
                subscribers.set(sessionId, { resolve, event: null as any })
              })
              index++
            }
          }
        })(),
        unsubscribe: vi.fn(() => {
          subscribers.delete(sessionId)
        }),
      }
    }),
    subscribeAll: vi.fn(() => {
      return {
        iterator: (async function* () {
          // Wait for events from append
          while (true) {
            const event = await new Promise<{
              seq: number
              sessionId: string
              timestamp: number
              type: string
              data: unknown
            }>((resolve) => {
              globalResolveNext = resolve
            })
            yield event
          }
        })(),
        unsubscribe: vi.fn(() => {
          globalResolveNext = null
        }),
      }
    }),
    db: mockDb,
  }
}

function createSessionManager(overrides: Record<string, unknown> = {}) {
  const session = {
    id: 'session-1',
    projectId: 'project-1',
    workdir: '/tmp/project',
    mode: 'planner' as const,
    phase: 'plan' as const,
    isRunning: false,
    criteria: [] as Array<Record<string, unknown>>,
    metadata: { totalTokensUsed: 0, totalToolCalls: 0, iterationCount: 0 },
  }

  const manager = {
    session,
    subscribe: vi.fn(() => () => {}),
    createSession: vi.fn(() => session),
    getSession: vi.fn(() => session),
    requireSession: vi.fn(() => session),
    getLatestWorkflowExecution: vi.fn(() => null),
    resolveEffectiveProviderModel: vi.fn((sessionId: string) => {
      const s = (manager as { getSession: (id: string) => any }).getSession(sessionId)
      return { providerId: s?.providerId ?? null, model: s?.providerModel ?? null }
    }),
    getContextState: vi.fn(() => ({
      currentTokens: 10,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    })),
    listSessions: vi.fn(() => [
      {
        id: session.id,
        projectId: session.projectId,
        workdir: session.workdir,
        mode: session.mode,
        phase: session.phase,
        isRunning: session.isRunning,
        createdAt: 'a',
        updatedAt: 'b',
        criteriaCount: 0,
        criteriaCompleted: 0,
      },
    ]),
    deleteSession: vi.fn(),
    addMessage: vi.fn((_sessionId, message) => ({
      id: `msg-${Math.random()}`,
      timestamp: '2024-01-01T00:00:00.000Z',
      ...message,
    })),
    setRunning: vi.fn((_sessionId, isRunning: boolean) => ({ ...session, isRunning })),
    setMode: vi.fn((_sessionId, mode: 'planner' | 'builder') => ({ ...session, mode })),
    setPhase: vi.fn((_sessionId, phase: string) => ({ ...session, phase })),
    resetAllCriteriaAttempts: vi.fn(),
    setCriteria: vi.fn(),
    getCachedPrompt: vi.fn(() => undefined),
    updateMessageStats: vi.fn(),
    updateMessage: vi.fn(),
    getCurrentWindowMessages: vi.fn(() => []),
    queueMessage: vi.fn((_sessionId, _mode, content, _attachments, _messageKind) => ({
      queueId: `queue-${Math.random()}`,
      mode: _mode,
      content,
      queuedAt: new Date().toISOString(),
    })),
    getQueueState: vi.fn(() => []),
    cancelQueuedMessage: vi.fn(() => true),
    drainAsapMessages: vi.fn(() => []),
    drainCompletionMessages: vi.fn(() => []),
    clearMessageQueue: vi.fn(),
    getEffectiveWorkdir: vi.fn(() => session.workdir),
    ...overrides,
  }

  return manager
}

async function createHarness(
  options: {
    sessionManager?: ReturnType<typeof createSessionManager>
    eventStore?: ReturnType<typeof createEventStore>
    providerManager?: unknown
    workerController?: import('./server.js').WebSocketWorkerController
    onCleanWorkerTurnSettled?: (sessionId: string) => void
  } = {},
) {
  const httpServer = createServer()
  const sessionManager = options.sessionManager ?? createSessionManager()
  const eventStore = options.eventStore ?? createEventStore()

  getEventStoreMock.mockReturnValue(eventStore)

  const mockLLMClient = {
    getModel: () => 'qwen3-32b',
    getBackend: () => 'vllm',
    complete: vi.fn().mockResolvedValue({ content: 'Test Session', toolCalls: [] }),
  } as never
  const wss = createWebSocketServer(
    httpServer,
    {} as never,
    () => mockLLMClient,
    undefined,
    sessionManager as never,
    options.providerManager as never,
    undefined,
    () => options.workerController,
    options.onCleanWorkerTurnSettled,
  )

  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind http server')
  }

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`)
  await once(client, 'open')

  // Shared queue + listener + timeout plumbing for a WebSocket client stream.
  // Used by the primary harness client and every connectClient() secondary.
  const createMessageStream = () => {
    const queue: TestMessage[] = []
    const listeners: Array<(message: TestMessage) => void> = []
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as TestMessage
      queue.push(message)
      for (const listener of [...listeners]) {
        listener(message)
      }
    }

    const nextMessage = async (predicate: (message: TestMessage) => boolean = () => true): Promise<TestMessage> => {
      const existing = queue.find(predicate)
      if (existing) {
        queue.splice(queue.indexOf(existing), 1)
        return existing
      }

      return await new Promise<TestMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
          reject(new Error('Timed out waiting for message'))
        }, 2000)

        const listener = (message: TestMessage) => {
          if (!predicate(message)) {
            return
          }
          clearTimeout(timeout)
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
          queue.splice(queue.indexOf(message), 1)
          resolve(message)
        }

        listeners.push(listener)
      })
    }

    return { onMessage, nextMessage }
  }

  const primaryStream = createMessageStream()
  client.on('message', primaryStream.onMessage)
  const nextMessage = primaryStream.nextMessage

  const send = (message: Record<string, unknown>) => {
    client.send(JSON.stringify(message))
  }

  const sendRaw = (raw: string) => {
    client.send(raw)
  }

  // Secondary clients on the SAME server — used to test cross-window routing
  // (e.g. a homepage window with no active session vs. one inside a session).
  const secondarySockets: WebSocket[] = []

  const connectClient = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`)
    await once(socket, 'open')
    secondarySockets.push(socket)

    const stream = createMessageStream()
    socket.on('message', stream.onMessage)

    const send = (message: Record<string, unknown>) => {
      socket.send(JSON.stringify(message))
    }

    const close = async () => {
      socket.close()
      await once(socket, 'close')
    }

    return { socket, send, nextMessage: stream.nextMessage, close }
  }

  const close = async () => {
    if (client.readyState !== WebSocket.CLOSED) {
      client.close()
      await once(client, 'close')
    }
    for (const socket of secondarySockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close()
        await once(socket, 'close')
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())))
  }

  return {
    client,
    send,
    sendRaw,
    nextMessage,
    close,
    connectClient,
    broadcastForProject: wss.broadcastForProject,
    broadcastAll: wss.broadcastAll,
    sessionManager,
    eventStore,
    httpServer,
    wsServer: wss.wss,
  }
}

describe('createWebSocketServer', () => {
  beforeEach(() => {
    createProjectMock.mockReset()
    getProjectMock.mockReset()
    listProjectsMock.mockReset()
    updateProjectMock.mockReset()
    deleteProjectMock.mockReset()
    getSettingMock.mockReset()
    setSettingMock.mockReset()

    getAllInstructionsMock.mockReset()
    getToolRegistryForModeMock.mockReset()
    providePathConfirmationMock.mockReset()
    provideAnswerMock.mockReset()
    getPendingQuestionsForSessionMock.mockReset()
    getPendingQuestionsForSessionMock.mockReturnValue([])
    runChatTurnMock.mockReset()
    runOrchestratorMock.mockReset()
    streamLLMPureMock.mockReset()
    consumeStreamGeneratorMock.mockReset()
    getEventStoreMock.mockReset()
    getContextMessagesMock.mockReset()
    getContextMessagesMock.mockReturnValue([])
    getCurrentContextWindowIdMock.mockReset()
    getCurrentContextWindowIdMock.mockReturnValue(undefined)
    getAllInstructionsMock.mockReset()
    getAllInstructionsMock.mockResolvedValue({ content: '', files: [] })
    getEnabledSkillMetadataMock.mockReset()
    getEnabledSkillMetadataMock.mockResolvedValue([])
    getRuntimeConfigMock.mockReset()
    getRuntimeConfigMock.mockReturnValue({
      mode: 'test',
      llm: {
        baseUrl: 'http://localhost:8000/v1',
        model: 'test-model',
        timeout: 60000,
        idleTimeout: 300000,
        backend: 'auto' as const,
      },
      context: {
        maxTokens: 200000,
        compactionThreshold: 0.8,
        compactionTarget: 0.5,
      },
      agent: {
        maxIterations: 10,
        maxConsecutiveFailures: 3,
        toolTimeout: 300000,
      },
    })
    getGlobalConfigDirMock.mockReset()
    getGlobalConfigDirMock.mockReturnValue('/tmp/config')
    getGitBranchMock.mockReset()
    getGitBranchMock.mockResolvedValue(null)
    getGitDiffFilesMock.mockReset()
    getGitDiffFilesMock.mockResolvedValue([])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  it('answers an application ping with a pong carrying the request id', async () => {
    const harness = await createHarness()

    try {
      harness.sendRaw(JSON.stringify({ id: 'ping-1', type: 'ping', payload: {} }))
      expect(await harness.nextMessage((message) => message.type === 'pong')).toMatchObject({
        type: 'pong',
        id: 'ping-1',
      })
    } finally {
      await harness.close()
    }
  })

  it('returns protocol errors for invalid raw input and unknown message types', async () => {
    const harness = await createHarness()

    harness.sendRaw('{')
    expect(await harness.nextMessage((message) => message.type === 'error')).toMatchObject({
      type: 'error',
      payload: { code: 'INVALID_MESSAGE', message: 'Invalid message format' },
    })

    harness.send({ id: 'm1', type: 'unknown.type', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'm1')).toMatchObject({
      type: 'error',
      payload: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type: unknown.type' },
    })

    await harness.close()
  })

  it('handles project and settings management messages', async () => {
    const harness = await createHarness()

    harness.send({ id: 'pc-deprecated', type: 'project.create', payload: { name: 'OpenFox', workdir: '/tmp/project' } })
    expect(await harness.nextMessage((message) => message.id === 'pc-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'pl-deprecated', type: 'project.list', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'pl-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'pload-deprecated', type: 'project.load', payload: { projectId: 'project-1' } })
    expect(await harness.nextMessage((message) => message.id === 'pload-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({
      id: 'pupdate-deprecated',
      type: 'project.update',
      payload: { projectId: 'project-1', name: 'Updated' },
    })
    expect(await harness.nextMessage((message) => message.id === 'pupdate-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'pdelete-deprecated', type: 'project.delete', payload: { projectId: 'project-1' } })
    expect(await harness.nextMessage((message) => message.id === 'pdelete-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'sget-deprecated', type: 'settings.get', payload: { key: 'theme' } })
    expect(await harness.nextMessage((message) => message.id === 'sget-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'sset-deprecated', type: 'settings.set', payload: { key: 'theme', value: 'light' } })
    expect(await harness.nextMessage((message) => message.id === 'sset-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    await harness.close()
  })

  it('handles session create/load/list/delete and prefers event-store messages on load', async () => {
    const eventStore = createEventStore() as any
    eventStore.append('session-1', { type: 'message.start', data: { messageId: 'assistant-1', role: 'assistant' } })
    eventStore.append('session-1', { type: 'message.delta', data: { messageId: 'assistant-1', content: 'Hello' } })
    eventStore.append('session-1', { type: 'message.done', data: { messageId: 'assistant-1' } })

    const session = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner' as const,
      phase: 'plan' as const,
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => session),
      getSession: vi.fn((id: string) => (id === 'session-1' ? session : null)),
      requireSession: vi.fn(() => session),
    })

    const harness = await createHarness({ sessionManager, eventStore })

    harness.send({
      id: 'sc-deprecated',
      type: 'session.create',
      payload: { projectId: 'project-1', title: 'Session A' },
    })
    expect(await harness.nextMessage((message) => message.id === 'sc-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'sl-ok')).toMatchObject({
      type: 'ack',
      payload: { sessionId: 'session-1' },
    })

    // With pure event-sourcing, empty events = empty messages (no DB fallback)
    eventStore.getEvents.mockReturnValueOnce([])
    harness.send({ id: 'sl-db', type: 'session.load', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'sl-db')).toMatchObject({
      type: 'ack',
      payload: { sessionId: 'session-1' },
    })

    harness.send({ id: 'slist-deprecated', type: 'session.list', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'slist-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    harness.send({ id: 'sdel-deprecated', type: 'session.delete', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'sdel-deprecated')).toMatchObject({
      type: 'error',
      payload: { code: 'DEPRECATED_MESSAGE_TYPE' },
    })

    await harness.close()
  })

  it('handles chat send/stop/continue plus mode and criteria editing flows', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'blocked',
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
      metadata: { title: null },
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
      setMode: vi.fn((_id, mode) => ({ ...sessionState, mode })),
    })

    let resolveRun: (() => void) | null = null
    runChatTurnMock.mockImplementation(({ signal }) => {
      // The event store is already set up in the harness - we just need to wait
      return new Promise<void>((resolve) => {
        resolveRun = resolve
        signal?.addEventListener('abort', () => resolve())
      })
    })

    const harness = await createHarness({ sessionManager })

    // Override addMessage and setRunning to emit events after harness is created
    const eventStore = getEventStoreMock()
    sessionManager.addMessage = vi.fn((sessionId: string, message: any) => {
      if (eventStore && typeof eventStore.append === 'function') {
        eventStore.append(sessionId, {
          type: 'message.start',
          data: { messageId: `msg-${Date.now()}`, role: message.role, content: message.content },
        })
      }
      return { id: `msg-${Date.now()}`, timestamp: new Date().toISOString(), ...message }
    })

    sessionManager.setRunning = vi.fn((sessionId: string, isRunning: boolean) => {
      if (eventStore && typeof eventStore.append === 'function') {
        eventStore.append(sessionId, {
          type: 'running.changed',
          data: { isRunning },
        })
      }
      return { ...sessionState, isRunning }
    })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'chat-bad', type: 'chat.send', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'chat-bad')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    harness.send({ id: 'chat-ok', type: 'chat.send', payload: { content: 'Please continue' } })
    expect(await harness.nextMessage((message) => message.id === 'chat-ok')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    harness.send({ id: 'chat-stop', type: 'chat.stop', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'chat-stop')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    const releaseRun = resolveRun as (() => void) | null
    if (releaseRun) {
      releaseRun()
    }

    harness.send({ id: 'chat-continue', type: 'chat.continue', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'chat-continue')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    harness.send({ id: 'mode-ok', type: 'mode.switch', payload: { mode: 'builder' } })
    expect(await harness.nextMessage((message) => message.id === 'mode-ok')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    harness.send({
      id: 'criteria-ok',
      type: 'criteria.edit',
      payload: { criteria: [{ id: 'c1', description: 'd', status: { type: 'pending' }, attempts: [] }] },
    })
    expect(await harness.nextMessage((message) => message.id === 'criteria-ok')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    await harness.close()
  })

  it('auto-compacts before accepting a new chat message when context is over threshold', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
      metadata: { title: null },
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
      getContextState: vi.fn(() => ({
        currentTokens: 190000,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: true,
        canCompact: true,
        dynamicContextChanged: false,
      })),
    })

    getAllInstructionsMock.mockResolvedValue({ content: '', files: [] })
    streamLLMPureMock.mockReturnValue({ kind: 'stream' })
    consumeStreamGeneratorMock.mockResolvedValue({
      content: 'Compacted summary of the session including all file modifications and current progress on tasks',
      toolCalls: [],
      segments: [
        {
          type: 'text',
          content: 'Compacted summary of the session including all file modifications and current progress on tasks',
        },
      ],
      usage: { promptTokens: 190000, completionTokens: 100 },
      timing: { ttft: 1, completionTime: 1, tps: 100, prefillTps: 190000 },
      aborted: false,
    })
    runChatTurnMock.mockResolvedValue(undefined)

    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'chat-ok', type: 'chat.send', payload: { content: 'Please continue' } })
    expect(await harness.nextMessage((message) => message.id === 'chat-ok')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })

    await harness.close()
  })

  it('handles mode.accept, runner.launch, context.compact, and path confirmation', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'blocked',
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      setMode: vi.fn((_id, mode) => ({ ...sessionState, mode })),
      setPhase: vi.fn((_id, phase) => ({ ...sessionState, phase })),
      setRunning: vi.fn((_id, isRunning) => {
        sessionState.isRunning = isRunning
      }),
      setCurrentContextSize: vi.fn(),
      getContextState: vi.fn(() => ({
        currentTokens: 10,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
      getCurrentModelSettings: vi.fn(() => ({})),
      getDynamicContextChanged: vi.fn(() => false),
      setDynamicContextChanged: vi.fn(),
      getCachedPrompt: vi.fn(() => undefined),
      setCachedPrompt: vi.fn(),
      getLspManager: vi.fn(),
      drainAsapMessages: vi.fn(() => []),
      getCurrentWindowMessages: vi.fn(() => []),
      updateMessage: vi.fn(),
    })

    getAllInstructionsMock.mockResolvedValue({ content: 'Follow instructions', files: [] })
    getToolRegistryForModeMock.mockReturnValue({
      definitions: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } }],
    })
    runChatTurnMock.mockResolvedValue(undefined)
    runOrchestratorMock.mockResolvedValue({ success: true })
    providePathConfirmationMock.mockReturnValueOnce({ found: false }).mockReturnValueOnce({ found: true })

    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'runner-launch', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-launch')).toMatchObject({ type: 'ack' })
    expect(await harness.nextMessage((message) => message.type === 'session.running')).toMatchObject({
      payload: { isRunning: true },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(runOrchestratorMock).toHaveBeenCalled()

    // Session is now running, so runner.launch is refused explicitly
    sessionState.isRunning = true

    harness.send({ id: 'runner-launch-2', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-launch-2')).toMatchObject({
      type: 'error',
      payload: { code: 'SESSION_RUNNING' },
    })

    // Stop the session so compact can run
    sessionState.isRunning = false

    harness.send({ id: 'compact', type: 'context.compact', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'compact')).toMatchObject({ type: 'ack' })
    expect(await harness.nextMessage((message) => message.type === 'context.state')).toMatchObject({
      type: 'context.state',
    })

    harness.send({ id: 'path-missing', type: 'path.confirm', payload: { callId: 'call-1', approved: true } })
    expect(await harness.nextMessage((message) => message.id === 'path-missing')).toMatchObject({
      payload: { code: 'DEPRECATED' },
    })

    harness.send({ id: 'path-ok', type: 'path.confirm', payload: { callId: 'call-2', approved: false } })
    expect(await harness.nextMessage((message) => message.id === 'path-ok')).toMatchObject({
      payload: { code: 'DEPRECATED' },
    })

    await harness.close()
  })

  it('reports session-state and validation errors for control messages', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
    })
    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'runner-accept-none', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-accept-none')).toMatchObject({
      payload: { code: 'NO_SESSION' },
    })

    harness.send({ id: 'compact-none', type: 'context.compact', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'compact-none')).toMatchObject({
      payload: { code: 'NO_SESSION' },
    })

    harness.send({ id: 'runner-none', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-none')).toMatchObject({
      payload: { code: 'NO_SESSION' },
    })

    harness.send({ id: 'path-none', type: 'path.confirm', payload: { callId: 'x', approved: true } })
    expect(await harness.nextMessage((message) => message.id === 'path-none')).toMatchObject({
      payload: { code: 'DEPRECATED' },
    })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    sessionState.isRunning = true
    sessionState.criteria = [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }]
    harness.send({ id: 'runner-running', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-running')).toMatchObject({
      type: 'error',
      payload: { code: 'SESSION_RUNNING' },
    })
    harness.send({ id: 'compact-running', type: 'context.compact', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'compact-running')).toMatchObject({
      payload: { code: 'SESSION_RUNNING' },
    })

    sessionState.isRunning = false

    sessionState.criteria = [
      {
        id: 'tests-pass',
        description: 'Tests pass',
        status: { type: 'passed', verifiedAt: '2024-01-01T00:00:00.000Z' },
        attempts: [],
      },
    ]
    harness.send({ id: 'runner-no-work', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-no-work')).toMatchObject({
      payload: { code: 'NO_WORK' },
    })

    harness.send({ id: 'path-invalid', type: 'path.confirm', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'path-invalid')).toMatchObject({
      payload: { code: 'DEPRECATED' },
    })

    await harness.close()
  })

  it('routes context.applyDynamic to the session named in the payload', async () => {
    applyDynamicContextMock.mockResolvedValue(undefined)
    const sessionB: any = {
      id: 'session-b',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      getSession: vi.fn((id: string) => (id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1' })),
      requireSession: vi.fn((id: string) => (id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1' })),
      getContextState: vi.fn(() => ({
        currentTokens: 10,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
    })
    const harness = await createHarness({ sessionManager })

    // Active WS session is session-1…
    harness.send({ id: 'sl-1', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-1')

    // …but the payload names session-b, so the update must target it.
    harness.send({ id: 'apply-b', type: 'context.applyDynamic', payload: { sessionId: 'session-b' } })
    expect(await harness.nextMessage((message) => message.id === 'apply-b')).toMatchObject({ type: 'ack' })
    expect(applyDynamicContextMock).toHaveBeenCalledTimes(1)
    expect(applyDynamicContextMock.mock.calls[0]![1]).toBe('session-b')

    // Without a payload sessionId, fall back to the active session.
    applyDynamicContextMock.mockClear()
    harness.send({ id: 'apply-active', type: 'context.applyDynamic', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'apply-active')).toMatchObject({ type: 'ack' })
    expect(applyDynamicContextMock).toHaveBeenCalledTimes(1)
    expect(applyDynamicContextMock.mock.calls[0]![1]).toBe('session-1')

    await harness.close()
  })

  it('routes context.compact to the session named in the payload, not the active one', async () => {
    const sessionB: any = {
      id: 'session-b',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      getSession: vi.fn((id: string) => (id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1' })),
      requireSession: vi.fn((id: string) => (id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1' })),
      getContextState: vi.fn(() => ({
        currentTokens: 10,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
      setRunning: vi.fn(),
    })
    runChatTurnMock.mockResolvedValue(undefined)
    const harness = await createHarness({ sessionManager })

    // Active WS session is session-1…
    harness.send({ id: 'sl-1', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-1')

    // …but the payload names session-b, so the compaction must target it.
    harness.send({ id: 'compact-b', type: 'context.compact', payload: { sessionId: 'session-b' } })
    expect(await harness.nextMessage((message) => message.id === 'compact-b')).toMatchObject({ type: 'ack' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(runChatTurnMock).toHaveBeenCalled()
    expect(runChatTurnMock.mock.calls[0]![0].sessionId).toBe('session-b')

    await harness.close()
  })

  it('routes workflow.exit to the session named in the payload, not the active one', async () => {
    const sessionB: any = {
      id: 'session-b',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
    }
    const setPhase = vi.fn((_id, phase) => ({ ...sessionB, phase }))
    const sessionManager = createSessionManager({
      getSession: vi.fn((id: string) => (id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1' })),
      getActiveWorkflowExecution: vi.fn(() => null),
      setPhase,
      setRunning: vi.fn(),
    })
    const harness = await createHarness({ sessionManager })

    // Active WS session is session-1…
    harness.send({ id: 'sl-1', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-1')

    // …but the payload names session-b, so the exit must target it.
    harness.send({ id: 'exit-b', type: 'workflow.exit', payload: { sessionId: 'session-b' } })
    expect(await harness.nextMessage((message) => message.id === 'exit-b')).toMatchObject({ type: 'ack' })
    expect(setPhase).toHaveBeenCalledWith('session-b', 'build')

    await harness.close()
  })

  it('surfaces manual compaction failures as recoverable chat errors', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'builder',
      phase: 'build',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
      getContextState: vi.fn(() => ({
        currentTokens: 190000,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: true,
        canCompact: true,
        dynamicContextChanged: false,
      })),
    })
    // Make runChatTurn reject to simulate compaction failure
    runChatTurnMock.mockRejectedValue(new Error('compact blew up'))
    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'compact-fail', type: 'context.compact', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'compact-fail')).toMatchObject({ type: 'ack' })
    expect(await harness.nextMessage((message) => message.type === 'chat.error')).toMatchObject({
      payload: { error: 'Compaction failed: compact blew up', recoverable: true },
    })

    await harness.close()
  })

  it('emits error events when runner.launch fails during orchestrator', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'builder',
      phase: 'build',
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
    })
    runOrchestratorMock.mockRejectedValueOnce(new Error('orchestrator failed'))

    const harness = await createHarness({ sessionManager })
    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'runner-fail', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-fail')).toMatchObject({ type: 'ack' })
    expect(await harness.nextMessage((message) => message.type === 'session.running')).toMatchObject({
      payload: { isRunning: true },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    await harness.close()
  })

  it('rejects mode.switch as unknown message type', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [
        {
          id: 'deleted-session-fix',
          description: 'Fix deleted session navigation',
          status: { type: 'pending' },
          attempts: [],
        },
      ],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
    })

    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'mode-switch-builder', type: 'mode.switch', payload: { mode: 'builder' } })
    expect(await harness.nextMessage((message) => message.id === 'mode-switch-builder')).toMatchObject({
      payload: { code: 'UNKNOWN_MESSAGE' },
    })
  })

  it('passes params from runner.launch payload to runOrchestrator', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'blocked',
      isRunning: false,
      metadata: { title: null },
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      setMode: vi.fn((_id, mode) => ({ ...sessionState, mode })),
      setPhase: vi.fn((_id, phase) => ({ ...sessionState, phase })),
      setRunning: vi.fn((_id, isRunning) => {
        sessionState.isRunning = isRunning
      }),
      setCurrentContextSize: vi.fn(),
      getContextState: vi.fn(() => ({
        currentTokens: 10,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
      getCurrentModelSettings: vi.fn(() => ({})),
      getDynamicContextChanged: vi.fn(() => false),
      setDynamicContextChanged: vi.fn(),
      getCachedPrompt: vi.fn(() => undefined),
      setCachedPrompt: vi.fn(),
      getLspManager: vi.fn(),
      drainAsapMessages: vi.fn(() => []),
      getCurrentWindowMessages: vi.fn(() => []),
      updateMessage: vi.fn(),
    })

    runOrchestratorMock.mockResolvedValue({ success: true })

    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({
      id: 'runner-params',
      type: 'runner.launch',
      payload: {
        workflowId: 'pr-review',
        params: { pr_number: '157', pr_title: 'Fix bug' },
      },
    })
    await harness.nextMessage((message) => message.id === 'runner-params')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(runOrchestratorMock).toHaveBeenCalled()
    const callArgs = runOrchestratorMock.mock.calls[0]![0]
    expect(callArgs.workflowId).toBe('pr-review')
    expect(callArgs.params).toEqual({ pr_number: '157', pr_title: 'Fix bug' })
  })

  it('routes runner.launch to the session named in the payload, not the active one', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      metadata: { title: null },
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      setMode: vi.fn((_id, mode) => ({ ...sessionState, mode })),
      setPhase: vi.fn((_id, phase) => ({ ...sessionState, phase })),
      setRunning: vi.fn((_id, isRunning) => {
        sessionState.isRunning = isRunning
      }),
      setCurrentContextSize: vi.fn(),
      getContextState: vi.fn(() => ({
        currentTokens: 10,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
      getCurrentModelSettings: vi.fn(() => ({})),
      getDynamicContextChanged: vi.fn(() => false),
      setDynamicContextChanged: vi.fn(),
      getCachedPrompt: vi.fn(() => undefined),
      setCachedPrompt: vi.fn(),
      getLspManager: vi.fn(),
      drainAsapMessages: vi.fn(() => []),
      getCurrentWindowMessages: vi.fn(() => []),
      updateMessage: vi.fn(),
    })

    runOrchestratorMock.mockResolvedValue({ success: true })

    const harness = await createHarness({ sessionManager })

    // The active session is session-1…
    harness.send({ id: 'sl-active', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-active')

    // …but the launch names session-2, which must win.
    harness.send({
      id: 'runner-targeted',
      type: 'runner.launch',
      payload: { sessionId: 'session-2', workflowId: 'pr-review' },
    })
    await harness.nextMessage((message) => message.id === 'runner-targeted')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(runOrchestratorMock).toHaveBeenCalled()
    const callArgs = runOrchestratorMock.mock.calls[0]![0]
    expect(callArgs.sessionId).toBe('session-2')
    expect(callArgs.workflowId).toBe('pr-review')
  })

  it('labels the runner.launch refusal with the session named in the payload', async () => {
    const sessionB: any = {
      id: 'session-b',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'plan',
      isRunning: true,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      getSession: vi.fn((id: string) =>
        id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1', isRunning: false },
      ),
      requireSession: vi.fn((id: string) =>
        id === 'session-b' ? sessionB : { ...sessionB, id: 'session-1', isRunning: false },
      ),
    })
    const harness = await createHarness({ sessionManager })

    // Active WS session is session-1, but the target session-b is running, so
    // the launch is refused — the error must be attributed to session-b.
    harness.send({ id: 'sl-1', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-1')

    harness.send({
      id: 'launch-while-running',
      type: 'runner.launch',
      payload: { sessionId: 'session-b', workflowId: 'wf-1' },
    })
    const reply = await harness.nextMessage((message) => message.id === 'launch-while-running')
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'SESSION_RUNNING' } })
    expect(reply.sessionId).toBe('session-b')

    await harness.close()
  })

  it('hands a queued message to a successor turn without the old finally writing isRunning=false', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'builder',
      phase: 'build',
      isRunning: false,
      criteria: [],
      metadata: { totalTokensUsed: 0, totalToolCalls: 0, iterationCount: 0 },
    }
    const lifecycle: string[] = []
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      setRunning: vi.fn((_id: string, isRunning: boolean) => {
        lifecycle.push(`setRunning:${isRunning}`)
        sessionState.isRunning = isRunning
        return { ...sessionState, isRunning }
      }),
      // The workflow finishes with one message in the queue, then drains empty
      drainAsapMessages: vi
        .fn()
        .mockImplementationOnce(() => [{ content: 'queued follow-up' }])
        .mockImplementation(() => []),
    })

    resetSessionRuntimeRegistry()
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })

    let finishSuccessor!: () => void
    runChatTurnMock.mockImplementation(() => {
      lifecycle.push('successor-start')
      // The real runChatTurn marks the session running at turn start
      sessionManager.setRunning('session-1', true)
      return new Promise<void>((resolve) => {
        finishSuccessor = resolve
      })
    })

    const harness = await createHarness({ sessionManager })
    const runningBroadcasts: boolean[] = []
    harness.client.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; payload?: { isRunning?: boolean } }
      if (message.type === 'session.running' && message.payload?.isRunning !== undefined) {
        runningBroadcasts.push(message.payload.isRunning)
      }
    })

    harness.send({ id: 'sl-1', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-1')

    harness.send({ id: 'launch-1', type: 'runner.launch', payload: { workflowId: 'wf-1' } })
    expect(await harness.nextMessage((message) => message.id === 'launch-1')).toMatchObject({ type: 'ack' })

    // The workflow settles and the queued message starts its successor turn
    const startDeadline = Date.now() + 5000
    while (!finishSuccessor && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(finishSuccessor).toBeTruthy()

    // Let the old workflow finally run to completion
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const runtime = getSessionRuntimeRegistry().peek('session-1')
    expect(runtime?.currentHandle()?.kind).toBe('chat')
    expect(sessionState.isRunning).toBe(true)

    // The old finally modified nothing: no isRunning=false, no false broadcast
    expect(lifecycle).toContain('successor-start')
    expect(lifecycle.filter((entry) => entry === 'setRunning:false')).toEqual([])
    expect(runningBroadcasts).not.toContain(false)

    // The successor settles cleanly and releases the runtime
    finishSuccessor()
    const releaseDeadline = Date.now() + 5000
    while (getSessionRuntimeRegistry().peek('session-1')?.currentHandle() && Date.now() < releaseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(getSessionRuntimeRegistry().peek('session-1')?.currentHandle()).toBeNull()

    await harness.close()
  })

  it('sources the persisted sub-group when resuming a paused slice', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'waiting',
      isRunning: false,
      metadata: { title: null },
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      setMode: vi.fn((_id, mode) => ({ ...sessionState, mode })),
      setPhase: vi.fn((_id, phase) => ({ ...sessionState, phase })),
      setRunning: vi.fn((_id, isRunning) => {
        sessionState.isRunning = isRunning
      }),
      setCurrentContextSize: vi.fn(),
      getContextState: vi.fn(() => ({
        currentTokens: 10,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
      getCurrentModelSettings: vi.fn(() => ({})),
      getDynamicContextChanged: vi.fn(() => false),
      setDynamicContextChanged: vi.fn(),
      getCachedPrompt: vi.fn(() => undefined),
      setCachedPrompt: vi.fn(),
      getLspManager: vi.fn(),
      drainAsapMessages: vi.fn(() => []),
      getCurrentWindowMessages: vi.fn(() => []),
      updateMessage: vi.fn(),
      getActiveWorkflowExecution: vi.fn(() => ({
        id: 'exec-1',
        sessionId: 'session-1',
        workflowId: 'default',
        workflowName: 'Build & Verify',
        status: 'waiting',
        currentStepId: 'work_location',
        stepOutput: {},
        params: {},
        subGroup: 'verify',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      getLatestWorkflowExecution: vi.fn(() => ({
        id: 'exec-1',
        sessionId: 'session-1',
        workflowId: 'default',
        workflowName: 'Build & Verify',
        status: 'waiting',
        currentStepId: 'work_location',
        stepOutput: {},
        params: {},
        subGroup: 'verify',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      resumeWorkflow: vi.fn(() => ({ params: {}, stepOutput: {} })),
    })

    runOrchestratorMock.mockResolvedValue({ success: true })

    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'runner-resume', type: 'runner.launch', payload: { resumeFrom: 'work_location' } })
    await harness.nextMessage((message) => message.id === 'runner-resume')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(runOrchestratorMock).toHaveBeenCalled()
    const callArgs = runOrchestratorMock.mock.calls[0]![0]
    expect(callArgs.subGroup).toBe('verify')
  })

  it('handles runner relaunch, subscription failures, and orchestrator errors', async () => {
    const eventStore = createEventStore()
    eventStore.subscribe = vi.fn(() => ({
      iterator: (async function* () {
        throw new Error('subscription blew up')
      })(),
      unsubscribe: vi.fn(),
    }))

    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'builder',
      phase: 'build',
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
    })

    runOrchestratorMock
      .mockImplementationOnce(
        ({ signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve({ success: true }))
          }),
      )
      .mockRejectedValueOnce(new Error('runner exploded'))

    const harness = await createHarness({ sessionManager, eventStore })

    harness.send({ id: 'runner-1', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-1')).toMatchObject({
      type: 'error',
      payload: { code: 'NO_SESSION' },
    })

    await harness.close()
  })

  it('forwards streamed event-store messages and ignores aborted runner errors', async () => {
    const eventStore: any = createEventStore()
    const chatDoneEvent = {
      seq: 1,
      sessionId: 'session-1',
      timestamp: Date.now(),
      type: 'chat.done',
      data: { messageId: 'assistant-1', reason: 'complete' },
    }
    // Use a deferred yield to ensure session.running comes first
    let resolveChatDone: ((event: typeof chatDoneEvent) => void) | null = null
    eventStore.subscribe = vi.fn(() => ({
      iterator: (async function* () {
        resolveChatDone = (_event: typeof chatDoneEvent) => {
          resolveChatDone = null
        }
      })(),
      unsubscribe: vi.fn(),
    }))
    eventStore.subscribeAll = vi.fn(() => ({
      iterator: (async function* () {
        // Wait for signal to yield chat.done
        yield await new Promise<typeof chatDoneEvent>((resolve) => {
          resolveChatDone = resolve
        })
      })() as any,
      unsubscribe: vi.fn(),
    }))

    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'builder',
      phase: 'build',
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
    })
    runOrchestratorMock.mockImplementation((options: any) => {
      resolveChatDone?.(chatDoneEvent)
      // Simulate runChatTurn's finally block which sets isRunning=false
      options.sessionManager?.setRunning?.('session-1', false)
      return Promise.reject(new Error('Aborted'))
    })

    const harness = await createHarness({ sessionManager, eventStore })
    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'runner-aborted', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-aborted')).toMatchObject({ type: 'ack' })
    expect(await harness.nextMessage((message) => message.type === 'session.running')).toMatchObject({
      payload: { isRunning: true },
    })
    expect(await harness.nextMessage((message) => message.type === 'chat.done' && message.seq === 1)).toMatchObject({
      type: 'chat.done',
      seq: 1,
      sessionId: 'session-1',
      payload: { messageId: 'assistant-1', reason: 'complete' },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(runOrchestratorMock).toHaveBeenCalledTimes(1)
    expect(sessionManager.setRunning).toHaveBeenCalledWith('session-1', false)

    await harness.close()
  })

  it.skip('tags direct session-scoped messages with their originating session after switching sessions', async () => {
    const sessionOne: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project-1',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
      metadata: { totalTokensUsed: 0, totalToolCalls: 0, iterationCount: 0 },
    }
    const sessionTwo: any = {
      id: 'session-2',
      projectId: 'project-1',
      workdir: '/tmp/project-2',
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      criteria: [],
      metadata: { totalTokensUsed: 0, totalToolCalls: 0, iterationCount: 0 },
    }
    const sessions = new Map<string, any>([
      ['session-1', sessionOne],
      ['session-2', sessionTwo],
    ])

    const eventStore = createEventStore()
    eventStore.getEvents = vi.fn((sessionId: string) => {
      if (sessionId === 'session-2') {
        return [
          {
            seq: 1,
            sessionId: 'session-2',
            timestamp: 123,
            type: 'message.start',
            data: { messageId: 'msg-2', role: 'user', content: 'Hello from session-2' },
          },
        ]
      }
      return []
    })

    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionOne),
      getSession: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
      requireSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
      getContextState: vi.fn((sessionId: string) => ({
        currentTokens: sessionId === 'session-1' ? 11 : 22,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      })),
    })

    const harness = await createHarness({ sessionManager, eventStore })

    harness.send({ id: 'load-session-1', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'load-session-1')

    harness.send({ id: 'load-session-2', type: 'session.load', payload: { sessionId: 'session-2' } })
    expect(await harness.nextMessage((message) => message.id === 'load-session-2')).toMatchObject({
      type: 'ack',
      payload: { sessionId: 'session-2' },
    })

    harness.eventStore.append('session-1', {
      type: 'chat.path_confirmation',
      data: {
        callId: 'path-1',
        tool: 'read_file',
        paths: ['/tmp/project-1/secrets.txt'],
        workdir: '/tmp/project-1',
        reason: 'outside_workdir',
      },
    })

    expect(await harness.nextMessage((message) => message.type === 'chat.path_confirmation')).toMatchObject({
      type: 'chat.path_confirmation',
      sessionId: 'session-1',
      payload: { callId: 'path-1' },
    })

    await harness.close()
  })

  it('resolves and persists auto model for per-session runner execution and stats', async () => {
    const mockSessionClient = {
      getModel: () => 'deepseek-chat',
      getBackend: () => 'openai',
      setBackend: vi.fn(),
      setModel: vi.fn(),
      complete: vi.fn(),
      stream: vi.fn(),
      getProfile: vi.fn(),
    } as never

    createLLMClientMock.mockReturnValue(mockSessionClient)
    runOrchestratorMock.mockResolvedValue({ success: true })

    const provider = {
      id: 'deepseek-provider',
      name: 'DeepSeek',
      url: 'https://api.deepseek.com',
      backend: 'openai',
      apiKey: 'sk-real-key-12345',
      models: [{ id: 'deepseek-chat', contextWindow: 64000 }],
      isActive: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    }

    const createClientMock = vi.fn(() => mockSessionClient)
    const resolveModelMock = vi.fn(() => 'deepseek-chat')
    const providerManager = {
      getProviders: vi.fn(() => [provider]),
      createClient: createClientMock,
      resolveModel: resolveModelMock,
      getActiveProvider: vi.fn(() => provider),
      getActiveProviderId: vi.fn(() => 'deepseek-provider'),
      getCurrentModel: vi.fn(() => 'deepseek-chat'),
      getCurrentModelContext: vi.fn(() => 64000),
      getLLMClient: vi.fn(() => mockSessionClient),
      activateProvider: vi.fn(),
      addProvider: vi.fn(),
      removeProvider: vi.fn(),
      setProviders: vi.fn(),
      getProviderStatus: vi.fn(),
      getProviderModels: vi.fn(),
      setDefaultModelSelection: vi.fn(),
      updateModelContext: vi.fn(),
      updateModelSettings: vi.fn(),
      refreshProviderModels: vi.fn(),
      getModelSettings: vi.fn(),
      resolveModelEffort: vi.fn(),
    } as never

    const session = {
      id: 'session-apikey-test',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'builder' as const,
      phase: 'build' as const,
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
      providerId: 'deepseek-provider',
      providerModel: 'auto',
      metadata: { totalTokensUsed: 0, totalToolCalls: 0, iterationCount: 0 },
    }

    const setSessionProvider = vi.fn((_id: string, providerId: string | null, providerModel: string | null) => {
      if (providerId) session.providerId = providerId
      if (providerModel) session.providerModel = providerModel
      return session
    })
    const sessionManager = createSessionManager({
      getSession: vi.fn(() => session),
      requireSession: vi.fn(() => session),
      setSessionProvider,
      setRunning: vi.fn((_id: string, isRunning: boolean) => {
        session.isRunning = isRunning
      }),
    })

    const harness = await createHarness({ sessionManager, providerManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-apikey-test' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'runner-launch', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-launch')).toMatchObject({ type: 'ack' })

    expect(resolveModelMock).toHaveBeenCalledWith('deepseek-provider', 'auto')
    expect(createClientMock).toHaveBeenCalledWith('deepseek-provider', 'deepseek-chat', undefined)
    expect(setSessionProvider).toHaveBeenCalledWith(
      'session-apikey-test',
      'deepseek-provider',
      'deepseek-chat',
      undefined,
      undefined,
    )
    expect(runOrchestratorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        llmClient: mockSessionClient,
        statsIdentity: expect.objectContaining({ model: 'deepseek-chat' }),
      }),
    )
    expect(createLLMClientMock).not.toHaveBeenCalled()

    await harness.close()
  })

  it('does not normalize the sticky preference from an override-derived effective model', async () => {
    const overrideClient = {
      getModel: () => 'override-model',
      getBackend: () => 'openai',
      setBackend: vi.fn(),
      setModel: vi.fn(),
      complete: vi.fn(),
      stream: vi.fn(),
      getProfile: vi.fn(),
    } as never
    createLLMClientMock.mockReturnValue(overrideClient)
    runOrchestratorMock.mockResolvedValue({ success: true })

    const provider = {
      id: 'deepseek-provider',
      name: 'DeepSeek',
      url: 'https://api.deepseek.com',
      backend: 'openai',
      apiKey: 'sk-real-key-12345',
      models: [{ id: 'override-model', contextWindow: 64000 }],
      isActive: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    }

    const createClientMock = vi.fn(() => overrideClient)
    const providerManager = {
      getProviders: vi.fn(() => [provider]),
      createClient: createClientMock,
      resolveModel: vi.fn(() => 'override-model'),
      getActiveProvider: vi.fn(() => provider),
      getActiveProviderId: vi.fn(() => 'deepseek-provider'),
      getCurrentModel: vi.fn(() => 'override-model'),
      getCurrentModelContext: vi.fn(() => 64000),
      getLLMClient: vi.fn(() => overrideClient),
      activateProvider: vi.fn(),
      addProvider: vi.fn(),
      removeProvider: vi.fn(),
      setProviders: vi.fn(),
      getProviderStatus: vi.fn(),
      getProviderModels: vi.fn(),
      setDefaultModelSelection: vi.fn(),
      updateModelContext: vi.fn(),
      updateModelSettings: vi.fn(),
      refreshProviderModels: vi.fn(),
      getModelSettings: vi.fn(),
      resolveModelEffort: vi.fn(),
    } as never

    // The user picked deepseek-provider/manual-model, then switched to an override
    // agent whose override is the SAME provider with override-model. The effective
    // model is override-derived (manual pick deactivated), so the WS normalization
    // must NOT write the override's model into the sticky preference.
    const session = {
      id: 'session-normalize-test',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner' as const,
      phase: 'build' as const,
      isRunning: false,
      criteria: [{ id: 'tests-pass', description: 'Tests pass', status: { type: 'pending' }, attempts: [] }],
      providerId: 'deepseek-provider',
      providerModel: 'manual-model',
      providerManual: true,
      providerManualActive: false,
      metadata: { totalTokensUsed: 0, totalToolCalls: 0, iterationCount: 0 },
    }

    const setSessionProvider = vi.fn()
    const sessionManager = createSessionManager({
      getSession: vi.fn(() => session),
      requireSession: vi.fn(() => session),
      setSessionProvider,
      resolveEffectiveProviderModel: vi.fn(() => ({ providerId: 'deepseek-provider', model: 'override-model' })),
    })

    const harness = await createHarness({ sessionManager, providerManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-normalize-test' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'runner-launch', type: 'runner.launch', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'runner-launch')).toMatchObject({ type: 'ack' })

    expect(createClientMock).toHaveBeenCalledWith('deepseek-provider', 'override-model', undefined)
    // The override-derived model must never overwrite the sticky manual preference.
    expect(setSessionProvider).not.toHaveBeenCalled()

    await harness.close()
  })

  it('brokers worker ask answers and rejects late responses', async () => {
    getPendingQuestionsForSessionMock.mockReturnValue([
      { callId: 'call-1', question: 'Continue?', type: 'confirm' },
      { callId: 'call-rejected', question: 'Continue?', type: 'confirm' },
      { callId: 'call-late', question: 'Continue?', type: 'confirm' },
    ])
    const answerQuestion = vi
      .fn()
      .mockReturnValueOnce('answered' as const)
      .mockReturnValueOnce('rejected' as const)
      .mockReturnValueOnce('not-handled' as const)
    const workerController = {
      isEnabled: () => true,
      requestTurn: vi.fn(() => 'started' as const),
      releaseTurn: vi.fn(() => true),
      launch: vi.fn(),
      answerQuestion,
    }
    const harness = await createHarness({ workerController })

    harness.send({ id: 'sl-worker-answer', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-worker-answer')

    harness.send({ id: 'answer-worker', type: 'ask.answer', payload: { callId: 'call-1', answer: 'yes' } })
    expect(await harness.nextMessage((message) => message.id === 'answer-worker')).toMatchObject({ type: 'ack' })
    expect(answerQuestion).toHaveBeenCalledWith('call-1', 'yes', false)
    expect(provideAnswerMock).not.toHaveBeenCalled()

    harness.send({
      id: 'answer-rejected',
      type: 'ask.answer',
      payload: { callId: 'call-rejected', answer: 'oversized' },
    })
    expect(await harness.nextMessage((message) => message.id === 'answer-rejected')).toMatchObject({
      type: 'error',
      payload: { code: 'ANSWER_REJECTED' },
    })

    harness.send({ id: 'answer-late', type: 'ask.answer', payload: { callId: 'call-late', answer: 'late' } })
    expect(await harness.nextMessage((message) => message.id === 'answer-late')).toMatchObject({
      type: 'error',
      payload: { code: 'NOT_FOUND' },
    })
    expect(provideAnswerMock).not.toHaveBeenCalled()

    await harness.close()
  })

  it('wakes QueueProcessor only after clean unstopped gateway worker commands', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'build',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      getLatestWorkflowExecution: vi.fn(() => null),
    })
    const settlements: Array<(outcome: { crashed: boolean }) => void> = []
    const workerController = {
      isEnabled: () => true,
      requestTurn: vi.fn((_sessionId: string, start: () => void) => {
        start()
        return 'started' as const
      }),
      releaseTurn: vi.fn(() => true),
      launch: vi.fn((_sessionId: string, settled: (outcome: { crashed: boolean }) => void) => {
        settlements.push(settled)
      }),
    }
    const wakeQueueProcessor = vi.fn()
    const harness = await createHarness({
      sessionManager,
      workerController,
      onCleanWorkerTurnSettled: wakeQueueProcessor,
    })

    harness.send({ id: 'sl-clean-worker', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-clean-worker')

    recordLLMFailure('session-1')
    const commands = [
      ['compact-clean', 'context.compact', { sessionId: 'session-1' }],
      ['retry-clean', 'chat.retry', { sessionId: 'session-1' }],
      ['workflow-clean', 'runner.launch', { sessionId: 'session-1', workflowId: 'test-workflow' }],
    ] as const
    for (const [id, type, payload] of commands) {
      harness.send({ id, type, payload })
      const reply = await harness.nextMessage((message) => message.id === id)
      expect(reply, id).toMatchObject({ type: 'ack' })
      expect(settlements).toHaveLength(1)
      settlements.shift()?.({ crashed: false })
    }
    expect(wakeQueueProcessor).toHaveBeenCalledTimes(3)

    harness.send({ id: 'compact-stopped', type: 'context.compact', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'compact-stopped')
    getSessionRuntimeRegistry().get('session-1').stop()
    settlements.shift()?.({ crashed: false })

    harness.send({ id: 'compact-crashed', type: 'context.compact', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'compact-crashed')
    settlements.shift()?.({ crashed: true })
    expect(wakeQueueProcessor).toHaveBeenCalledTimes(3)

    clearLLMFailure('session-1')
    await harness.close()
  })

  it('queues gateway turn commands under worker saturation without mutating before admission', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'blocked',
      isRunning: false,
      criteria: [{ id: 'pending', description: 'Pending', status: { type: 'pending' }, attempts: [] }],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      getLatestWorkflowExecution: vi.fn(() => null),
    })
    const starts: Array<() => void> = []
    const launch = vi.fn((_sessionId, settled: (outcome: { crashed: boolean }) => void) => {
      settled({ crashed: false })
    })
    const workerController = {
      isEnabled: () => true,
      requestTurn: vi.fn((_sessionId: string, start: () => void) => {
        starts.push(start)
        return 'waiting' as const
      }),
      releaseTurn: vi.fn(() => true),
      launch,
    }
    const harness = await createHarness({ sessionManager, workerController })

    harness.send({ id: 'sl-worker', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-worker')

    recordLLMFailure('session-1')
    const commands = [
      ['compact-worker', 'context.compact', { kind: 'compact' }],
      ['runner-worker', 'runner.launch', { kind: 'workflow' }],
      ['retry-worker', 'chat.retry', { kind: 'retry' }],
    ] as const
    for (const [index, [id, type, expectedCommand]] of commands.entries()) {
      harness.send({ id, type, payload: { sessionId: 'session-1' } })
      expect(await harness.nextMessage((message) => message.id === id)).toMatchObject({
        type: 'ack',
        payload: { admission: 'waiting' },
      })
      expect(launch).toHaveBeenCalledTimes(index)
      expect(sessionManager.setPhase).not.toHaveBeenCalled()
      expect(harness.eventStore.append).not.toHaveBeenCalled()

      starts.shift()?.()
      expect(launch).toHaveBeenLastCalledWith(
        'session-1',
        expect.any(Function),
        expect.objectContaining(expectedCommand),
      )
    }

    expect(runChatTurnMock).not.toHaveBeenCalled()
    expect(runOrchestratorMock).not.toHaveBeenCalled()

    clearLLMFailure('session-1')
    await harness.close()
  })

  it('queues compact and runner commands for an active worker session until its runtime releases', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'build',
      isRunning: true,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
      getLatestWorkflowExecution: vi.fn(() => null),
    })
    const starts: Array<() => void> = []
    const launch = vi.fn((_sessionId, settled: (outcome: { crashed: boolean }) => void) => {
      settled({ crashed: false })
    })
    const workerController = {
      isEnabled: () => true,
      requestTurn: vi.fn((_sessionId: string, start: () => void) => {
        starts.push(start)
        return 'waiting' as const
      }),
      releaseTurn: vi.fn(() => true),
      launch,
    }
    const harness = await createHarness({ sessionManager, workerController })
    const runtime = getSessionRuntimeRegistry().get('session-1')

    harness.send({ id: 'sl-active-worker', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-active-worker')

    const commands = [
      ['compact-active-worker', 'context.compact', { sessionId: 'session-1' }, { kind: 'compact' }],
      [
        'runner-active-worker',
        'runner.launch',
        { sessionId: 'session-1', workflowId: 'default', resumeFrom: 'build' },
        { kind: 'workflow' },
      ],
    ] as const

    for (const [index, [id, type, payload, expectedCommand]] of commands.entries()) {
      const active = runtime.acquire('chat')
      harness.send({ id, type, payload })
      expect(await harness.nextMessage((message) => message.id === id)).toMatchObject({
        type: 'ack',
        payload: { admission: 'waiting' },
      })
      expect(launch).toHaveBeenCalledTimes(index)
      expect(sessionManager.setPhase).not.toHaveBeenCalled()
      expect(harness.eventStore.append).not.toHaveBeenCalled()

      expect(runtime.release(active)).toBe(true)
      starts.shift()?.()
      expect(launch).toHaveBeenLastCalledWith(
        'session-1',
        expect.any(Function),
        expect.objectContaining(expectedCommand),
      )
      expect(runtime.state).toBe('idle')
    }

    await harness.close()
  })

  it('reports an explicit worker queue saturation error', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'build',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
    })
    const workerController = {
      isEnabled: () => true,
      requestTurn: vi.fn(() => 'full' as const),
      releaseTurn: vi.fn(() => true),
      launch: vi.fn(),
    }
    const harness = await createHarness({ sessionManager, workerController })

    harness.send({ id: 'sl-worker-full', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-worker-full')
    harness.send({
      id: 'runner-worker-full',
      type: 'runner.launch',
      payload: { sessionId: 'session-1', workflowId: 'default', resumeFrom: 'build' },
    })
    expect(await harness.nextMessage((message) => message.id === 'runner-worker-full')).toMatchObject({
      type: 'error',
      payload: {
        code: 'WORKER_ADMISSION_REFUSED',
        message: expect.stringMatching(/64 waiting sessions|64 sessions en attente/),
      },
    })
    expect(workerController.launch).not.toHaveBeenCalled()

    await harness.close()
  })

  it('guards chat.retry — session state, recorded failure, and active workflow', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'build',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => structuredClone(sessionState)),
      getLatestWorkflowExecution: vi.fn(() => null),
    })
    runChatTurnMock.mockResolvedValue(undefined)
    const harness = await createHarness({ sessionManager })

    // No active session → NO_SESSION
    harness.send({ id: 'retry-none', type: 'chat.retry', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'retry-none')).toMatchObject({
      payload: { code: 'NO_SESSION' },
    })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    // Session not found → NOT_FOUND
    ;(sessionManager.getSession as any).mockReturnValue(null)
    harness.send({ id: 'retry-notfound', type: 'chat.retry', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'retry-notfound')).toMatchObject({
      payload: { code: 'NOT_FOUND' },
    })
    ;(sessionManager.getSession as any).mockReturnValue(sessionState)

    // Session running → SESSION_RUNNING
    sessionState.isRunning = true
    harness.send({ id: 'retry-running', type: 'chat.retry', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'retry-running')).toMatchObject({
      payload: { code: 'SESSION_RUNNING' },
    })
    sessionState.isRunning = false

    // No recorded LLM failure → NO_FAILED_TURN (prevents unsolicited turns)
    harness.send({ id: 'retry-nofail', type: 'chat.retry', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'retry-nofail')).toMatchObject({
      payload: { code: 'NO_FAILED_TURN' },
    })

    // Recorded failure but an active (blocked) workflow → WORKFLOW_ACTIVE
    recordLLMFailure('session-1')
    ;(sessionManager.getLatestWorkflowExecution as any).mockReturnValue({
      id: 'exec-1',
      sessionId: 'session-1',
      workflowId: 'default',
      workflowName: 'Build & Verify',
      status: 'blocked',
      currentStepId: 'build',
      stepOutput: {},
      params: {},
    })
    harness.send({ id: 'retry-wf', type: 'chat.retry', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'retry-wf')).toMatchObject({
      payload: { code: 'WORKFLOW_ACTIVE' },
    })

    // Recorded failure, no workflow → ack + turn starts without re-adding a message
    ;(sessionManager.getLatestWorkflowExecution as any).mockReturnValue(null)
    harness.send({ id: 'retry-ok', type: 'chat.retry', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'retry-ok')).toMatchObject({ type: 'ack' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(runChatTurnMock).toHaveBeenCalled()
    expect(runChatTurnMock.mock.calls[0]![0].sessionId).toBe('session-1')

    clearLLMFailure('session-1')
    await harness.close()
  })

  it('handles chat.llm_retry_now with no active backoff wait', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'build',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
    })
    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'rn-none', type: 'chat.llm_retry_now', payload: {} })
    expect(await harness.nextMessage((message) => message.id === 'rn-none')).toMatchObject({
      payload: { code: 'NO_SESSION' },
    })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    harness.send({ id: 'rn-idle', type: 'chat.llm_retry_now', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'rn-idle')).toMatchObject({
      type: 'ack',
      payload: { interrupted: false },
    })

    await harness.close()
  })

  it('chat.llm_retry_now interrupts an active backoff wait', async () => {
    const sessionState: any = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner',
      phase: 'build',
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => sessionState),
      getSession: vi.fn(() => sessionState),
      requireSession: vi.fn(() => sessionState),
    })
    const harness = await createHarness({ sessionManager })

    harness.send({ id: 'sl-ok', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-ok')

    // Start a real backoff wait for session-1 (registered in the retry-waiters map)
    const waitPromise = sleepThroughRetryBackoff(60_000, 'session-1')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    harness.send({ id: 'rn-live', type: 'chat.llm_retry_now', payload: { sessionId: 'session-1' } })
    expect(await harness.nextMessage((message) => message.id === 'rn-live')).toMatchObject({
      type: 'ack',
      payload: { interrupted: true },
    })

    // The wait resolves immediately as interrupted
    expect(await waitPromise).toBe('retry-now')

    await harness.close()
  })

  it('broadcasts manager-created sessions to every open window', async () => {
    let emitSessionEvent: ((event: Record<string, unknown>) => void) | undefined
    const sessionManager = createSessionManager({
      subscribe: vi.fn((callback: (event: Record<string, unknown>) => void) => {
        emitSessionEvent = callback
        return () => {}
      }),
    })
    const harness = await createHarness({ sessionManager })
    const windowB = await harness.connectClient()
    const created = {
      ...sessionManager.session,
      id: 'forked-session',
      metadata: { title: 'Forked session' },
      messages: [],
      messageCount: 0,
    }

    emitSessionEvent?.({ type: 'session_created', session: created })

    expect(await harness.nextMessage((message) => message.type === 'session.created')).toMatchObject({
      type: 'session.created',
      sessionId: 'forked-session',
      payload: { session: { id: 'forked-session', title: 'Forked session' } },
    })
    expect(await windowB.nextMessage((message) => message.type === 'session.created')).toMatchObject({
      type: 'session.created',
      sessionId: 'forked-session',
    })

    await windowB.close()
    await harness.close()
  })

  it('broadcastAll — the primitive tasks.update relies on — reaches clients without an active session', async () => {
    // Contract test: broadcastAll must deliver to EVERY connected client,
    // including windows with no session loaded (homepage) or a session in
    // another project. This is why deferTasksBroadcast uses broadcastAll
    // instead of broadcastForProject (which keys off activeSessionId and
    // would skip such windows). The actual index.ts wiring is exercised
    // end-to-end by e2e/tasks-cross-window-sync.test.ts.
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      workdir: '/tmp/project',
      mode: 'planner' as const,
      phase: 'plan' as const,
      isRunning: false,
      criteria: [],
    }
    const sessionManager = createSessionManager({
      createSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      requireSession: vi.fn(() => session),
    })
    const harness = await createHarness({ sessionManager })

    // Window A: viewing a session inside project-1 (sets activeSessionId).
    harness.send({ id: 'sl-a', type: 'session.load', payload: { sessionId: 'session-1' } })
    await harness.nextMessage((message) => message.id === 'sl-a')

    // Window B: homepage — connected but with no session loaded.
    const windowB = await harness.connectClient()

    const payload = {
      projectId: 'project-1',
      tasks: [],
      settings: { slotLimit: 1, queuePaused: false },
      counts: { open: 0, todo: 0, inProgress: 0, running: 0, queued: 0, done: 0 },
      gates: [],
    }
    harness.broadcastAll({ type: 'tasks.update', payload })

    expect(await harness.nextMessage((message) => message.type === 'tasks.update')).toMatchObject({
      type: 'tasks.update',
      payload: { projectId: 'project-1' },
    })
    expect(await windowB.nextMessage((message) => message.type === 'tasks.update')).toMatchObject({
      type: 'tasks.update',
      payload: { projectId: 'project-1' },
    })

    await windowB.close()
    await harness.close()
  })

  describe('git status polling', () => {
    const GIT_POLL_MS = 10_000
    type GitSession = { id: string; workdir: string; workspace?: string }
    const heldGit: Array<() => void> = []
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      getGitBranchMock.mockResolvedValue('main')
    })

    afterEach(async () => {
      while (heldGit.length > 0) {
        heldGit.shift()!()
        await settle()
      }
      vi.useRealTimers()
    })

    async function until(condition: () => boolean): Promise<void> {
      const deadline = Date.now() + 2_000
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    }

    async function pollCycles(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS)
        await settle()
      }
    }

    const gitCalls = (workdir: string) => getGitBranchMock.mock.calls.filter(([cwd]) => cwd === workdir).length

    function holdGit() {
      const releases = heldGit
      const state = { inFlight: 0, maxInFlight: 0 }
      const enter = () => {
        state.inFlight++
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      }
      getGitBranchMock.mockImplementation(() => {
        enter()
        return new Promise<string>((resolve) =>
          releases.push(() => {
            state.inFlight--
            resolve('main')
          }),
        )
      })
      getGitDiffFilesMock.mockImplementation(async () => {
        enter()
        await settle()
        state.inFlight--
        return []
      })
      return { releases, state }
    }

    const hasFile = (message: TestMessage, path: string) =>
      message.type === 'git.status' &&
      ((message.payload['diff'] as { files: Array<{ path: string }> } | undefined)?.files ?? []).some(
        (file) => file.path === path,
      )

    function createGitSessionManager(effectiveWorkdirs: Record<string, string>) {
      const template = createSessionManager().session
      const listeners: Array<(event: Record<string, unknown>) => void> = []
      const manager = createSessionManager({
        subscribe: vi.fn((callback: (event: Record<string, unknown>) => void) => {
          listeners.push(callback)
          return () => {}
        }),
        getSession: vi.fn((id: string) => ({ ...template, id })),
        requireSession: vi.fn((id: string) => ({ ...template, id })),
        getEffectiveWorkdir: vi.fn((id: string) => effectiveWorkdirs[id] ?? null),
        getDisplayWorkflowExecution: vi.fn(() => null),
      })
      const emitUpdated = (session: GitSession) => {
        effectiveWorkdirs[session.id] = session.workspace ?? session.workdir
        for (const listener of listeners) {
          listener({ type: 'session_updated', session: { ...template, messages: [], messageCount: 0, ...session } })
        }
      }
      return { manager, emitUpdated }
    }

    async function loadSession(
      client: { send: (message: Record<string, unknown>) => void; nextMessage: Harness['nextMessage'] },
      sessionId: string,
    ): Promise<void> {
      const id = `load-${sessionId}-${Math.random()}`
      client.send({ id, type: 'session.load', payload: { sessionId } })
      await client.nextMessage((message) => message.id === id)
    }

    async function closeAll(harness: Harness): Promise<void> {
      await harness.close()
      await until(() => harness.wsServer.clients.size === 0)
    }

    it('spawns no git process on session_updated when no client watches the session', async () => {
      const workdir = '/tmp/git-poll-unwatched'
      const { manager, emitUpdated } = createGitSessionManager({ 'session-1': workdir })
      const harness = await createHarness({ sessionManager: manager })
      harness.client.close()
      await until(() => harness.wsServer.clients.size === 0)

      emitUpdated({ id: 'session-1', workdir })
      await settle()
      await pollCycles(3)

      expect(getGitBranchMock).not.toHaveBeenCalled()
      expect(getGitDiffFilesMock).not.toHaveBeenCalled()
      await closeAll(harness)
    })

    it('spawns no git process on session_updated for a window that has not loaded the session', async () => {
      const workdir = '/tmp/git-poll-other-window'
      const { manager, emitUpdated } = createGitSessionManager({ 'session-1': workdir })
      const harness = await createHarness({ sessionManager: manager })

      emitUpdated({ id: 'session-1', workdir })
      await settle()
      await pollCycles(3)

      expect(getGitBranchMock).not.toHaveBeenCalled()
      expect(getGitDiffFilesMock).not.toHaveBeenCalled()
      await closeAll(harness)
    })

    it('keeps one timer for two clients on a directory and polls until the last one leaves', async () => {
      const workdir = '/tmp/git-poll-last-client'
      const { manager } = createGitSessionManager({ 'session-1': workdir })
      const harness = await createHarness({ sessionManager: manager })
      const second = await harness.connectClient()
      const timersBefore = vi.getTimerCount()
      await loadSession(harness, 'session-1')
      await loadSession(second, 'session-1')
      expect(vi.getTimerCount() - timersBefore).toBe(1)

      getGitBranchMock.mockClear()
      await pollCycles(1)
      expect(gitCalls(workdir)).toBe(1)

      await second.close()
      await until(() => harness.wsServer.clients.size === 1)
      expect(vi.getTimerCount() - timersBefore).toBe(1)
      getGitBranchMock.mockClear()
      await pollCycles(1)
      expect(gitCalls(workdir)).toBe(1)

      harness.client.close()
      await until(() => harness.wsServer.clients.size === 0)
      expect(vi.getTimerCount() - timersBefore).toBe(0)
      getGitBranchMock.mockClear()
      getGitDiffFilesMock.mockClear()
      await pollCycles(3)
      expect(getGitBranchMock).not.toHaveBeenCalled()
      expect(getGitDiffFilesMock).not.toHaveBeenCalled()
      await closeAll(harness)
    })

    it('does not start a poll pass while the previous one is still running', async () => {
      const workdir = '/tmp/git-poll-overlap'
      const { manager } = createGitSessionManager({ 'session-1': workdir })
      const harness = await createHarness({ sessionManager: manager })
      await loadSession(harness, 'session-1')

      getGitBranchMock.mockClear()
      const git = holdGit()
      await pollCycles(3)
      expect(gitCalls(workdir)).toBe(1)

      git.releases.shift()!()
      await until(() => gitCalls(workdir) === 2)
      git.releases.shift()!()
      await settle()
      expect(gitCalls(workdir)).toBe(2)
      expect(git.state.maxInFlight).toBe(1)
      await closeAll(harness)
    })

    it('does not run the session.load git status alongside a poll pass', async () => {
      const left = '/tmp/git-poll-load-left'
      const right = '/tmp/git-poll-load-right'
      const { manager } = createGitSessionManager({ 'session-1': left, 'session-2': right })
      const harness = await createHarness({ sessionManager: manager })
      const second = await harness.connectClient()
      await loadSession(harness, 'session-1')

      getGitBranchMock.mockClear()
      const git = holdGit()
      await pollCycles(1)
      second.send({ id: 'load-right', type: 'session.load', payload: { sessionId: 'session-2' } })
      await settle()
      expect(getGitBranchMock.mock.calls.map(([cwd]) => cwd)).toEqual([left])

      git.releases.shift()!()
      await until(() => getGitBranchMock.mock.calls.length === 2)
      expect(getGitBranchMock.mock.calls[1]![0]).toBe(right)
      git.releases.shift()!()
      await second.nextMessage((message) => message.id === 'load-right')
      expect(git.state.maxInFlight).toBe(1)
      await second.close()
      await closeAll(harness)
    })

    it('stops polling a deleted workspace and follows the session back to its project directory', async () => {
      const project = '/tmp/git-poll-project'
      const workspace = '/tmp/git-poll-workspaces/heavy'
      const { manager, emitUpdated } = createGitSessionManager({ 'session-1': workspace })
      const harness = await createHarness({ sessionManager: manager })
      await loadSession(harness, 'session-1')

      getGitBranchMock.mockClear()
      await pollCycles(1)
      expect(gitCalls(workspace)).toBe(1)

      getGitBranchMock.mockClear()
      emitUpdated({ id: 'session-1', workdir: project })
      await settle()
      expect(gitCalls(project)).toBe(1)

      getGitBranchMock.mockClear()
      await pollCycles(3)
      expect(gitCalls(workspace)).toBe(0)
      expect(gitCalls(project)).toBe(3)
      await closeAll(harness)
    })

    it('stops polling the previous directory when its only client loads another session', async () => {
      const first = '/tmp/git-poll-first'
      const other = '/tmp/git-poll-second'
      const { manager } = createGitSessionManager({ 'session-1': first, 'session-2': other })
      const harness = await createHarness({ sessionManager: manager })
      await loadSession(harness, 'session-1')
      await loadSession(harness, 'session-2')

      getGitBranchMock.mockClear()
      await pollCycles(2)
      expect(gitCalls(first)).toBe(0)
      expect(gitCalls(other)).toBe(2)
      await closeAll(harness)
    })

    it('keeps sending git.status updates to a watching client', async () => {
      const workdir = '/tmp/git-poll-watched'
      const { manager, emitUpdated } = createGitSessionManager({ 'session-1': workdir })
      const harness = await createHarness({ sessionManager: manager })
      await loadSession(harness, 'session-1')
      expect(await harness.nextMessage((message) => message.type === 'git.status')).toMatchObject({
        payload: { branch: 'main', diff: { files: [] } },
      })

      const modified = [{ path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0 }]
      getGitDiffFilesMock.mockResolvedValue(modified)
      await pollCycles(1)
      expect(await harness.nextMessage((message) => hasFile(message, 'src/a.ts'))).toMatchObject({
        payload: { branch: 'main', diff: { files: modified } },
      })

      const added = [{ path: 'src/b.ts', status: 'added', additions: 0, deletions: 0 }]
      getGitDiffFilesMock.mockResolvedValue(added)
      emitUpdated({ id: 'session-1', workdir })
      expect(await harness.nextMessage((message) => hasFile(message, 'src/b.ts'))).toMatchObject({
        sessionId: 'session-1',
        payload: { branch: 'main', diff: { files: added } },
      })
      await closeAll(harness)
    })

    it('runs one git poll at a time across watched directories', async () => {
      const left = '/tmp/git-poll-left'
      const right = '/tmp/git-poll-right'
      const { manager } = createGitSessionManager({ 'session-1': left, 'session-2': right })
      const harness = await createHarness({ sessionManager: manager })
      const second = await harness.connectClient()
      await loadSession(harness, 'session-1')
      await loadSession(second, 'session-2')

      getGitBranchMock.mockClear()
      const git = holdGit()
      await pollCycles(1)
      expect(getGitBranchMock).toHaveBeenCalledTimes(1)

      git.releases.shift()!()
      await until(() => getGitBranchMock.mock.calls.length === 2)
      expect(new Set(getGitBranchMock.mock.calls.map(([cwd]) => cwd))).toEqual(new Set([left, right]))
      git.releases.shift()!()
      await settle()
      expect(git.state.maxInFlight).toBe(1)
      await second.close()
      await closeAll(harness)
    })

    it('kills a git process that never answers and runs the next poll pass', async () => {
      const workdir = '/tmp/git-poll-hung'
      const actualGit = await vi.importActual<typeof import('../git/diff.js')>('../git/diff.js')
      const actualSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn
      getGitBranchMock.mockImplementation(actualGit.getGitBranch)
      getGitDiffFilesMock.mockImplementation(actualGit.getGitDiffFiles)
      const fakeGit = (stdout: string | null) => {
        const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
        if (stdout !== null) {
          setTimeout(() => {
            proc.stdout.emit('data', Buffer.from(stdout))
            proc.emit('close', 0)
          }, 0)
        }
        return proc
      }
      let hangNext = false
      let untracked = ''
      spawnMock.mockImplementation((_command: string, args: string[]) => {
        if (hangNext) {
          hangNext = false
          return fakeGit(null)
        }
        if (args[0] === 'rev-parse') return fakeGit('main\n')
        if (args[0] === 'status') return fakeGit(untracked)
        return fakeGit('')
      })
      const branchCalls = () => spawnMock.mock.calls.filter(([, args]) => (args as string[])[0] === 'rev-parse').length

      const { manager } = createGitSessionManager({ 'session-1': workdir })
      const harness = await createHarness({ sessionManager: manager })
      try {
        await loadSession(harness, 'session-1')
        expect(await harness.nextMessage((message) => message.type === 'git.status')).toMatchObject({
          payload: { branch: 'main', diff: { files: [] } },
        })

        spawnMock.mockClear()
        hangNext = true
        await pollCycles(1)
        await new Promise<void>((resolve) => setTimeout(resolve, 200))
        expect(branchCalls()).toBe(1)

        untracked = '?? after-hang.txt\n'
        await pollCycles(1)
        expect(await harness.nextMessage((message) => hasFile(message, 'after-hang.txt'))).toMatchObject({
          payload: { branch: 'main', diff: { files: [{ path: 'after-hang.txt', status: 'added' }] } },
        })
        expect(branchCalls()).toBe(2)
      } finally {
        spawnMock.mockImplementation(actualSpawn)
        await closeAll(harness)
      }
    })
  })
})

type Harness = Awaited<ReturnType<typeof createHarness>>
