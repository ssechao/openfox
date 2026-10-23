import type { LLMClientWithModel } from '../llm/client.js'
import type { ProviderManager } from '../provider-manager.js'
import type { SessionManager } from '../session/manager.js'
import { isSessionAlreadyRunningError, type ExecutionHandle, type SessionRuntimeRegistry } from '../session/index.js'
import { logger } from '../utils/logger.js'
import type { ServerMessage } from '../../shared/protocol.js'
import { createSessionRunningMessage, createChatMessageMessage } from '../ws/protocol.js'
import { finalizeTurnCompletion, buildRunChatTurnParams } from '../utils/session-utils.js'
import { generateSessionNameForSession } from '../session/name-generator.js'
import { getEventStore } from '../events/index.js'

interface QueueProcessorDeps {
  sessionManager: SessionManager
  providerManager: ProviderManager
  runtimeRegistry: SessionRuntimeRegistry
  getLLMClient: () => LLMClientWithModel
  getLLMClientForProvider?: (
    providerId: string,
    model: string,
    reasoningEffort?: string,
  ) => LLMClientWithModel | undefined
  getActiveProvider: (() => import('../../shared/types.js').Provider | undefined) | undefined
  broadcastForSession: (sessionId: string, msg: ServerMessage) => void
}

export class QueueProcessor {
  private deps: QueueProcessorDeps
  private unsubscribe: (() => void) | null = null

  constructor(deps: QueueProcessorDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.unsubscribe) {
      logger.warn('QueueProcessor already started')
      return
    }

    this.unsubscribe = this.deps.sessionManager.subscribe((event) => {
      if (event.type === 'queue_added') {
        this.handleQueueAdded(event.sessionId)
      } else if (event.type === 'running_changed' && !event.isRunning) {
        this.handleTurnDone(event.sessionId)
      }
    })

