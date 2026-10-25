/**
 * Shared workflow-run launcher.
 *
 * Single code path for starting a workflow-orchestrator run in a session,
 * used by the WebSocket `runner.launch` handler and by the project-tasks
 * service when a slash-workflow task is seeded. Owns the running-state
 * lifecycle and error surfacing. The caller must acquire a `workflow`
 * ExecutionHandle from `SessionRuntimeRegistry` and pass it in; abort/stop
 * is handled by the shared runtime, not by a local controller registry.
 */

import type { Attachment, StatsIdentity, WorkflowExecution, WorkflowLaunchScope } from '../../shared/types.js'
import type { ServerMessage } from '../../shared/protocol.js'
import { createServerMessage } from '../../shared/protocol.js'
import type { LLMClientWithModel } from '../llm/client.js'
import type { SessionManager } from '../session/index.js'
import { getSessionRuntimeRegistry, type ExecutionHandle } from '../session/index.js'
import { runOrchestrator } from './index.js'
import { normalizeWorkflowScope } from '../workflows/registry.js'
import { logger } from '../utils/logger.js'
import { createSessionRunningMessage } from '../ws/protocol.js'

export interface WorkflowLaunchPayload {
  workflowId?: string
  params?: Record<string, string>
  subGroup?: string
  scope?: WorkflowLaunchScope
  /** Resume from a paused user step. */
  resumeFrom?: string
  /** Step output supplied when resuming. */
  stepOutput?: Record<string, string>
  /** Branch chosen by the user at a paused user step. */
  userChoice?: string
  content?: string
  attachments?: Attachment[]
}

/**
 * Outcome of the post-run turn cleanup:
 * - `restarted`: a queued message started a successor turn — the successor
 *   owns the session's running state from now on.
 * - `settled`: no successor — the caller finalizes (isRunning=false).
 * - `stale`: the handle was no longer current — nothing may be touched.
 */
export type TurnCleanupOutcome = 'restarted' | 'settled' | 'stale'

export interface LaunchWorkflowRunDeps {
  sessionManager: SessionManager
  sessionId: string
  runtimeHandle: ExecutionHandle
  llmClient: LLMClientWithModel
  /** Re-resolve the session's LLM client per retry attempt (provider switch mid-run). */
  getSessionLLMClient?: () => LLMClientWithModel
  statsIdentity: StatsIdentity
  broadcastForSession: (sessionId: string, msg: ServerMessage) => void
  /** Turn-bookkeeping cleanup after the run settles (queue drain, restart, …). */
  onFinished?: () => TurnCleanupOutcome
}

