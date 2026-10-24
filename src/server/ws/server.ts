import { WebSocketServer, WebSocket } from 'ws'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { ServerMessage } from '../../shared/protocol.js'
import type { GitDiffFile } from '../../shared/protocol.js'
import { createServerMessage } from '../../shared/protocol.js'
import { createSessionStateMessage } from './protocol.js'
import { handleTerminalMessage, unsubscribeAllFromTerminal } from './terminal.js'
import type { Config } from '../config.js'
import type { LLMClientWithModel } from '../llm/client.js'
import type { SessionManager } from '../session/index.js'
import {
  getSessionRuntimeRegistry,
  isSessionAlreadyRunningError,
  type ExecutionHandle,
  type RuntimeKind,
} from '../session/index.js'
import { getEventStore, combineEventsWithSnapshot } from '../events/index.js'
import { getMaxVisibleItems } from '../db/settings.js'

import type { Message, Provider, ProviderBackend, StatsIdentity, Attachment } from '../../shared/types.js'
import type { ProviderManager } from '../provider-manager.js'
import { runChatTurn } from '../chat/orchestrator.js'
import { interruptLLMRetryWait, hasRecentLLMFailure } from '../chat/stream-pure.js'

import { launchWorkflowRun, type TurnCleanupOutcome } from '../runner/launch.js'
import { appendCompactionPrompt } from '../context/compactor.js'
import { computeSessionHash, applyDynamicContext, computeUnifiedDiff } from '../chat/dynamic-context.js'
import { provideAnswer } from '../tools/index.js'
import { logger } from '../utils/logger.js'
import { devServerManager } from '../dev-server/manager.js'
import { onProcessEvent } from '../tools/background-process/manager.js'
import {
  buildMessagesFromStoredEvents,
  buildSessionStatsMessages,
  foldPendingConfirmations,
} from '../events/folding.js'
import { computeSessionStatsSummary } from '../../shared/stats.js'
import { getPendingQuestionsForSession } from '../tools/index.js'
import { generateSessionNameForSession, needsNameGeneration } from '../session/name-generator.js'
import { getSessionMessageCount } from '../utils/session-utils.js'
import { serverT } from '../i18n.js'
import type { Translation } from '../../shared/i18n/index.js'
import type { WorkerSettledOutcome } from '../session/worker/manager.js'
import type { WorkerTurnCommand } from '../session/worker/protocol.js'
import type { AdmissionResult } from '../session/worker/scheduler.js'

const MSG_INVALID_MESSAGE_FORMAT: Translation = { en: 'Invalid message format', fr: 'Format de message invalide' }
const MSG_NO_ACTIVE_SESSION: Translation = { en: 'No active session', fr: 'Aucune session active' }
const MSG_SESSION_NOT_FOUND: Translation = { en: 'Session not found', fr: 'Session introuvable' }
const MSG_SESSION_IS_RUNNING: Translation = {
  en: 'Session is already running',
  fr: 'La session est déjà en cours d’exécution',
}
const MSG_UNKNOWN_ERROR: Translation = { en: 'Unknown error', fr: 'Erreur inconnue' }

// Resolved once initial MCP connections settle — checkDynamic awaits this
let resolveMcpReady: (() => void) | null = null
const mcpReadyPromise = new Promise<void>((resolve) => {
  resolveMcpReady = resolve
})

export function signalMcpReady(): void {
  resolveMcpReady?.()
}

import { getAuthConfig, isValidToken } from '../auth.js'
import { getGitBranch, getGitDiffFiles } from '../git/diff.js'
import {
  parseClientMessage,
  serializeServerMessage,
  createErrorMessage,
  createSessionRunningMessage,
  createSessionCreatedMessage,
  createSessionPauseMessage,
  createChatMessageMessage,
  createChatErrorMessage,
  createContextStateMessage,
  isSessionLoadPayload,
  isAskAnswerPayload,
  storedEventToServerMessage,
  createQueueStateMessage,
  createGitStatusMessage,
} from './protocol.js'

