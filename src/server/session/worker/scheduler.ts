import { availableParallelism } from 'node:os'

export const MAX_WORKER_PROCESSES = 32
export const MAX_WAITING_SESSIONS = 64
export const MAX_QUEUED_COMMANDS_PER_SESSION = 100

export type AdmissionResult = 'started' | 'waiting' | 'full' | 'closed'
export type CancellationResult = 'active' | 'waiting' | 'none'

interface WaitingTurn {
  sessionId: string
  starts: Array<() => void>
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
  private readonly active = new Map<string, Array<() => void>>()
  private readonly waiting: WaitingTurn[] = []
  private closed = false

  constructor(
    private readonly options: {
      maxConcurrent: number
      maxWaitingSessions: number
      maxQueuedCommandsPerSession?: number
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
    const maxQueued = this.options.maxQueuedCommandsPerSession ?? MAX_QUEUED_COMMANDS_PER_SESSION
    const activeQueue = this.active.get(sessionId)
    if (activeQueue) {
      if (activeQueue.length >= maxQueued) return 'full'
      activeQueue.push(start)
      return 'waiting'
    }
    const waiting = this.waiting.find((entry) => entry.sessionId === sessionId)
    if (waiting) {
      if (waiting.starts.length >= maxQueued) return 'full'
      waiting.starts.push(start)
      return 'waiting'
    }
    if (this.active.size < this.options.maxConcurrent) {
      this.active.set(sessionId, [])
      start()
      return 'started'
    }
    if (this.waiting.length >= this.options.maxWaitingSessions) return 'full'
    this.waiting.push({ sessionId, starts: [start] })
    return 'waiting'
  }

  canAccept(sessionId: string): boolean {
    if (this.closed) return false
    if (this.active.has(sessionId) || this.waiting.some((entry) => entry.sessionId === sessionId)) return true
    return this.active.size < this.options.maxConcurrent || this.waiting.length < this.options.maxWaitingSessions
  }

  release(sessionId: string): boolean {
    const queued = this.active.get(sessionId)
    if (!queued) return false
    this.active.delete(sessionId)
    if (queued.length > 0) this.waiting.push({ sessionId, starts: queued })
    this.startNext()
    return true
  }

  cancel(sessionId: string): CancellationResult {
    const activeQueue = this.active.get(sessionId)
    if (activeQueue) {
      activeQueue.length = 0
      return 'active'
    }
    const index = this.waiting.findIndex((entry) => entry.sessionId === sessionId)
    if (index === -1) return 'none'
    this.waiting.splice(index, 1)
    return 'waiting'
  }

  closeAdmissions(): string[] {
    this.closed = true
    const cancelled = this.waiting.splice(0).map((entry) => entry.sessionId)
    for (const [sessionId, queued] of this.active) {
      if (queued.length > 0) cancelled.push(sessionId)
      queued.length = 0
    }
    return [...new Set(cancelled)]
  }

  snapshot(): { active: string[]; waiting: string[]; closed: boolean } {
    return {
      active: [...this.active.keys()],
      waiting: this.waiting.map((entry) => entry.sessionId),
      closed: this.closed,
    }
  }

  private startNext(): void {
    if (this.closed) return
    const next = this.waiting.shift()
    if (!next) return
    const [start, ...queued] = next.starts
    if (!start) return
    this.active.set(next.sessionId, queued)
    start()
  }
}