export function launchWorkflowRun(deps: LaunchWorkflowRunDeps, payload: WorkflowLaunchPayload): Promise<void> {
  const {
    sessionManager,
    sessionId,
    runtimeHandle,
    llmClient,
    getSessionLLMClient,
    statsIdentity,
    broadcastForSession,
    onFinished,
  } = deps
  const signal = runtimeHandle.signal

  // Mark session as running (emits running.changed event)
  sessionManager.setRunning(sessionId, true)
  broadcastForSession(sessionId, createSessionRunningMessage(true))

  const launchAttachments = payload.attachments
  const hasUserContent = payload.content && payload.content.trim().length > 0
  const hasUserAttachments = launchAttachments && launchAttachments.length > 0
  let reactivatedExecution: WorkflowExecution | undefined

  return runOrchestrator({
    sessionManager,
    sessionId,
    llmClient,
    ...(getSessionLLMClient ? { getSessionLLMClient } : {}),
    statsIdentity,
    scope: normalizeWorkflowScope(payload.scope),
    ...(payload.workflowId ? { workflowId: payload.workflowId } : {}),
    ...(payload.subGroup ? { subGroup: payload.subGroup } : {}),
    ...(payload.params ? { params: payload.params } : {}),
    ...(payload.resumeFrom ? { resumeFromStep: payload.resumeFrom } : {}),
    ...(payload.stepOutput ? { initialStepOutput: payload.stepOutput } : {}),
    ...(payload.userChoice ? { userChoice: payload.userChoice } : {}),
    ...(payload.resumeFrom
      ? (() => {
          const exec = sessionManager.getLatestWorkflowExecution(sessionId)
          if (!exec) return {}
          const resumeFromStep = payload.resumeFrom ?? exec.currentStepId

          if (exec.status === 'waiting' || exec.status === 'blocked') {
            // Re-activate a paused (waiting) or failed-and-blocked execution so
            // the resumed/retried run stays tracked: status flips back to
            // 'running' (same execution id) and params/step output are restored.
            const resumed = sessionManager.resumeWorkflow(
              sessionId,
              exec.id,
              exec.workflowId,
              exec.workflowName,
              exec.workflowColor,
            )
            if (resumed) {
              reactivatedExecution = exec
              return {
                params: resumed.params,
                initialStepOutput: resumed.stepOutput,
                ...(resumeFromStep ? { resumeFromStep } : {}),
                ...(exec.subGroup ? { subGroup: exec.subGroup } : {}),
              }
            }
          }

          if (exec.status === 'running') {
            return {
              ...(Object.keys(exec.params).length > 0 ? { params: exec.params } : {}),
              ...(Object.keys(exec.stepOutput).length > 0 ? { initialStepOutput: exec.stepOutput } : {}),
              ...(resumeFromStep ? { resumeFromStep } : {}),
              ...(exec.subGroup ? { subGroup: exec.subGroup } : {}),
            }
          }

          if (
            (exec.status === 'completed' || exec.status === 'cancelled') &&
            (!payload.workflowId || payload.workflowId === exec.workflowId)
          ) {
            return {
              params: { ...exec.params, ...payload.params },
              initialStepOutput: payload.stepOutput ?? exec.stepOutput,
              ...(resumeFromStep ? { resumeFromStep } : {}),
              ...(exec.subGroup ? { subGroup: exec.subGroup } : {}),
            }
          }

          return {}
        })()
      : {}),
    ...(hasUserContent || hasUserAttachments
      ? {
          userMessage: {
            content: payload.content ?? '',
            ...(hasUserAttachments ? { attachments: launchAttachments! } : {}),
          },
        }
      : {}),
    signal,
    onMessage: (msg) => broadcastForSession(sessionId, msg), // For path confirmation dialogs
  })
    .catch((error: unknown) => {
      // Don't create error message for controlled abort
      if (error instanceof Error && error.message === 'Aborted') {
        return
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (reactivatedExecution) {
        const latest = sessionManager.getLatestWorkflowExecution(sessionId)
        if (latest?.id === reactivatedExecution.id && latest.status === 'running') {
          sessionManager.blockWorkflow(
            sessionId,
            reactivatedExecution.id,
            reactivatedExecution.workflowId,
            reactivatedExecution.workflowName,
            reactivatedExecution.workflowColor,
          )
        }
      }
      logger.error('Runner error', { error: errorMessage, sessionId })
      // Surface validation errors to the user (e.g. missing required params)
      broadcastForSession(sessionId, createServerMessage('chat.error', { error: errorMessage, recoverable: false }))
    })
    .finally(() => {
      const runtime = getSessionRuntimeRegistry().peek(sessionId)
      if (!runtime) return
      if (onFinished) {
        let outcome: TurnCleanupOutcome
        try {
          outcome = onFinished()
        } catch {
          // Session may have been deleted during execution. If our handle is
          // still current, no successor was started: we still own finalization.
          outcome = runtime.isCurrent(runtimeHandle) ? 'settled' : 'stale'
        }
        runtime.release(runtimeHandle)
        // A successor turn started during cleanup owns the running state now —
        // never write isRunning=false after it, and never touch a stale handle.
        if (outcome !== 'settled') return
        try {
          // The orchestrator bypasses runChatTurn, so isRunning must be cleared here
          sessionManager.setRunning(sessionId, false)
          broadcastForSession(sessionId, createSessionRunningMessage(false))
        } catch {
          // Session may have been deleted during execution
        }
        return
      }
      if (!runtime.release(runtimeHandle)) return
      try {
        // The orchestrator bypasses runChatTurn, so isRunning must be cleared here
        sessionManager.setRunning(sessionId, false)
        broadcastForSession(sessionId, createSessionRunningMessage(false))
      } catch {
        // Session may have been deleted during execution
      }
    })
    .then(() => undefined)
}
