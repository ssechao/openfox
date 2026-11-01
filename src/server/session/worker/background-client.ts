import type { BackgroundActionResult, BackgroundProcessToolArgs } from '../../tools/background-process/actions.js'
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerToGatewayMessage } from './protocol.js'

export const BACKGROUND_REQUEST_DEADLINE_MS = 30_000

interface PendingRequest {
  resolve: (result: BackgroundActionResult) => void
  timeout: NodeJS.Timeout
}

function matchesIdentity(expected: WorkerIpcIdentity, message: WorkerIpcIdentity): boolean {
  return (
    expected.sessionId === message.sessionId &&
    expected.workerId === message.workerId &&
    expected.generation === message.generation
  )
}

export class WorkerBackgroundClient {
  private readonly pending = new Map<string, PendingRequest>()
  private closedReason: string | null = null

  constructor(
    private readonly identity: WorkerIpcIdentity,
    private readonly send: (message: WorkerToGatewayMessage) => void,
    private readonly deadlineMs = BACKGROUND_REQUEST_DEADLINE_MS,
  ) {}

  execute(defaultCwd: string, args: BackgroundProcessToolArgs): Promise<BackgroundActionResult> {
    if (this.closedReason !== null) {
      return Promise.resolve({ ok: false, error: this.closedReason })
    }

    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.finish(requestId, {
          ok: false,
          error: `Background process request timed out after ${this.deadlineMs}ms; the process state is unknown`,
        })
      }, this.deadlineMs)
      this.pending.set(requestId, { resolve, timeout })
      this.send({
        ...this.identity,
        type: 'background.request',
        requestId,
        cwd: defaultCwd,
        args,
      })
    })
  }

  handleMessage(message: GatewayToWorkerMessage): void {
    if (message.type !== 'background.response' || !matchesIdentity(this.identity, message)) return
    this.finish(message.requestId, message.result)
  }

  close(reason: string): void {
    if (this.closedReason !== null) return
    this.closedReason = reason
    for (const requestId of [...this.pending.keys()]) {
      this.finish(requestId, { ok: false, error: reason })
    }
  }

  private finish(requestId: string, result: BackgroundActionResult): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    pending.resolve(result)
  }
}