    logger.debug('QueueProcessor started')
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }

    this.deps.runtimeRegistry.abortAll()

    logger.debug('QueueProcessor stopped')
  }

  abortSession(sessionId: string): boolean {
    this.deps.sessionManager.clearPauseState(sessionId)
    return this.deps.runtimeRegistry.get(sessionId).stop()
  }

  private handleQueueAdded(sessionId: string): void {
    const { sessionManager } = this.deps
    const session = sessionManager.getSession(sessionId)
    if (!session) return

    if (session.isRunning) {
      logger.debug('Session is running, not starting new turn', { sessionId })
      return
    }

    if (!sessionManager.hasQueuedMessages(sessionId)) {
      logger.debug('No queued messages', { sessionId })
      return
    }

    this.startTurn(sessionId)
  }

  private handleTurnDone(sessionId: string): void {
    logger.debug('Turn done, checking for more queued messages', { sessionId })

    const { sessionManager } = this.deps

    if (!sessionManager.hasQueuedMessages(sessionId)) {
      logger.debug('No more queued messages', { sessionId })
      return
    }

    this.startTurn(sessionId)
  }

  private startTurn(sessionId: string): void {
    const { sessionManager, broadcastForSession } = this.deps
    logger.info('Starting turn from queue processor', { sessionId })

    const session = sessionManager.getSession(sessionId)
    if (!session || session.isRunning) {
      logger.warn('Cannot start turn: session not found or already running', { sessionId })
      return
    }

    const queue = sessionManager.getQueueState(sessionId)
    if (queue.length === 0) {
      logger.warn('Cannot start turn: queue is empty', { sessionId })
      return
    }

    // A new queued turn (user message, slash command, auto-prompt, or
    // completion) on a session with a blocked workflow execution abandons that
    // workflow: the step can no longer be retried, so clear it (execution +
    // phase) instead of leaving the stale "Retry step" affordance pinned while
    // the turn runs.
    const runtime = this.deps.runtimeRegistry.get(sessionId)
    let handle: ExecutionHandle
    try {
      handle = runtime.acquire('chat')
    } catch (error) {
      if (isSessionAlreadyRunningError(error)) {
        logger.warn('Cannot start turn: session already owned', { sessionId, error: error.message })
        return
      }
      throw error
    }

    try {
      const latestExec = sessionManager.getLatestWorkflowExecution(sessionId)
      if (latestExec && latestExec.status === 'blocked') {
        logger.info('Cancelling blocked workflow execution before chat turn', {
          sessionId,
          executionId: latestExec.id,
          step: latestExec.currentStepId,
        })
        sessionManager.cancelWorkflow(
          sessionId,
          latestExec.id,
          latestExec.workflowId,
          latestExec.workflowName,
          latestExec.workflowColor,
        )
      }

      sessionManager.setRunning(sessionId, true)
      broadcastForSession(sessionId, createSessionRunningMessage(true))

      const nextAsap = queue.find((m) => m.mode === 'asap') ?? queue[0]
      if (nextAsap) {
        sessionManager.cancelQueuedMessage(sessionId, nextAsap.queueId)
        const userMessage = sessionManager.addMessage(sessionId, {
          role: 'user',
          content: nextAsap.content,
          ...(nextAsap.attachments ? { attachments: nextAsap.attachments } : {}),
        })
        broadcastForSession(sessionId, createChatMessageMessage(userMessage))
        logger.debug('Added queued message to session', {
          sessionId,
          queueId: nextAsap.queueId,
          messageId: userMessage.id,
        })

        generateSessionNameForSession(
          sessionId,
          nextAsap.content,
          {
            sessionManager,
            providerManager: this.deps.providerManager,
            broadcastForSession,
            eventStore: getEventStore(),
            getLLMClient: this.deps.getLLMClient,
            ...(this.deps.getLLMClientForProvider
              ? { getLLMClientForProvider: this.deps.getLLMClientForProvider }
              : {}),
          },
          handle.signal,
        )
      }
    } catch (error) {
      logger.error('QueueProcessor turn start failed, releasing runtime', { sessionId, error })
      runtime.release(handle)
      try {
        sessionManager.setRunning(sessionId, false)
        broadcastForSession(sessionId, createSessionRunningMessage(false))
      } catch {
        // Session may have been deleted during the failed start
      }
      return
    }

    this.runTurn(sessionId, handle)
  }

  private async runTurn(sessionId: string, handle: ExecutionHandle): Promise<void> {
    const { sessionManager, getLLMClient, getActiveProvider, broadcastForSession, providerManager } = this.deps

    let runChatTurn: (typeof import('../chat/orchestrator.js'))['runChatTurn']
    let runChatTurnParams: ReturnType<typeof buildRunChatTurnParams>
    try {
      // Activate the session's EFFECTIVE provider/model (agent override > session
      // preference > default), not the raw stored preference — otherwise the
      // runtime client would be wrong on an override agent, or a stale override
      // would linger after switching back to a non-override agent.
      const effective = sessionManager.resolveEffectiveProviderModel(sessionId)
      if (effective.providerId && effective.model) {
        const currentActiveProviderId = providerManager.getActiveProviderId()
        const currentModel = providerManager.getCurrentModel()

        if (currentActiveProviderId !== effective.providerId || currentModel !== effective.model) {
          logger.info('Switching to session effective provider', {
            sessionId,
            fromProvider: currentActiveProviderId,
            fromModel: currentModel,
            toProvider: effective.providerId,
            toModel: effective.model,
          })
          const result = await providerManager.activateProvider(effective.providerId, { model: effective.model })
          if (!result.success) {
            logger.error('Failed to activate session provider', { sessionId, error: result.error })
          }
        }
      }

      const llmClient = getLLMClient()
      const provider = getActiveProvider?.()

      // Re-resolve the session's LLM client for each retry attempt so a provider
      // switch made mid-turn (e.g. during backoff) takes effect on the next attempt.
      // The session/agent reasoning effort is passed through so the request and
      // the stats identity carry it.
      const getSessionLLMClient = (): LLMClientWithModel => {
        const current = sessionManager.resolveEffectiveProviderModel(sessionId)
        if (current.providerId && current.model && this.deps.getLLMClientForProvider) {
          const resolvedModel = providerManager.resolveModel?.(current.providerId, current.model)
          const effectiveModel = resolvedModel ?? current.model
          const client = this.deps.getLLMClientForProvider(current.providerId, effectiveModel, current.reasoningEffort)
          if (client) return client
        }
        return llmClient
      }

      // Run the turn on the session-aware client (not the global one) so the
      // reasoning effort actually sent is the session's, and matches the stats.
      const sessionClient = getSessionLLMClient()
      const sessionEffort = sessionClient.getReasoningEffort?.()

      const statsIdentity = {
        providerId: provider?.id ?? `provider:${sessionClient.getModel()}`,
        providerName: provider?.name ?? 'Unknown Provider',
        backend: provider?.backend ?? sessionClient.getBackend(),
        model: sessionClient.getModel(),
        ...(sessionEffort ? { reasoningEffort: sessionEffort } : {}),
      }

      const orchestrator = await import('../chat/orchestrator.js')
      runChatTurn = orchestrator.runChatTurn

      runChatTurnParams = buildRunChatTurnParams({
        sessionManager,
        sessionId,
        llmClient: sessionClient,
        getSessionLLMClient,
        statsIdentity,
        signal: handle.signal,
        onMessage: (msg) => broadcastForSession(sessionId, msg),
      })
    } catch (error) {
      logger.error('QueueProcessor turn setup failed, releasing runtime', { sessionId, error })
      const runtime = this.deps.runtimeRegistry.peek(sessionId)
      if (runtime?.release(handle)) {
        try {
          finalizeTurnCompletion(sessionId, sessionManager, broadcastForSession)
        } catch {
          // Session may have been deleted during the failed setup
        }
      }
      return
    }

    runChatTurn(runChatTurnParams)
      .catch((error) => {
        if (error instanceof Error && error.message === 'Aborted') {
          return
        }
        logger.error('QueueProcessor turn error', { sessionId, error })
      })
      .finally(() => {
        const runtime = this.deps.runtimeRegistry.peek(sessionId)
        const stopped = runtime?.wasStopped(handle) ?? false
        const released = runtime?.release(handle) ?? false
        if (!released) return

        try {
          const session = sessionManager.getSession(sessionId)
          if (!session) {
            // Session was deleted — nothing more to clean up
            return
          }

          if (stopped) {
            finalizeTurnCompletion(sessionId, sessionManager, broadcastForSession)
            return
          }

          const hasMore = sessionManager.hasQueuedMessages(sessionId)
          if (!hasMore) {
            finalizeTurnCompletion(sessionId, sessionManager, broadcastForSession)
            return
          }

          // Safety: orchestrator only appends running.changed to event store;
          // ensure running state is reset before starting next turn
          const currentSession = sessionManager.getSession(sessionId)
          if (currentSession?.isRunning) {
            sessionManager.setRunning(sessionId, false)
          }
          this.startTurn(sessionId)
        } catch (error) {
          logger.error('Error in turn completion cleanup', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
  }
}
