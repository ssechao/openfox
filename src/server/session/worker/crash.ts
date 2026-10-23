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
import type { StoredEvent } from '../../events/types.js'
import { planBootContinuation, type BootContinuationPlan } from '../auto-continue.js'

export function markSessionInterrupted(db: Database.Database, sessionId: string, interruptedAt: string): void {
  db.prepare(
    `UPDATE sessions SET is_running = 0, interrupted_at = ?, worker_id = NULL, updated_at = ? WHERE id = ?`,
  ).run(interruptedAt, interruptedAt, sessionId)
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
