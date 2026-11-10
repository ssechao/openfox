import type { ToolResult } from '../../../shared/types.js'
import type { ProjectTasksArgs } from '../../tools/project-tasks.js'
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerToGatewayMessage } from './protocol.js'
import { matchesWorkerIdentity, WorkerIpcRequests } from './request-client.js'

const PROJECT_TASKS_REQUEST_DEADLINE_MS = 30_000

function errorResult(error: string, durationMs: number): ToolResult {
  return { success: false, error, durationMs, truncated: false }
}

export class WorkerProjectTasksClient {
  private readonly requests = new WorkerIpcRequests<ToolResult>()

  constructor(
    private readonly identity: WorkerIpcIdentity,
    private readonly send: (message: WorkerToGatewayMessage) => void,
    private readonly deadlineMs = PROJECT_TASKS_REQUEST_DEADLINE_MS,
  ) {}

  execute(args: ProjectTasksArgs, permittedActions?: string[]): Promise<ToolResult> {
    const requestId = crypto.randomUUID()
    const startedAt = Date.now()
    return this.requests.request({
      requestId,
      deadlineMs: this.deadlineMs,
      closedResult: (reason) => errorResult(reason, 0),
      timeoutResult: () =>
        errorResult(
          `Project tasks request timed out after ${this.deadlineMs}ms; the task state is unknown`,
          Date.now() - startedAt,
        ),
      send: () =>
        this.send({
          ...this.identity,
          type: 'project_tasks.request',
          requestId,
          args,
          ...(permittedActions ? { permittedActions } : {}),
        }),
    })
  }

  handleMessage(message: GatewayToWorkerMessage): void {
    if (message.type !== 'project_tasks.response' || !matchesWorkerIdentity(this.identity, message)) return
    this.requests.finish(message.requestId, message.result)
  }

  close(reason: string): void {
    this.requests.close(reason, (error) => errorResult(error, 0))
  }
}
