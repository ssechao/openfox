/**
 * Worker-crash recovery (étape 6a).
 *
 * When the gateway detects a worker's death it marks the session interrupted
 * and finalizes any partial assistant message. Each open tool call is closed
 * with one synthetic terminal result (`success: false`, `outcomeUnknown: true`)
 * before the continuation is queued. The interrupted call is not executed again.
 * An active workflow is resumed from its current step, not left for a button.
 */

import type Database from 'better-sqlite3'
import type { EventStore } from '../../events/store.js'
import type { StoredEvent } from '../../events/types.js'
import { planBootContinuation, type BootContinuationPlan } from '../auto-continue.js'
import { settleUnknownToolOutcomes } from './settle-unknown.js'

export {
  findPendingToolReconciliations,
  settleUnknownToolOutcomes,
  syntheticUnknownToolResult,
} from './settle-unknown.js'

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

export function restoreSessionInterruptedForAttempt(
  db: Database.Database,
  sessionId: string,
  interruptedAt: string,
  initialGeneration: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE sessions
       SET is_running = 0, interrupted_at = ?, updated_at = ?
       WHERE id = ? AND worker_id IS NULL
         AND worker_generation BETWEEN ? AND ?`,
    )
    .run(interruptedAt, interruptedAt, sessionId, initialGeneration, initialGeneration + 1)
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

export function prepareSessionInterruptionEvents(
  eventStore: Pick<EventStore, 'invalidateExternalSession' | 'getEvents' | 'append'>,
  sessionId: string,
): StoredEvent[] {
  eventStore.invalidateExternalSession(sessionId)
  const events = eventStore.getEvents(sessionId)
  settleUnknownToolOutcomes(events, (event) => {
    eventStore.append(sessionId, event)
  })
  return eventStore.getEvents(sessionId)
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
