/**
 * Worker-crash recovery (étape 6a).
 *
 * When the gateway detects a worker's death it marks the session interrupted
 * (`sessions.interrupted_at`, persisted, API-visible) and finalizes any
 * partial assistant message — the UI shows « interrompue — reprendre ».
 *
 * Nothing is replayed automatically: the interrupted turn's last tool call
 * may have unknown external effects, so the continuation turn only ever runs
 * on an explicit resume (`POST /api/sessions/:id/resume-interruption`), and
 * it uses the same "stream interrupted" reminder as the LLM-drop recovery —
 * the model is told the previous turn was cut off, never asked to blindly
 * redo a tool call.
 */

import type Database from 'better-sqlite3'
import type { EventStore } from '../../events/store.js'
import type { PendingToolReconciliation, SessionSnapshot, StoredEvent, TurnEvent } from '../../events/types.js'
import { planBootContinuation, type BootContinuationPlan } from '../auto-continue.js'

export function markSessionInterrupted(db: Database.Database, sessionId: string, interruptedAt: string): void {
  db.prepare(
    `UPDATE sessions SET is_running = 0, interrupted_at = ?, worker_id = NULL, updated_at = ? WHERE id = ?`,
  ).run(interruptedAt, interruptedAt, sessionId)
}

export function markWorkerSessionInterrupted(
  db: Database.Database,
  sessionId: string,
  workerId: string,
  generation: number,
  interruptedAt: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE sessions
       SET is_running = 0, interrupted_at = ?, worker_id = NULL, updated_at = ?
       WHERE id = ? AND worker_id = ? AND worker_generation = ?`,
    )
    .run(interruptedAt, interruptedAt, sessionId, workerId, generation)
  return result.changes === 1
}

export function clearSessionInterrupted(db: Database.Database, sessionId: string): void {
  db.prepare(`UPDATE sessions SET interrupted_at = NULL, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    sessionId,
  )
}

export function getSessionInterruptedAt(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(`SELECT interrupted_at FROM sessions WHERE id = ?`).get(sessionId) as
    { interrupted_at: string | null } | undefined
  return row?.interrupted_at ?? null
}

export function findPendingToolReconciliations(events: StoredEvent[]): PendingToolReconciliation[] {
  let turnStartedAt = -Infinity
  for (const event of events) {
    if (event.type === 'running.changed' && (event.data as { isRunning: boolean }).isRunning) {
      turnStartedAt = event.timestamp
    } else if (event.type === 'message.start' && (event.data as { role?: string }).role === 'user') {
      turnStartedAt = Math.max(turnStartedAt, event.timestamp)
    } else if (event.type === 'turn.snapshot') {
      for (const message of (event.data as SessionSnapshot).messages) {
        if (message.role === 'user') turnStartedAt = Math.max(turnStartedAt, message.timestamp)
      }
    }
  }

  const pending = new Map<string, PendingToolReconciliation>()
  for (const event of events) {
    if (event.type === 'turn.snapshot') {
      const snapshot = event.data as SessionSnapshot
      for (const message of snapshot.messages) {
        for (const toolCall of message.toolCalls ?? []) {
          if (!toolCall.result && (toolCall.startedAt ?? message.timestamp) >= turnStartedAt) {
            pending.set(toolCall.id, {
              messageId: message.id,
              toolCallId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            })
          }
        }
      }
    } else if (event.type === 'tool.call' && event.timestamp >= turnStartedAt) {
      const data = event.data as Extract<TurnEvent, { type: 'tool.call' }>['data']
      pending.set(data.toolCall.id, {
        messageId: data.messageId,
        toolCallId: data.toolCall.id,
        name: data.toolCall.name,
        arguments: data.toolCall.arguments,
      })
    } else if (event.type === 'tool.result') {
      pending.delete((event.data as { toolCallId: string }).toolCallId)
    }
  }
  return [...pending.values()]
}

export function prepareSessionInterruptionEvents(
  eventStore: Pick<EventStore, 'invalidateExternalSession' | 'getEvents' | 'append'>,
  sessionId: string,
): StoredEvent[] {
  eventStore.invalidateExternalSession(sessionId)
  const events = eventStore.getEvents(sessionId)
  const reconciled = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool.reconciliation_required' || event.type === 'tool.reconciliation_resolved') {
      reconciled.add((event.data as { toolCallId: string }).toolCallId)
    }
  }
  for (const pending of findPendingToolReconciliations(events)) {
    if (reconciled.has(pending.toolCallId)) continue
    eventStore.append(sessionId, { type: 'tool.reconciliation_required', data: pending })
  }
  return events
}

/**
 * Pure resume decision for an interrupted session. Identical to the boot
 * auto-continuation plan: finalize a partial assistant message, then continue
 * with the stream-interrupted reminder. Returns null when the session must
 * not be resumed automatically (active workflow) — same rule as boot.
 */
export function planWorkerCrashRecovery(
  events: StoredEvent[],
  hasActiveWorkflow: boolean,
): BootContinuationPlan | null {
  return planBootContinuation(events, hasActiveWorkflow)
}
