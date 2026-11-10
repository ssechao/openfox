import type { WorkerIpcIdentity } from './protocol.js'

interface PendingRequest<TResult> {
  resolve: (result: TResult) => void
  timeout: NodeJS.Timeout
}

interface RequestOptions<TResult> {
  requestId: string
  deadlineMs: number
  closedResult: (reason: string) => TResult
  timeoutResult: () => TResult
  send: () => void
}

export function matchesWorkerIdentity(expected: WorkerIpcIdentity, message: WorkerIpcIdentity): boolean {
  return (
    expected.sessionId === message.sessionId &&
    expected.workerId === message.workerId &&
    expected.generation === message.generation
  )
}

export class WorkerIpcRequests<TResult> {
  private readonly pending = new Map<string, PendingRequest<TResult>>()
  private closedReason: string | null = null

  request(options: RequestOptions<TResult>): Promise<TResult> {
    if (this.closedReason !== null) return Promise.resolve(options.closedResult(this.closedReason))

    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.finish(options.requestId, options.timeoutResult()), options.deadlineMs)
      this.pending.set(options.requestId, { resolve, timeout })
      options.send()
    })
  }

  finish(requestId: string, result: TResult): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    pending.resolve(result)
  }

  close(reason: string, result: (reason: string) => TResult): void {
    if (this.closedReason !== null) return
    this.closedReason = reason
    for (const requestId of [...this.pending.keys()]) {
      this.finish(requestId, result(reason))
    }
  }
}
