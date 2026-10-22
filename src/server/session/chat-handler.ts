import type { LLMClientWithModel } from '../llm/client.js'
import type { StatsIdentity, Attachment } from '../../shared/types.js'
import type { ServerMessage } from '../../shared/protocol.js'
import type { SessionManager } from './index.js'
import type { ProviderManager } from '../provider-manager.js'
import { getSessionRuntimeRegistry, type ExecutionHandle } from './index.js'
import { getEventStore } from '../events/index.js'
import { runChatTurn } from '../chat/orchestrator.js'
import { buildRunChatTurnParams } from '../utils/session-utils.js'
import { generateSessionNameForSession } from './name-generator.js'

import { createChatMessageMessage, createSessionRunningMessage, createPhaseChangedMessage } from '../ws/protocol.js'
import { finalizeTurnCompletion } from '../utils/session-utils.js'

export interface ChatHandlerDeps {
  sessionManager: SessionManager
  providerManager: ProviderManager
  llmClient: LLMClientWithModel
  statsIdentity: StatsIdentity
  broadcastForSession: (sessionId: string, msg: ServerMessage) => void
}

export async function startChatSession(
  sessionId: string,
  content: string,
  deps: ChatHandlerDeps,
  options?: {
    attachments?: Attachment[]
    messageKind?: 'correction' | 'auto-prompt' | 'context-reset' | 'task-completed' | 'workflow-started' | 'command'
    isSystemGenerated?: boolean
  },
): Promise<void> {
  const { sessionManager, broadcastForSession } = deps

  const session = sessionManager.getSession(sessionId)
  if (!session) {
    throw new Error('Session not found')
  }

  const eventStore = getEventStore()

  // Check if session is already running
  if (session.isRunning) {
    throw new Error('Session is already running')
  }

  // Check if session is blocked - user intervention resets it
  if (session.phase === 'blocked') {
    sessionManager.setPhase(sessionId, 'build')
    broadcastForSession(sessionId, createPhaseChangedMessage('build'))
  }

  // Acquire a runtime handle for this chat turn.
  const runtime = getSessionRuntimeRegistry().get(sessionId)
  const handle = runtime.acquire('chat')

  // Mark session as running
  sessionManager.setRunning(sessionId, true)
  broadcastForSession(sessionId, createSessionRunningMessage(true))

  try {
    // Add user message
    const userMessage = sessionManager.addMessage(sessionId, {
      role: 'user',
      content,
      ...(options?.attachments && { attachments: options.attachments }),
      ...(options?.messageKind && { messageKind: options.messageKind }),
      ...(options?.isSystemGenerated && { isSystemGenerated: options.isSystemGenerated }),
    })

    broadcastForSession(sessionId, createChatMessageMessage(userMessage))

    // Generate session name if needed (fire-and-forget)
    generateSessionNameForSession(
      sessionId,
      content,
      {
        sessionManager,
        providerManager: deps.providerManager,
        broadcastForSession,
        eventStore,
      },
      handle.signal,
    )

    // Start the chat turn
    startTurnWithCompletionChain(sessionId, handle, deps)
  } catch (error) {
    runtime.release(handle)
    try {
      sessionManager.setRunning(sessionId, false)
      broadcastForSession(sessionId, createSessionRunningMessage(false))
    } catch {
      // Session may have been deleted or invalidated
    }
    finalizeTurnCompletion(sessionId, sessionManager, broadcastForSession)
    throw error
  }
}

function startTurnWithCompletionChain(sessionId: string, handle: ExecutionHandle, deps: ChatHandlerDeps): void {
  const { sessionManager, llmClient, statsIdentity, broadcastForSession } = deps
  const runtime = getSessionRuntimeRegistry().peek(sessionId)

  runChatTurn(
    buildRunChatTurnParams({
      sessionManager,
      sessionId,
      llmClient,
      statsIdentity,
      signal: handle.signal,
      onMessage: (msg) => broadcastForSession(sessionId, msg),
    }),
  )
    .catch((error) => {
      if (error instanceof Error && error.message === 'Aborted') {
        return
      }
    })
    .finally(() => {
      const stopped = runtime?.wasStopped(handle) ?? false
      if (!runtime?.release(handle)) {
        return
      }

      if (stopped) {
        sessionManager.clearMessageQueue(sessionId)
        finalizeTurnCompletion(sessionId, sessionManager, broadcastForSession)
        return
      }

      const completionMsgs = sessionManager.drainCompletionMessages(sessionId)
      const next = completionMsgs[0]
      if (next) {
        for (const remaining of completionMsgs.slice(1)) {
          sessionManager.queueMessage(sessionId, 'completion', remaining.content, remaining.attachments)
        }

        const userMessage = sessionManager.addMessage(sessionId, {
          role: 'user',
          content: next.content,
          ...(next.attachments ? { attachments: next.attachments } : {}),
        })
        broadcastForSession(sessionId, createChatMessageMessage(userMessage))

        const nextHandle = getSessionRuntimeRegistry().get(sessionId).acquire('chat')
        startTurnWithCompletionChain(sessionId, nextHandle, deps)
        return
      }

      sessionManager.clearMessageQueue(sessionId)
      finalizeTurnCompletion(sessionId, sessionManager, broadcastForSession)
    })
}

export function stopSessionExecution(sessionId: string, sessionManager: SessionManager): void {
  getSessionRuntimeRegistry().get(sessionId).stop()

  // Release a paused gate immediately (setRunning(false) also clears it, but
  // this gives the UI instant feedback on Stop).
  sessionManager.clearPauseState(sessionId)
  sessionManager.setRunning(sessionId, false)
}
