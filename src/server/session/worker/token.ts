/**
 * Worker identity and fencing (étape 6a).
 *
 * A session running in its own process is identified by (workerId,
 * generation), never by PID: PIDs get reused, a killed worker's identity must
 * die with its generation. The gateway persists the current pair on the
 * session row (`sessions.worker_id`, `sessions.worker_generation`,
 * monotonically increasing, never reset) before forking the worker. Every
 * event the worker writes is fenced: the insert transaction re-reads the
 * session row and rejects the write when the pair no longer matches, so a
 * stale generation can never double-execute after the token moved on.
 * `UNIQUE(session_id, seq)` remains the backstop for seq assignment.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface WorkerToken {
  workerId: string
  generation: number
}

export class StaleWorkerGenerationError extends Error {
  readonly code = 'STALE_WORKER_GENERATION'

  constructor(
    readonly sessionId: string,
    readonly token: WorkerToken,
  ) {
    super(`Worker ${token.workerId} generation ${token.generation} is no longer the owner of session ${sessionId}`)
    this.name = 'StaleWorkerGenerationError'
  }
}

export function isStaleWorkerGenerationError(error: unknown): error is StaleWorkerGenerationError {
  return error instanceof StaleWorkerGenerationError
}

interface WorkerRow {
  worker_id: string | null
  worker_generation: number
}

function readWorkerRow(db: Database.Database, sessionId: string): WorkerRow | undefined {
  return db.prepare(`SELECT worker_id, worker_generation FROM sessions WHERE id = ?`).get(sessionId) as
    WorkerRow | undefined
}

/**
 * Assign a fresh token to a session about to run in a worker. Bumps the
 * persisted generation and records the new worker id atomically; any previous
 * worker's fence starts rejecting from this point on.
 */
export function assignWorkerToken(db: Database.Database, sessionId: string): WorkerToken {
  const token = db.transaction(() => {
    const row = readWorkerRow(db, sessionId)
    if (!row) throw new Error(`Cannot assign a worker token: unknown session ${sessionId}`)
    const token: WorkerToken = { workerId: randomUUID(), generation: row.worker_generation + 1 }
    db.prepare(`UPDATE sessions SET worker_id = ?, worker_generation = ? WHERE id = ?`).run(
      token.workerId,
      token.generation,
      sessionId,
    )
    return token
  })()
  return token
}

/**
 * Release the token after the worker exited. Conditional on the exact pair so
 * a late cleanup of generation N never clears the token of generation N+1.
 */
export function clearWorkerToken(db: Database.Database, sessionId: string, token: WorkerToken): void {
  db.prepare(`UPDATE sessions SET worker_id = NULL WHERE id = ? AND worker_id = ? AND worker_generation = ?`).run(
    sessionId,
    token.workerId,
    token.generation,
  )
}

export function isWorkerTokenCurrent(db: Database.Database, sessionId: string, token: WorkerToken): boolean {
  const row = readWorkerRow(db, sessionId)
  return row?.worker_id === token.workerId && row.worker_generation === token.generation
}

/**
 * Build the write fence a worker-side EventStore invokes inside its append
 * transaction. Throws StaleWorkerGenerationError when this worker's token is
 * no longer the session's current pair.
 */
export function createWorkerFence(db: Database.Database, token: WorkerToken): (sessionId: string) => void {
  const check = db.prepare(`SELECT worker_id, worker_generation FROM sessions WHERE id = ?`)
  return (sessionId: string) => {
    const row = check.get(sessionId) as WorkerRow | undefined
    if (row?.worker_id !== token.workerId || row.worker_generation !== token.generation) {
      throw new StaleWorkerGenerationError(sessionId, token)
    }
  }
}

/**
 * Predicate the gateway applies to every IPC message from a worker: only the
 * live (workerId, generation) pair may have its messages honored. This is the
 * PID-reuse guard — a message carries identity, never a PID.
 */
export function isWorkerMessageCurrent(active: WorkerToken | null, message: unknown): boolean {
  if (!active || typeof message !== 'object' || message === null) return false
  const msg = message as { workerId?: unknown; generation?: unknown }
  return msg.workerId === active.workerId && msg.generation === active.generation
}