function moduleGitBranch(cwd: string): Promise<string | null> {
  return getGitBranch(cwd)
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function moduleGitDiff(cwd: string): Promise<{ hash: string; files: GitDiffFile[] }> {
  const files = await getGitDiffFiles(cwd)
  const raw = files.map((f) => `${f.status}\t${f.path}`).join('\n')
  const hash = raw ? hashContent(raw) : ''
  return { hash, files }
}

const moduleWorkdirLastHash = new Map<string, string>()
const moduleWorkdirInterval = new Map<string, ReturnType<typeof setInterval>>()
const gitPollInterval = parseInt(process.env['OPENFOX_GIT_POLL_INTERVAL'] ?? '', 10) || 10_000
let moduleClients: Map<WebSocket, ClientConnection> | null = null
let moduleEnqueueSend: ((client: ClientConnection, data: string, seq: number) => void) | null = null

const moduleGitRefreshQueue = new Map<string, boolean>()
let moduleGitRefreshRunning = false
let moduleGitTail: Promise<unknown> = Promise.resolve()

function moduleWithGitLock<T>(task: () => Promise<T>): Promise<T> {
  const run = moduleGitTail.then(task)
  moduleGitTail = run.catch(() => undefined)
  return run
}

function moduleIsWorkdirWatched(workdir: string): boolean {
  for (const client of moduleClients?.values() ?? []) {
    if (client.activeWorkdir === workdir) return true
  }
  return false
}

async function moduleRefreshGitStatus(workdir: string, notifyUnchanged: boolean): Promise<void> {
  if (!moduleIsWorkdirWatched(workdir)) return
  const branch = await moduleGitBranch(workdir)
  if (!moduleIsWorkdirWatched(workdir)) return
  if (branch) moduleStartGitPolling(workdir)
  else if (!moduleWorkdirInterval.has(workdir)) return
  const { hash, files } = await moduleGitDiff(workdir)
  if (!moduleIsWorkdirWatched(workdir)) return
  const changed = hash !== moduleWorkdirLastHash.get(workdir)
  if (moduleWorkdirInterval.has(workdir)) moduleWorkdirLastHash.set(workdir, hash)
  if (!changed && !notifyUnchanged) return
  const msg = createGitStatusMessage(branch, files)
  const activeClients = moduleClients
  const sendFn = moduleEnqueueSend
  if (!activeClients || !sendFn) return
  for (const [ws, client] of activeClients) {
    if (client.activeWorkdir === workdir && ws.readyState === WebSocket.OPEN) {
      const seq = client.lastSentSeq + 1
      sendFn(client, serializeServerMessage({ ...msg, sessionId: client.activeSessionId ?? '' }), seq)
    }
  }
}

function moduleQueueGitRefresh(workdir: string, notifyUnchanged: boolean): void {
  moduleGitRefreshQueue.set(workdir, notifyUnchanged || moduleGitRefreshQueue.get(workdir) === true)
  if (moduleGitRefreshRunning) return
  moduleGitRefreshRunning = true
  void (async () => {
    try {
      for (const [queued, notify] of moduleGitRefreshQueue) {
        moduleGitRefreshQueue.delete(queued)
        try {
          await moduleWithGitLock(() => moduleRefreshGitStatus(queued, notify))
        } catch {
          /* skip */
        }
      }
    } finally {
      moduleGitRefreshRunning = false
    }
  })()
}

function moduleStartGitPolling(workdir: string) {
  if (moduleWorkdirInterval.has(workdir)) return
  const interval = setInterval(() => moduleQueueGitRefresh(workdir, false), gitPollInterval)
  moduleWorkdirInterval.set(workdir, interval)
}

function moduleStopGitPolling(workdir: string) {
  const interval = moduleWorkdirInterval.get(workdir)
  if (interval !== undefined) {
    clearInterval(interval)
    moduleWorkdirInterval.delete(workdir)
    moduleWorkdirLastHash.delete(workdir)
  }
}

function moduleStopUnwatchedGitPolling() {
  for (const workdir of [...moduleWorkdirInterval.keys()]) {
    if (!moduleIsWorkdirWatched(workdir)) moduleStopGitPolling(workdir)
  }
}

function resolveStatsIdentity(
  llmClient: LLMClientWithModel,
  getActiveProvider?: () => Provider | undefined,
): StatsIdentity {
  const provider = getActiveProvider?.()
  const model = llmClient.getModel()
  const backend = provider?.backend ?? (llmClient.getBackend() === 'unknown' ? 'unknown' : llmClient.getBackend())
  const reasoningEffort = llmClient.getReasoningEffort?.()

  return {
    providerId: provider?.id ?? `provider:${model}`,
    providerName: provider?.name ?? 'Unknown Provider',
    backend,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

function acquireRuntime(
  sessionId: string,
  kind: RuntimeKind,
  messageId: string,
  send: (msg: ServerMessage) => void,
): ExecutionHandle | null {
  try {
    return getSessionRuntimeRegistry().get(sessionId).acquire(kind)
  } catch (error) {
    if (isSessionAlreadyRunningError(error)) {
      send(createErrorMessage('SESSION_RUNNING', error.message, messageId))
      return null
    }
    throw error
  }
}

function addUserMessageAndBroadcast(
  sessionManager: SessionManager,
  sessionId: string,
  message: { content: string; attachments?: Attachment[]; messageKind?: string | undefined },
  broadcastFn: (sessionId: string, msg: ServerMessage) => void,
): ReturnType<SessionManager['addMessage']> {
  const userMessage = sessionManager.addMessage(sessionId, {
    role: 'user',
    content: message.content,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.messageKind ? { messageKind: message.messageKind as Exclude<Message['messageKind'], undefined> } : {}),
  })
  broadcastFn(sessionId, createChatMessageMessage(userMessage))
  return userMessage
}

function processQueueAndRestartTurn(
  sessionManager: SessionManager,
  sessionId: string,
  drainFn: (
    sessionId: string,
  ) => Array<{ content: string; attachments?: Attachment[]; messageKind?: string; queueId?: string }>,
  queueMode: 'asap' | 'completion',
  broadcastFn: (sessionId: string, msg: ServerMessage) => void,
  startTurnFn: (sessionId: string, handle: ExecutionHandle) => void,
  queueMessageFn?: (
    sessionId: string,
    mode: 'asap' | 'completion',
    content: string,
    attachments?: Attachment[],
    messageKind?: string,
  ) => void,
): boolean {
  let handle: ExecutionHandle
  try {
    handle = getSessionRuntimeRegistry().get(sessionId).acquire('chat')
  } catch (error) {
    if (isSessionAlreadyRunningError(error)) return false
    throw error
  }

  const messages = drainFn(sessionId)
  const next = messages[0]
  if (!next) {
    getSessionRuntimeRegistry().peek(sessionId)?.release(handle)
    return false
  }

  for (const remaining of messages.slice(1)) {
    if (queueMessageFn) {
      queueMessageFn(
        sessionId,
        queueMode,
        remaining.content,
        remaining.attachments,
        remaining.messageKind as 'command' | undefined,
      )
    } else {
      sessionManager.queueMessage(sessionId, queueMode, remaining.content, remaining.attachments)
    }
  }
  broadcastFn(sessionId, createQueueStateMessage(sessionManager.getQueueState(sessionId)))

  addUserMessageAndBroadcast(
    sessionManager,
    sessionId,
    {
      content: next.content,
      ...(next.attachments ? { attachments: next.attachments } : {}),
      ...(next.messageKind ? { messageKind: next.messageKind } : {}),
    },
    broadcastFn,
  )

  startTurnFn(sessionId, handle)
  return true
}

interface ClientConnection {
  ws: WebSocket
  activeSessionId: string | null
  activeWorkdir: string | null
  globalSubscription: (() => void) | null
  sendQueue: Array<{ data: string; seq: number }>
  isSending: boolean
  lastSentSeq: number
}

const MAX_SEND_QUEUE_SIZE = 1000 // Maximum messages to queue before dropping

/**
 * WebSocket Message Ordering Implementation
 *
 * This module implements ordered message delivery to prevent race conditions
 * when multiple events are emitted in rapid succession.
 *
 * Key Design Decisions:
 *
 * 1. Per-Client Send Queue: Each WebSocket client has its own FIFO queue
 *    that ensures messages are sent in strict order, preventing the
 *    "garbled UI" issue where messages arrive out of order.
 *
 * 2. Single Event Source: Only EventStore global subscription is used.
 *    SessionManager legacy events are NOT forwarded to prevent duplicates.
 *    All session state changes go through EventStore (mode.changed,
 *    phase.changed, running.changed, etc.).
 *
 * 3. Sequence Numbers: Messages include sequence numbers for ordering:
 *    - EventStore events: Use storedEvent.seq (database sequence)
 *    - Generated messages: Use client.lastSentSeq + 1
 *    Sequence numbers may have gaps due to event deletion or multiple
 *    sessions, but are always monotonically increasing per client.
 *
 * 4. Queue Size Limit: MAX_SEND_QUEUE_SIZE prevents memory leaks on
 *    slow or disconnected clients. Messages are dropped if queue is full.
 *
 * @see https://github.com/conrad/openfox/issues/XXX
 */

export interface WebSocketWorkerController {
  isEnabled(): boolean
  requestTurn(sessionId: string, start: () => void): AdmissionResult
  releaseTurn(sessionId: string): boolean
  launch(sessionId: string, onSettled: (outcome: WorkerSettledOutcome) => void, command?: WorkerTurnCommand): void
  answerQuestion?(callId: string, answer: string, skip: boolean): boolean
}

export function createWebSocketServer(
  httpServer: Server,
  _config: Config,
  getLLMClient: () => LLMClientWithModel,
  getActiveProvider: (() => Provider | undefined) | undefined,
  sessionManager: SessionManager,
  providerManager?: ProviderManager,
  getMcpServers?: () => import('../mcp/types.js').McpServerState[],
  getWorkerController?: () => WebSocketWorkerController | undefined,
  onCleanWorkerTurnSettled?: (sessionId: string) => void,
): WebSocketServerExports {
  const wss = new WebSocketServer({ server: httpServer })
  const clients = new Map<WebSocket, ClientConnection>()
  moduleClients = clients

  // Per-session LLM client cache: sessionId -> { cacheKey, client }
  const sessionLLMClients = new Map<string, { key: string; client: LLMClientWithModel }>()

  function getSessionLLMClient(sessionId: string): LLMClientWithModel {
    const effective = sessionManager.resolveEffectiveProviderModel(sessionId)
    if (!effective.providerId || !effective.model || !providerManager) {
      return getLLMClient()
    }

    const resolvedModel = providerManager.resolveModel(effective.providerId, effective.model)
    const effectiveModel = resolvedModel ?? effective.model
    const cacheKey = `${effective.providerId}:${effectiveModel}:${effective.reasoningEffort ?? ''}`
    const cached = sessionLLMClients.get(sessionId)
    if (cached && cached.key === cacheKey) {
      return cached.client
    }

    // Look up the provider to get URL, apiKey, backend
    const provider = providerManager.getProviders().find((p) => p.id === effective.providerId)
    if (!provider) {
      // Provider is gone — fall back to global. Only clear the STICKY preference
      // when the preference itself references the deleted provider.
      logger.warn('Session references missing provider, falling back to global', {
        sessionId,
        providerId: effective.providerId,
      })
      const session = sessionManager.getSession(sessionId)
      if (session?.providerId === effective.providerId) {
        sessionManager.setSessionProvider(sessionId, null, null, false, null)
        sessionManager.setSessionProviderActive(sessionId, true)
      }
      sessionLLMClients.delete(sessionId)
      return getLLMClient()
    }

    // Let ProviderManager create the session client so provider-specific
    // transports (for example External Provider custom) and auth context are preserved.
    const client = providerManager.createClient(effective.providerId, effectiveModel, effective.reasoningEffort)
    if (!client) {
      logger.warn('Could not create session provider client, falling back to global', {
        sessionId,
        providerId: effective.providerId,
        model: effective.model,
      })
      return getLLMClient()
    }

    const concreteModel = client.getModel()
    const session = sessionManager.getSession(sessionId)
    // Only normalize the stored preference when the EFFECTIVE model is sourced
    // from that preference (model-name resolution, e.g. 'auto' → concrete). When
    // the effective model comes from an agent override, never write it back —
    // it would silently clobber the user's sticky pick.
    if (
      session?.providerId === effective.providerId &&
      session.providerModel === effective.model &&
      session.providerModel !== concreteModel
    ) {
      sessionManager.setSessionProvider(
        sessionId,
        effective.providerId,
        concreteModel,
        undefined,
        effective.reasoningEffort,
      )
    }
    sessionLLMClients.set(sessionId, {
      key: `${effective.providerId}:${concreteModel}:${effective.reasoningEffort ?? ''}`,
      client,
    })
    return client
  }

  function getSessionStatsIdentity(sessionId: string): StatsIdentity {
    const effective = sessionManager.resolveEffectiveProviderModel(sessionId)
    if (!effective.providerId || !providerManager) {
      return resolveStatsIdentity(getLLMClient(), getActiveProvider)
    }

    const provider = providerManager.getProviders().find((p) => p.id === effective.providerId)
    const client = getSessionLLMClient(sessionId)
    const reasoningEffort = client.getReasoningEffort?.()
    return {
      providerId: provider?.id ?? effective.providerId,
      providerName: provider?.name ?? 'Unknown Provider',
      backend: (provider?.backend ?? client.getBackend()) as ProviderBackend,
      model: client.getModel(),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  const isSubscribedToSession = (client: ClientConnection, sessionId: string) => {
    return client.activeSessionId === sessionId
  }

  // Ordered send queue implementation for FIFO message delivery
  function enqueueSend(client: ClientConnection, data: string, seq: number): void {
    // Drop message if queue is too large (prevents memory leak on slow clients)
    if (client.sendQueue.length >= MAX_SEND_QUEUE_SIZE) {
      logger.warn('WebSocket send queue full, dropping message', {
        queueSize: client.sendQueue.length,
        sessionId: client.activeSessionId,
      })
      return
    }
    client.sendQueue.push({ data, seq })
    processSendQueue(client)
  }
  moduleEnqueueSend = enqueueSend

  function processSendQueue(client: ClientConnection): void {
    if (client.isSending || client.sendQueue.length === 0) {
      return
    }

    client.isSending = true
    const item = client.sendQueue.shift()!

    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(item.data, (err) => {
        if (err) {
          logger.debug('WebSocket send error', { error: err })
        }
        client.isSending = false
        client.lastSentSeq = item.seq
        processSendQueue(client)
      })
    } else {
      client.isSending = false
      processSendQueue(client)
    }
  }

  const llmForSession = (sessionId: string): LLMClientWithModel => getSessionLLMClient?.(sessionId) ?? getLLMClient()

  const statsForSession = (sessionId: string): StatsIdentity =>
    getSessionStatsIdentity?.(sessionId) ?? resolveStatsIdentity(getLLMClient(), getActiveProvider)

  function cleanupAfterTurn(
    sessionId: string,
    handle: ExecutionHandle,
    sendFn: (sessionId: string, msg: ServerMessage) => void,
  ): TurnCleanupOutcome {
    const runtime = getSessionRuntimeRegistry().peek(sessionId)
    const stopped = runtime?.wasStopped(handle) ?? false
    if (!runtime?.release(handle)) {
      return 'stale'
    }

    if (stopped) {
      sessionManager.clearMessageQueue(sessionId)
      const contextState = sessionManager.getContextState(sessionId)
      sendFn(sessionId, createContextStateMessage(contextState))
      return 'settled'
    }

    const processed = processQueueAndRestartTurn(
      sessionManager,
      sessionId,
      (sid) => sessionManager.drainAsapMessages(sid),
      'asap',
      sendFn,
      startTurnWithCompletionChain,
      (sid, mode, content, attachments, messageKind) =>
        sessionManager.queueMessage(sid, mode, content, attachments, messageKind as 'command' | undefined),
    )
    if (processed) {
      return 'restarted'
    }

    const processedCompletion = processQueueAndRestartTurn(
      sessionManager,
      sessionId,
      (sid) => sessionManager.drainCompletionMessages(sid),
      'completion',
      sendFn,
      startTurnWithCompletionChain,
    )
    if (processedCompletion) {
      return 'restarted'
    }

    sessionManager.clearMessageQueue(sessionId)
    // runChatTurn in startTurnWithCompletionChain already sets isRunning=false in finally.
    // For the runner orchestrator path (which bypasses runChatTurn), the caller's
    // .finally() block handles setRunning(false) explicitly.
    const contextState = sessionManager.getContextState(sessionId)
    sendFn(sessionId, createContextStateMessage(contextState))
    return 'settled'
  }

  function startTurnWithCompletionChain(sessionId: string, handle: ExecutionHandle) {
    runChatTurn({
      sessionManager,
      sessionId,
      llmClient: llmForSession(sessionId),
      getSessionLLMClient: () => llmForSession(sessionId),
      statsIdentity: statsForSession(sessionId),
      signal: handle.signal,
      onMessage: (msg) => broadcastForSession(sessionId, msg),
    })
      .catch((error) => {
        if (error instanceof Error && error.message === 'Aborted') {
          return
        }
        logger.error('Chat turn error', { error })
      })
      .finally(() => {
        try {
          cleanupAfterTurn(sessionId, handle, broadcastForSession)
        } catch {
          // Session may have been deleted during execution
        }
      })
  }

  // Note: SessionManager subscription removed - EventStore global subscription (below)
  // is the single source of truth for all session events including running.changed

  // Broadcast all (dev server events, cross-session confirmations)
  const broadcastAll = (msg: ServerMessage) => {
    const serialized = serializeServerMessage(msg)
    for (const [clientWs, client] of clients) {
      if (clientWs.readyState === WebSocket.OPEN) {
        const seq = client.lastSentSeq + 1
        enqueueSend(client, serialized, seq)
      }
    }
  }

  const broadcastForSession = (sessionId: string, msg: ServerMessage) => {
    // Runs for every streamed delta: serialize once, and only look up the
    // project (from the sessions row, never the folded session) when a
    // confirmation has to reach other sessions of the project.
    let serialized: string | undefined
    for (const [clientWs, client] of clients) {
      if (clientWs.readyState !== WebSocket.OPEN) continue
      if (!isSubscribedToSession(client, sessionId)) continue
      const seq = client.lastSentSeq + 1
      serialized ??= serializeServerMessage({ ...msg, sessionId })
      enqueueSend(client, serialized, seq)
    }
    const isConfirmation = msg.type === 'chat.path_confirmation' || msg.type === 'session.confirmation_resolved'
    const projectId = isConfirmation ? sessionManager.getSessionProjectId(sessionId) : undefined
    // Broadcast confirmations and their resolution to non-subscribed clients within the same project
    if (isConfirmation && projectId) {
      for (const [clientWs, client] of clients) {
        if (clientWs.readyState !== WebSocket.OPEN) continue
        if (isSubscribedToSession(client, sessionId)) continue
        const clientProjectId = client.activeSessionId
          ? sessionManager.getSessionProjectId(client.activeSessionId)
          : undefined
        if (clientProjectId !== projectId) continue
        const seq = client.lastSentSeq + 1
        const crossSessionType =
          msg.type === 'chat.path_confirmation' ? 'session.confirmation_pending' : 'session.confirmation_resolved'
        enqueueSend(client, serializeServerMessage({ type: crossSessionType, sessionId, payload: msg.payload }), seq)
      }
    }
  }

  const broadcastForProject = (projectId: string, sessionId: string, msg: ServerMessage) => {
    for (const [clientWs, client] of clients) {
      if (clientWs.readyState !== WebSocket.OPEN) continue
      const clientProjectId = client.activeSessionId
        ? sessionManager.getSession(client.activeSessionId)?.projectId
        : undefined
      if (clientProjectId !== projectId) continue
      const seq = client.lastSentSeq + 1
      enqueueSend(client, serializeServerMessage({ ...msg, sessionId }), seq)
    }
  }

  // Global dev server event listeners — broadcast to all WS clients
  devServerManager.onOutput((workdir, chunk) => {
    broadcastAll(
      createServerMessage('devServer.output', {
        workdir,
        stream: chunk.stream,
        content: chunk.content,
      }),
    )
  })

  devServerManager.onStateChange((workdir, state, errorMessage, url, inspectProxyPort) => {
    broadcastAll(
      createServerMessage('devServer.state', {
        workdir,
        state,
        errorMessage,
        url,
        inspectProxyPort,
      }),
    )
  })

  // Session update events — broadcast session.state to session-specific clients
  sessionManager.subscribe((event) => {
    if (event.type === 'session_created') {
      broadcastAll({ ...createSessionCreatedMessage(event.session), sessionId: event.session.id })
      return
    }
    if (event.type === 'pause_changed') {
      // Lightweight pause-state sync (no full session.state rebuild)
      broadcastForSession(event.sessionId, createSessionPauseMessage(event.pauseState))
      return
    }
    if (event.type === 'session_updated') {
      const updatedSession = event.session
      const eventStore = getEventStore()
      const { snapshot, events: eventsSinceSnapshot } = eventStore.getEventsSinceSnapshot(updatedSession.id)
      const events = combineEventsWithSnapshot(updatedSession.id, snapshot, eventsSinceSnapshot)

      const maxVisible = getMaxVisibleItems()
      const { messages, hiddenCount } = buildMessagesFromStoredEvents(events, maxVisible || undefined)
      const sessionStats = computeSessionStatsSummary(buildSessionStatsMessages(events))
      const pendingConfirmations = foldPendingConfirmations(events)
      const pendingQuestions = getPendingQuestionsForSession(updatedSession.id)
      const activeWorkflowExecution = sessionManager.getDisplayWorkflowExecution(updatedSession.id)

      // Update activeWorkdir when workspace changed so git polling picks up the right dir
      const effectiveWorkdir = updatedSession.workspace ?? updatedSession.workdir

      for (const [, client] of clients) {
        if (client.activeSessionId === updatedSession.id) client.activeWorkdir = effectiveWorkdir
      }
      moduleStopUnwatchedGitPolling()

      // Broadcast session.state immediately — synchronous, no await
      broadcastForSession(
        updatedSession.id,
        createSessionStateMessage(
          updatedSession,
          messages,
          pendingConfirmations,
          pendingQuestions,
          undefined,
          undefined,
          hiddenCount,
          activeWorkflowExecution ?? undefined,
          sessionStats,
        ),
      )

      // Always send git.status after a session update to sync workspace/branch in the UI,
      // even when the workspace path hasn't changed (e.g. branch-only change).
      if (effectiveWorkdir && moduleIsWorkdirWatched(effectiveWorkdir)) {
        moduleQueueGitRefresh(effectiveWorkdir, true)
      }
    }
  })

  // Background process event listeners — broadcast to session-specific clients
  onProcessEvent((_processId, msg) => {
    const sessionId = msg.sessionId
    if (!sessionId) return
    // Route to clients subscribed to this session
    for (const [clientWs, client] of clients) {
      if (client.activeSessionId === sessionId) {
        if (clientWs.readyState === WebSocket.OPEN) {
          const seq = client.lastSentSeq + 1
          enqueueSend(client, serializeServerMessage(msg), seq)
        }
      }
    }
  })

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')

    const authConfig = getAuthConfig()
    if (authConfig?.strategy === 'network' && authConfig.encryptedPassword) {
      if (!token || !(await isValidToken(token))) {
        setTimeout(() => {
          ws.close(4000, 'Unauthorized')
        }, 100)
        return
      }
    }

    logger.debug('WebSocket client connected')
    clients.set(ws, {
      ws,
      activeSessionId: null,
      activeWorkdir: null,
      globalSubscription: null,
      sendQueue: [],
      isSending: false,
      lastSentSeq: 0,
    })

    // Subscribe to ALL session events (global subscription)
    const eventStore = getEventStore()
    const { iterator: globalIterator, unsubscribe: globalUnsubscribe } = eventStore.subscribeAll()
    clients.get(ws)!.globalSubscription = globalUnsubscribe

    // Start streaming all events to this client
    ;(async () => {
      try {
        for await (const storedEvent of globalIterator) {
          if (ws.readyState !== WebSocket.OPEN) break
          const serverMsg = storedEventToServerMessage(storedEvent)
          if (serverMsg) {
            const client = clients.get(ws)!
            enqueueSend(
              client,
              serializeServerMessage({ ...serverMsg, seq: storedEvent.seq, sessionId: storedEvent.sessionId }),
              storedEvent.seq,
            )
          }
        }
      } catch (error) {
        logger.debug('Global event subscription ended', { error })
      }
    })()

    ws.on('message', async (data) => {
      const message = parseClientMessage(data.toString())

      if (!message) {
        const client = clients.get(ws)!
        const seq = client.lastSentSeq + 1
        enqueueSend(
          client,
          serializeServerMessage(createErrorMessage('INVALID_MESSAGE', serverT(MSG_INVALID_MESSAGE_FORMAT))),
          seq,
        )
        return
      }

      // Handle terminal messages separately
      if (message.type.startsWith('terminal.')) {
        handleTerminalMessage(ws, message as unknown as Parameters<typeof handleTerminalMessage>[1])
        return
      }

      const client = clients.get(ws)!

      try {
        await handleClientMessage(
          ws,
          client,
          message,
          getLLMClient,
          getActiveProvider,
          sessionManager,
          broadcastForSession,
          providerManager,
          getSessionLLMClient,
          getSessionStatsIdentity,
          llmForSession,
          statsForSession,
          startTurnWithCompletionChain,
          cleanupAfterTurn,
          enqueueSend,
          getMcpServers,
          getWorkerController,
          onCleanWorkerTurnSettled,
        )
      } catch (error) {
        logger.error('Error handling client message', { error, type: message.type })
        const client = clients.get(ws)!
        const seq = client.lastSentSeq + 1
        enqueueSend(
          client,
          serializeServerMessage(
            createErrorMessage(
              'INTERNAL_ERROR',
              error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR),
              message.id,
            ),
          ),
          seq,
        )
      }
    })

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected')
      const client = clients.get(ws)
      // Unsubscribe from global all-session subscription
      if (client?.globalSubscription) {
        client.globalSubscription()
      }
      // Unsubscribe from all terminal sessions
      unsubscribeAllFromTerminal(ws)
      clients.delete(ws)
      moduleStopUnwatchedGitPolling()
    })

    ws.on('error', (error) => {
      logger.error('WebSocket error', { error })
    })
  })

  return {
    wss,
    abortSession: (sessionId: string) => {
      sessionManager.clearPauseState(sessionId)
      return getSessionRuntimeRegistry().get(sessionId).stop()
    },
    close: (cb?: () => void) => wss.close(cb as (err?: Error) => void),
    broadcastForSession,
    broadcastForProject,
    broadcastAll,
  }
}

