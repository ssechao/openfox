import { availableParallelism } from 'node:os'

export const MAX_WORKER_PROCESSES = 32
export const MAX_WAITING_SESSIONS = 64

export type AdmissionResult = 'started' | 'waiting' | 'already-active' | 'already-waiting' | 'full' | 'closed'
export type CancellationResult = 'active' | 'waiting' | 'none'

interface WaitingTurn {
  sessionId: string
  start: () => void
}

export function resolveSessionWorkerEnabled(
  environmentValue: string | undefined,
  settingValue: string | undefined,
  defaultEnabled = true,
): boolean {
  if (environmentValue !== undefined) return environmentValue !== 'false'
  if (settingValue !== undefined) return settingValue !== 'false'
  return defaultEnabled
}

export function resolveWorkerPoolSize(raw: string | undefined, parallelism = availableParallelism()): number {
  const fallback = Math.min(4, Math.max(1, parallelism - 1))
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_WORKER_PROCESSES, Math.max(1, Math.floor(parsed)))
}

export class SessionTurnScheduler {
  private readonly active = new Set<string>()
  private readonly waiting: WaitingTurn[] = []
  private closed = false

  constructor(
    private readonly options: {
      maxConcurrent: number
      maxWaitingSessions: number
    },
  ) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer')
    }
    if (!Number.isInteger(options.maxWaitingSessions) || options.maxWaitingSessions < 0) {
      throw new Error('maxWaitingSessions must be a non-negative integer')
    }
  }

  admit(sessionId: string, start: () => void): AdmissionResult {
    if (this.closed) return 'closed'
    if (this.active.has(sessionId)) return 'already-active'
    if (this.waiting.some((entry) => entry.sessionId === sessionId)) return 'already-waiting'
    if (this.active.size < this.options.maxConcurrent) {
      this.active.add(sessionId)
      start()
      return 'started'
    }
    if (this.waiting.length >= this.options.maxWaitingSessions) return 'full'
    this.waiting.push({ sessionId, start })
    return 'waiting'
  }

  canAccept(sessionId: string): boolean {
    if (this.closed) return false
    if (this.active.has(sessionId) || this.waiting.some((entry) => entry.sessionId === sessionId)) return true
    return this.active.size < this.options.maxConcurrent || this.waiting.length < this.options.maxWaitingSessions
  }

  release(sessionId: string): boolean {
    if (!this.active.delete(sessionId)) return false
    this.startNext()
    return true
  }

  cancel(sessionId: string): CancellationResult {
    if (this.active.has(sessionId)) return 'active'
    const index = this.waiting.findIndex((entry) => entry.sessionId === sessionId)
    if (index === -1) return 'none'
    this.waiting.splice(index, 1)
    return 'waiting'
  }

  closeAdmissions(): string[] {
    this.closed = true
    return this.waiting.splice(0).map((entry) => entry.sessionId)
  }

  snapshot(): { active: string[]; waiting: string[]; closed: boolean } {
    return {
      active: [...this.active],
      waiting: this.waiting.map((entry) => entry.sessionId),
      closed: this.closed,
    }
  }

  private startNext(): void {
    if (this.closed) return
    const next = this.waiting.shift()
    if (!next) return
    this.active.add(next.sessionId)
    next.start()
  }
}
