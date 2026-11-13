import type { BackgroundActionResult, BackgroundProcessToolArgs } from '../../tools/background-process/actions.js'
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerToGatewayMessage } from './protocol.js'
import { matchesWorkerIdentity, WorkerIpcRequests } from './request-client.js'

export const BACKGROUND_REQUEST_DEADLINE_MS = 30_000

export class WorkerBackgroundClient {
  private readonly requests = new WorkerIpcRequests<BackgroundActionResult>()

  constructor(
    private readonly identity: WorkerIpcIdentity,
    private readonly send: (message: WorkerToGatewayMessage) => void,
    private readonly deadlineMs = BACKGROUND_REQUEST_DEADLINE_MS,
  ) {}

  execute(defaultCwd: string, args: BackgroundProcessToolArgs): Promise<BackgroundActionResult> {
    const requestId = crypto.randomUUID()
    return this.requests.request({
      requestId,
      deadlineMs: this.deadlineMs,
      closedResult: (reason) => ({ ok: false, error: reason }),
      timeoutResult: () => ({
        ok: false,
        error: `Background process request timed out after ${this.deadlineMs}ms; the process state is unknown`,
      }),
      send: () =>
        this.send({
          ...this.identity,
          type: 'background.request',
          requestId,
          cwd: defaultCwd,
          args,
        }),
    })
  }

  handleMessage(message: GatewayToWorkerMessage): void {
    if (message.type !== 'background.response' || !matchesWorkerIdentity(this.identity, message)) return
    this.requests.finish(message.requestId, message.result)
  }

  close(reason: string): void {
    this.requests.close(reason, (error) => ({ ok: false, error }))
  }
}