export interface WebSocketServerExports {
  wss: WebSocketServer
  abortSession: (sessionId: string) => boolean
  close: (cb?: () => void) => void
  broadcastForSession: (sessionId: string, msg: ServerMessage) => void
  broadcastForProject: (projectId: string, sessionId: string, msg: ServerMessage) => void
  broadcastAll: (msg: ServerMessage) => void
}

async function handleClientMessage(
  ws: WebSocket,
  client: ClientConnection,
  message: { id: string; type: string; payload: unknown },
  _getLLMClient: () => LLMClientWithModel,
  _getActiveProvider: (() => Provider | undefined) | undefined,
  sessionManager: SessionManager,
  _broadcastForSession: (sessionId: string, msg: ServerMessage) => void,
  _providerManager: ProviderManager | undefined,
  _getSessionLLMClient: ((sessionId: string) => LLMClientWithModel) | undefined,
  _getSessionStatsIdentity: ((sessionId: string) => StatsIdentity) | undefined,
  llmForSession: (sessionId: string) => LLMClientWithModel,
  statsForSession: (sessionId: string) => StatsIdentity,
  _startTurnWithCompletionChain: (sessionId: string, handle: ExecutionHandle) => void,
  cleanupAfterTurn: (
    sessionId: string,
    handle: ExecutionHandle,
    sendFn: (sessionId: string, msg: ServerMessage) => void,
  ) => TurnCleanupOutcome,
  enqueueSendFn: (client: ClientConnection, data: string, seq: number) => void,
  getMcpServers?: () => import('../mcp/types.js').McpServerState[],
  getWorkerController?: () => WebSocketWorkerController | undefined,
  onCleanWorkerTurnSettled?: (sessionId: string) => void,
): Promise<void> {
  const send = (msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      const seq = client.lastSentSeq + 1
      enqueueSendFn(client, serializeServerMessage(msg), seq)
    }
  }

  const sendForSession = (sessionId: string, msg: ServerMessage) => {
    send({ ...msg, sessionId })
  }

  const runInWorkerIfEnabled = (
    sessionId: string,
    runtimeKind: RuntimeKind,
    command: WorkerTurnCommand,
    onSettled?: (outcome: WorkerSettledOutcome) => void,
  ): boolean => {
    const workerController = getWorkerController?.()
    if (!workerController?.isEnabled()) return false

    let startFailure: { code: string; reason: string } | undefined
    let admissionReturned = false
    const reportStartFailure = (failure: { code: string; reason: string }): void => {
      if (admissionReturned) send(createErrorMessage(failure.code, failure.reason, message.id))
      else startFailure = failure
    }
    const admission = workerController.requestTurn(sessionId, () => {
      let handle: ExecutionHandle
      try {
        handle = getSessionRuntimeRegistry().get(sessionId).acquire(runtimeKind)
      } catch (error) {
        workerController.releaseTurn(sessionId)
        reportStartFailure({
          code: 'SESSION_RUNNING',
          reason: error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR),
        })
        return
      }

      try {
        workerController.launch(
          sessionId,
          (outcome) => {
            const runtime = getSessionRuntimeRegistry().peek(sessionId)
            const stopped = runtime?.wasStopped(handle) ?? false
            const released = runtime?.release(handle) ?? false
            onSettled?.(outcome)
            if (released && !stopped && !outcome.crashed) onCleanWorkerTurnSettled?.(sessionId)
          },
          command,
        )
      } catch (error) {
        getSessionRuntimeRegistry().peek(sessionId)?.release(handle)
        workerController.releaseTurn(sessionId)
        reportStartFailure({
          code: 'WORKER_LAUNCH_FAILED',
          reason: error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR),
        })
      }
    })
    admissionReturned = true

    if (startFailure) {
      send(createErrorMessage(startFailure.code, startFailure.reason, message.id))
    } else if (admission === 'started' || admission === 'waiting') {
      send({ type: 'ack', payload: { admission }, id: message.id })
    } else {
      send(
        createErrorMessage(
          'WORKER_ADMISSION_REFUSED',
          serverT({
            en: 'The session worker pool cannot accept this turn',
            fr: 'Le pool de workers de session ne peut pas accepter ce tour',
          }),
          message.id,
        ),
      )
    }
    return true
  }

  const ensureEventStoreSubscription = (_sessionId: string) => {
    // No-op: clients now receive ALL events via global subscription
    // Per-session subscriptions were removed to prevent duplicate events
  }

  switch (message.type) {
    // =========================================================================
    // DEPRECATED: All CRUD operations moved to REST API
    // If you see this error, update your code to use REST endpoints instead.
    // See docs/REST-API.md for details.
    // =========================================================================

    case 'project.create':
    case 'project.create-with-dir':
    case 'project.list':
    case 'project.load':
    case 'project.update':
    case 'project.delete':
    case 'settings.get':
    case 'settings.set':
    case 'session.create':
    case 'session.list':
    case 'session.delete':
    case 'session.deleteAll':
    case 'session.setProvider':
      send(
        createErrorMessage(
          'DEPRECATED_MESSAGE_TYPE',
          `${message.type} removed. Use REST API instead. See docs/REST-API.md`,
          message.id,
        ),
      )
      return

    // =========================================================================
    // Session Load - Sets active session for event routing
    // Note: Data loading is done via REST API: GET /api/sessions/:id
    // This WebSocket message is ONLY to tell the server which session is active
    // so it can route real-time events correctly.
    // =========================================================================
    case 'session.load': {
      if (!isSessionLoadPayload(message.payload)) {
        send(
          createErrorMessage(
            'INVALID_PAYLOAD',
            serverT({ en: 'Invalid session.load payload', fr: 'Payload de session.load invalide' }),
            message.id,
          ),
        )
        return
      }

      const session = sessionManager.getSession(message.payload.sessionId)
      if (!session) {
        send(createErrorMessage('NOT_FOUND', serverT(MSG_SESSION_NOT_FOUND), message.id))
        return
      }

      // Tab model: set active session for event routing
      client.activeSessionId = session.id
      const effectiveWorkdir = sessionManager.getEffectiveWorkdir(session.id)
      client.activeWorkdir = effectiveWorkdir
      moduleStopUnwatchedGitPolling()

      // Send initial git status immediately
      if (effectiveWorkdir) {
        const { branch, files } = await moduleWithGitLock(async () => {
          const current = await moduleGitBranch(effectiveWorkdir)
          const diff = await moduleGitDiff(effectiveWorkdir)
          return { branch: current, files: diff.files }
        })
        const msg = createGitStatusMessage(branch, files)
        send(msg)
        if (branch && moduleIsWorkdirWatched(effectiveWorkdir)) moduleStartGitPolling(effectiveWorkdir)
      }

      ensureEventStoreSubscription(session.id)

      // Acknowledge without sending full session data
      // Frontend should use REST API to fetch session data
      send({ type: 'ack', payload: { sessionId: session.id }, id: message.id })

      // Send context.state
      const sendContextState = () => {
        const contextState = sessionManager.getContextState(session.id)
        send(createContextStateMessage(contextState))
      }
      sendContextState()

      // Re-detect dynamic context changes on load (survives server restart)
      // Also send MCP server state once MCP is ready
      const cachedHash = sessionManager.getCachedPrompt(session.id)?.hash
      ;(async () => {
        try {
          await mcpReadyPromise

          // Send current MCP server state
          if (getMcpServers) {
            const servers = getMcpServers()
            if (servers.length > 0) {
              send(createServerMessage('mcp.servers.changed', { servers }))
            }
          }

          if (cachedHash) {
            const modelName = session.providerModel ?? _providerManager?.getCurrentModel()
            const currentHash = await computeSessionHash(sessionManager, session.id, modelName)
            if (currentHash !== cachedHash) {
              sessionManager.setDynamicContextChanged(session.id, true)
              sendContextState()
            } else if (sessionManager.getDynamicContextChanged(session.id)) {
              sessionManager.setDynamicContextChanged(session.id, false)
              sendContextState()
            }
          }
        } catch {
          // Non-critical — banners and MCP state just won't be sent
        }
      })()
      break
    }

    // =========================================================================
    // Context Management
    // =========================================================================

    case 'context.compact': {
      const payload = message.payload as { sessionId?: string } | undefined
      const sessionId = payload?.sessionId ?? client.activeSessionId
      if (!sessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const session = sessionManager.requireSession(sessionId)

      // Check if session is running
      if (session.isRunning) {
        send(
          createErrorMessage(
            'SESSION_RUNNING',
            serverT({
              en: 'Cannot compact while session is running',
              fr: 'Impossible de compacter pendant que la session est en cours',
            }),
            message.id,
          ),
        )
        return
      }

      if (
        runInWorkerIfEnabled(sessionId, 'compact', { kind: 'compact' }, () => {
          try {
            sendForSession(sessionId, createContextStateMessage(sessionManager.getContextState(sessionId)))
          } catch {
            return
          }
        })
      ) {
        return
      }

      const compactHandle = acquireRuntime(sessionId, 'compact', message.id, send)
      if (!compactHandle) return

      try {
        // Acknowledge immediately
        send({ type: 'ack', payload: {}, id: message.id })

        // Append compaction prompt to event store (shared helper, same as agent-loop.ts auto-compaction trigger)
        appendCompactionPrompt(sessionId, (event) => getEventStore().append(sessionId, event))

        // Run through the agent loop — same path as auto-compaction and normal turns
        runChatTurn({
          sessionManager,
          sessionId,
          llmClient: llmForSession(sessionId),
          getSessionLLMClient: () => llmForSession(sessionId),
          statsIdentity: statsForSession(sessionId),
          signal: compactHandle.signal,
          onMessage: (msg) => _broadcastForSession(sessionId, msg),
          initialCompacting: true,
        })
          .then(() => {
            const newContextState = sessionManager.getContextState(sessionId)
            sendForSession(sessionId, createContextStateMessage(newContextState))
          })
          .catch((error) => {
            if (error instanceof Error && error.message === 'Aborted') return
            logger.error('Compaction failed', { error, sessionId })
            const reason = error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR)
            sendForSession(
              sessionId,
              createChatErrorMessage(
                serverT({ en: 'Compaction failed: {{reason}}', fr: 'Échec de la compaction : {{reason}}' }, { reason }),
                true,
              ),
            )
          })
          .finally(() => {
            try {
              const runtime = getSessionRuntimeRegistry().peek(sessionId)
              const stopped = runtime?.wasStopped(compactHandle) ?? false
              if (!runtime?.release(compactHandle)) return

              if (stopped) {
                sessionManager.clearMessageQueue(sessionId)
              }

              // runChatTurn sets isRunning=true but its finally only appends to EventStore.
              // We must update the DB and broadcast so the QueueProcessor can process
              // subsequent messages.
              sessionManager.setRunning(sessionId, false)
              sendForSession(sessionId, createSessionRunningMessage(false))

              // Send fresh context state
              const contextState = sessionManager.getContextState(sessionId)
              sendForSession(sessionId, createContextStateMessage(contextState))
            } catch {
              // Session may have been deleted during execution
            }
          })
      } catch (error) {
        logger.error('Compaction failed to start, releasing runtime', { error, sessionId })
        getSessionRuntimeRegistry().peek(sessionId)?.release(compactHandle)
        const reason = error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR)
        sendForSession(
          sessionId,
          createChatErrorMessage(
            serverT({ en: 'Compaction failed: {{reason}}', fr: 'Échec de la compaction : {{reason}}' }, { reason }),
            true,
          ),
        )
      }

      break
    }

    case 'context.checkDynamic': {
      if (!client.activeSessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const sessionId = client.activeSessionId

      ;(async () => {
        try {
          await mcpReadyPromise
          const session = sessionManager.requireSession(sessionId)
          const modelName = session.providerModel ?? _providerManager?.getCurrentModel()
          const currentHash = await computeSessionHash(sessionManager, sessionId, modelName)
          const cachedHash = sessionManager.getCachedPrompt(sessionId)?.hash

          if (cachedHash) {
            if (currentHash !== cachedHash) {
              logger.debug('checkDynamic: hash mismatch', {
                sessionId,
                cachedHash,
                currentHash,
              })
              if (!sessionManager.getDynamicContextChanged(sessionId)) {
                sessionManager.setDynamicContextChanged(sessionId, true)
                const newContextState = sessionManager.getContextState(sessionId)
                sendForSession(sessionId, createContextStateMessage(newContextState))
              }
            } else if (sessionManager.getDynamicContextChanged(sessionId)) {
              sessionManager.setDynamicContextChanged(sessionId, false)
              const newContextState = sessionManager.getContextState(sessionId)
              sendForSession(sessionId, createContextStateMessage(newContextState))
            }
          }

          send({ type: 'ack', payload: {}, id: message.id })
        } catch (error) {
          logger.error('Failed to check dynamic context', { error, sessionId })
          send({ type: 'ack', payload: {}, id: message.id })
        }
      })()

      break
    }

    case 'context.applyDynamic.preview': {
      const payload = message.payload as { sessionId?: string } | undefined
      const sessionId = payload?.sessionId ?? client.activeSessionId
      if (!sessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const session = sessionManager.requireSession(sessionId)

      try {
        const { buildCachedPrompt, computePreviewToolDiff } = await import('../chat/dynamic-context.js')
        const allAgents = await import('../agents/registry.js')
        const agentDef =
          allAgents.findAgentById(session.mode, await allAgents.loadAllAgentsDefault()) ??
          allAgents.findAgentById('planner', await allAgents.loadAllAgentsDefault())!
        const modelName = session.providerModel ?? _providerManager?.getCurrentModel()
        const {
          systemPrompt: newPrompt,
          tools: newTools,
          hash: newHash,
        } = await buildCachedPrompt(sessionManager, sessionId, agentDef, modelName)

        const oldCached = sessionManager.getCachedPrompt(sessionId)
        const oldPrompt = oldCached?.systemPrompt

        // Compute unified diff
        const diff = oldPrompt ? computeUnifiedDiff(oldPrompt, newPrompt) : []

        // Baseline: cached tools if present, else the unfiltered registry
        // (all MCP tools, no session overrides) so tool add/remove is visible
        // even before a cached prompt exists.
        const { getToolRegistryForAgent } = await import('../tools/index.js')
        const unfilteredTools = getToolRegistryForAgent(agentDef).definitions
        const toolDiff = computePreviewToolDiff(oldCached?.tools, unfilteredTools, newTools)

        send({
          type: 'context.preview',
          payload: {
            oldPrompt,
            newPrompt,
            oldHash: oldCached?.hash,
            newHash,
            diff,
            ...(toolDiff.length > 0 ? { toolDiff } : {}),
          },
          id: message.id,
        })
      } catch (error) {
        logger.error('Failed to preview dynamic context', {
          error: error instanceof Error ? error.message : 'Unknown error',
          sessionId,
        })
        const reason = error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR)
        send(
          createErrorMessage(
            'ERROR',
            serverT({ en: 'Failed to preview: {{reason}}', fr: 'Échec de l’aperçu : {{reason}}' }, { reason }),
            message.id,
          ),
        )
      }

      break
    }

    case 'context.applyDynamic': {
      const payload = message.payload as { sessionId?: string } | undefined
      const sessionId = payload?.sessionId ?? client.activeSessionId
      if (!sessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const session = sessionManager.requireSession(sessionId)

      if (session.isRunning) {
        send(
          createErrorMessage(
            'SESSION_RUNNING',
            serverT({
              en: 'Cannot apply dynamic context while session is running',
              fr: 'Impossible d’appliquer le contexte dynamique pendant que la session est en cours',
            }),
            message.id,
          ),
        )
        return
      }

      ;(async () => {
        try {
          const modelName = session.providerModel ?? _providerManager?.getCurrentModel()
          await applyDynamicContext(sessionManager, sessionId, modelName)

          const newContextState = sessionManager.getContextState(sessionId)
          sendForSession(sessionId, createContextStateMessage(newContextState))
          send({ type: 'ack', payload: {}, id: message.id })
        } catch (error) {
          logger.error('Failed to apply dynamic context', { error, sessionId })
          const reason = error instanceof Error ? error.message : serverT(MSG_UNKNOWN_ERROR)
          sendForSession(
            sessionId,
            createChatErrorMessage(
              serverT(
                {
                  en: 'Failed to apply dynamic context: {{reason}}',
                  fr: 'Échec d’application du contexte dynamique : {{reason}}',
                },
                { reason },
              ),
              true,
            ),
          )
          send({ type: 'ack', payload: {}, id: message.id })
        }
      })()

      break
    }

    // =========================================================================
    // Runner (Auto-Loop)
    // =========================================================================

    case 'runner.launch': {
      const launchPayloadEarly = message.payload as
        { workflowId?: string; resumeFrom?: string; sessionId?: string } | undefined
      const sessionId = launchPayloadEarly?.sessionId ?? client.activeSessionId
      if (!sessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const session = sessionManager.requireSession(sessionId)

      if (session.isRunning) {
        sendForSession(
          sessionId,
          createErrorMessage(
            'SESSION_RUNNING',
            serverT({
              en: 'Cannot launch a workflow while a turn is running',
              fr: 'Impossible de lancer un workflow pendant un tour en cours',
            }),
            message.id,
          ),
        )
        return
      }

      // Skip criteria check when resuming from a user step
      if (!launchPayloadEarly?.resumeFrom) {
        const pendingCriteria = session.criteria.filter((c) => c.status.type !== 'passed')
        if (!launchPayloadEarly?.workflowId && pendingCriteria.length === 0) {
          send(
            createErrorMessage(
              'NO_WORK',
              serverT({ en: 'No pending criteria to work on', fr: 'Aucun critère en attente sur lequel travailler' }),
              message.id,
            ),
          )
          return
        }
      }

      const launchPayload = message.payload as
        | {
            content?: string
            attachments?: unknown[]
            workflowId?: string
            scope?: string
            subGroup?: string
            resumeFrom?: string
            stepOutput?: Record<string, string>
            params?: Record<string, string>
            userChoice?: string
          }
        | undefined
      const workerPayload = {
        ...(launchPayload?.content ? { content: launchPayload.content } : {}),
        ...(launchPayload?.attachments ? { attachments: launchPayload.attachments as Attachment[] } : {}),
        ...(launchPayload?.workflowId ? { workflowId: launchPayload.workflowId } : {}),
        ...(launchPayload?.scope
          ? { scope: launchPayload.scope as import('../../shared/types.js').WorkflowLaunchScope }
          : {}),
        ...(launchPayload?.subGroup ? { subGroup: launchPayload.subGroup } : {}),
        ...(launchPayload?.resumeFrom ? { resumeFrom: launchPayload.resumeFrom } : {}),
        ...(launchPayload?.stepOutput ? { stepOutput: launchPayload.stepOutput } : {}),
        ...(launchPayload?.params ? { params: launchPayload.params } : {}),
        ...(launchPayload?.userChoice ? { userChoice: launchPayload.userChoice } : {}),
      }
      if (runInWorkerIfEnabled(sessionId, 'workflow', { kind: 'workflow', payload: workerPayload })) return

      // Acquire before any side effect so a concurrent chat/compact/stop cannot race.
      const workflowHandle = acquireRuntime(sessionId, 'workflow', message.id, send)
      if (!workflowHandle) return

      // Check if session is blocked - user intervention resets it
      if (session.phase === 'blocked') {
        logger.info('User launched runner - resetting blocked state', { sessionId })
        // setPhase emits phase.changed event
        sessionManager.setPhase(sessionId, 'build')
      }

      // Parse launch payload
      const launchAttachments = launchPayload?.attachments as Attachment[] | undefined
      const hasUserContent =
        launchPayload?.content && typeof launchPayload.content === 'string' && launchPayload.content.trim()
      const hasUserAttachments = launchAttachments && launchAttachments.length > 0
      const hasUserMessage = hasUserContent || hasUserAttachments
      const isResume = !!launchPayload?.resumeFrom

      // Acknowledge immediately
      send({ type: 'ack', payload: {}, id: message.id })

      // Ensure client is subscribed to EventStore (tab model - additive)
      ensureEventStoreSubscription(sessionId)

      // Run orchestrator asynchronously
      logger.info('Runner launching', { sessionId, isResume })

      // Generate session name if this is the first interaction (fire-and-forget)
      if (!isResume && launchPayload?.workflowId && _providerManager) {
        const session = sessionManager.getSession(sessionId)
        const messageCount = getSessionMessageCount(sessionId)
        if (session && needsNameGeneration(session.metadata?.title, messageCount)) {
          const nameHint =
            launchPayload.workflowId +
            (launchPayload?.params && Object.keys(launchPayload.params).length > 0
              ? ': ' +
                Object.entries(launchPayload.params)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')
              : '')
          generateSessionNameForSession(
            sessionId,
            nameHint,
            {
              sessionManager,
              providerManager: _providerManager,
              broadcastForSession: _broadcastForSession,
              eventStore: getEventStore(),
            },
            workflowHandle.signal,
          )
        }
      }

      launchWorkflowRun(
        {
          sessionManager,
          sessionId,
          runtimeHandle: workflowHandle,
          llmClient: llmForSession(sessionId),
          getSessionLLMClient: () => llmForSession(sessionId),
          statsIdentity: statsForSession(sessionId),
          broadcastForSession: (sid, msg) => _broadcastForSession(sid, msg),
          onFinished: () => cleanupAfterTurn(sessionId, workflowHandle, sendForSession),
        },
        {
          ...(launchPayload?.workflowId ? { workflowId: launchPayload.workflowId } : {}),
          ...(launchPayload?.subGroup ? { subGroup: launchPayload.subGroup } : {}),
          ...(launchPayload?.scope
            ? { scope: launchPayload.scope as import('../../shared/types.js').WorkflowLaunchScope }
            : {}),
          ...(isResume && launchPayload?.resumeFrom ? { resumeFrom: launchPayload.resumeFrom } : {}),
          ...(isResume && launchPayload?.stepOutput ? { stepOutput: launchPayload.stepOutput } : {}),
          ...(isResume && launchPayload?.userChoice ? { userChoice: launchPayload.userChoice } : {}),
          ...(launchPayload?.params ? { params: launchPayload.params } : {}),
          ...(hasUserMessage
            ? {
                content: hasUserContent ? launchPayload!.content! : '',
                ...(hasUserAttachments ? { attachments: launchAttachments! } : {}),
              }
            : {}),
        },
      )

      break
    }

    // =========================================================================
    // Path Confirmation
    // =========================================================================

    case 'path.confirm': {
      send(
        createErrorMessage(
          'DEPRECATED',
          'path.confirm removed. Use REST API: POST /api/sessions/:id/confirm-path',
          message.id,
        ),
      )
      break
    }

    // =========================================================================
    // Ask User
    // =========================================================================

    case 'ask.answer': {
      if (!client.activeSessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      if (!isAskAnswerPayload(message.payload)) {
        send(
          createErrorMessage(
            'INVALID_PAYLOAD',
            serverT({ en: 'Invalid ask.answer payload', fr: 'Payload ask.answer invalide' }),
            message.id,
          ),
        )
        return
      }

      const { callId, answer, skip } = message.payload as { callId: string; answer: string; skip?: boolean }
      const answerSessionId = client.activeSessionId
      if (!sessionManager.getSession(answerSessionId)) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }
      if (!getPendingQuestionsForSession(answerSessionId).some((q) => q.callId === callId)) {
        send(
          createErrorMessage(
            'NOT_FOUND',
            serverT({ en: 'No pending question with that ID', fr: 'Aucune question en attente avec cet ID' }),
            message.id,
          ),
        )
        return
      }

      const workerController = getWorkerController?.()
      const found = workerController?.isEnabled()
        ? (workerController.answerQuestion?.(callId, answer, skip ?? false) ?? false)
        : provideAnswer(callId, answer, skip)

      if (!found) {
        send(
          createErrorMessage(
            'NOT_FOUND',
            serverT({ en: 'No pending question with that ID', fr: 'Aucune question en attente avec cet ID' }),
            message.id,
          ),
        )
        return
      }

      getSessionRuntimeRegistry().peek(answerSessionId)?.recordCommand('answer')

      logger.debug('Ask user answer received', {
        sessionId: client.activeSessionId,
        callId,
        answerLength: answer.length,
      })

      // Just acknowledge - the Promise resolution will resume tool execution automatically.
      send({ type: 'ack', payload: {}, id: message.id })
      break
    }

    // =========================================================================
    // Workflow
    // =========================================================================

    case 'workflow.exit': {
      const payload = message.payload as { sessionId?: string } | undefined
      const exitSessionId = payload?.sessionId ?? client.activeSessionId
      if (!exitSessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const exitSession = sessionManager.getSession(exitSessionId)
      if (!exitSession) {
        send(createErrorMessage('NOT_FOUND', serverT(MSG_SESSION_NOT_FOUND), message.id))
        return
      }

      // Cancel the active workflow execution regardless of state
      const activeExec = sessionManager.getActiveWorkflowExecution(exitSessionId)
      if (activeExec) {
        sessionManager.cancelWorkflow(
          exitSessionId,
          activeExec.id,
          activeExec.workflowId,
          activeExec.workflowName,
          activeExec.workflowColor,
        )
      } else {
        // Fallback: just change phase
        sessionManager.setPhase(exitSessionId, 'build')
      }

      // Abort any running agent turn
      getSessionRuntimeRegistry().get(exitSessionId).stop()

      // Ensure running state is cleared
      if (exitSession.isRunning) {
        sessionManager.setRunning(exitSessionId, false)
      }

      send({ type: 'ack', payload: {}, id: message.id })
      break
    }

    // =========================================================================
    // LLM Retry
    // =========================================================================

    case 'chat.llm_retry_now': {
      const payload = message.payload as import('../../shared/protocol.js').ChatLLMRetryNowPayload | undefined
      const retrySessionId = payload?.sessionId ?? client.activeSessionId
      if (!retrySessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }
      // Interrupt the in-flight backoff wait — the stream's next attempt starts immediately
      const interrupted = interruptLLMRetryWait(retrySessionId)
      send({ type: 'ack', payload: { interrupted }, id: message.id })
      break
    }

    case 'chat.retry': {
      const payload = message.payload as import('../../shared/protocol.js').ChatRetryPayload | undefined
      const retrySessionId = payload?.sessionId ?? client.activeSessionId
      if (!retrySessionId) {
        send(createErrorMessage('NO_SESSION', serverT(MSG_NO_ACTIVE_SESSION), message.id))
        return
      }

      const retrySession = sessionManager.getSession(retrySessionId)
      if (!retrySession) {
        send(createErrorMessage('NOT_FOUND', serverT(MSG_SESSION_NOT_FOUND), message.id))
        return
      }
      if (retrySession.isRunning) {
        send(createErrorMessage('SESSION_RUNNING', serverT(MSG_SESSION_IS_RUNNING), message.id))
        return
      }
      // Only allow a retry when the last turn actually failed (definitive LLM
      // failure recorded within the retry window) — never an unsolicited turn.
      if (!hasRecentLLMFailure(retrySessionId, 30 * 60_000)) {
        send(
          createErrorMessage(
            'NO_FAILED_TURN',
            serverT({ en: 'No failed turn to retry', fr: 'Aucun tour échoué à relancer' }),
            message.id,
          ),
        )
        return
      }
      // The workflow resume path owns retries for blocked/running workflow
      // executions — a plain turn would fight the workflow state machine
      const latestExec = sessionManager.getLatestWorkflowExecution(retrySessionId)
      if (
        latestExec &&
        (latestExec.status === 'blocked' || latestExec.status === 'running' || latestExec.status === 'waiting')
      ) {
        send(
          createErrorMessage(
            'WORKFLOW_ACTIVE',
            serverT({ en: 'A workflow run is active', fr: 'Un run de workflow est actif' }),
            message.id,
          ),
        )
        return
      }

      if (runInWorkerIfEnabled(retrySessionId, 'chat', { kind: 'retry' })) return

      const retryHandle = acquireRuntime(retrySessionId, 'chat', message.id, send)
      if (!retryHandle) return

      // User intervention resets a blocked phase
      if (retrySession.phase === 'blocked') {
        sessionManager.setPhase(retrySessionId, 'build')
      }

      // Re-run the last turn WITHOUT re-adding the user message — the context is
      // already in history, untouched by the failed attempt.
      send({ type: 'ack', payload: {}, id: message.id })
      _startTurnWithCompletionChain(retrySessionId, retryHandle)
      break
    }

    default: {
      send(
        createErrorMessage(
          'UNKNOWN_MESSAGE',
          serverT(
            { en: 'Unknown message type: {{type}}', fr: 'Type de message inconnu : {{type}}' },
            { type: message.type },
          ),
          message.id,
        ),
      )
    }
  }
}
