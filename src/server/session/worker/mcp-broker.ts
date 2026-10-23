import type { ToolResult } from '../../../shared/types.js'
import type { McpCancelMessage, McpRequestMessage, WorkerIpcIdentity, WorkerMcpResponseMessage } from './protocol.js'

export const MAX_MCP_WORKER_IN_FLIGHT = 8
export const MAX_MCP_GLOBAL_IN_FLIGHT = 64
export const MAX_MCP_REQUEST_BYTES = 256 * 1024
export const MAX_MCP_RESPONSE_CHUNK_BYTES = 64 * 1024
export const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_MCP_DEADLINE_MS = 3_600_000

interface InFlightRequest {
  request: McpRequestMessage
  controller: AbortController
  timer: NodeJS.Timeout
}

interface WorkerMcpBrokerDeps {
  execute: (request: McpRequestMessage, signal: AbortSignal) => Promise<ToolResult>
  isCurrent: (identity: WorkerIpcIdentity) => boolean
  send: (message: WorkerMcpResponseMessage) => void
  reconcile: (request: McpRequestMessage) => void
}

function workerKey(identity: WorkerIpcIdentity): string {
  return `${identity.sessionId}:${identity.workerId}:${identity.generation}`
}

function requestKey(identity: WorkerIpcIdentity & { requestId: string }): string {
  return `${workerKey(identity)}:${identity.requestId}`
}

function identityOf(message: WorkerIpcIdentity): WorkerIpcIdentity {
  return {
    sessionId: message.sessionId,
    workerId: message.workerId,
    generation: message.generation,
  }
}

function failure(error: string): ToolResult {
  return { success: false, error, durationMs: 0, truncated: false }
}

export class WorkerMcpBroker {
  private readonly inFlight = new Map<string, InFlightRequest>()
  private readonly perWorker = new Map<string, number>()

  constructor(private readonly deps: WorkerMcpBrokerDeps) {}

  inFlightCount(): number {
    return this.inFlight.size
  }

  handleRequest(request: McpRequestMessage): void {
    if (!this.deps.isCurrent(identityOf(request))) return

    if (!Number.isInteger(request.deadlineMs) || request.deadlineMs <= 0 || request.deadlineMs > MAX_MCP_DEADLINE_MS) {
      this.sendResult(request, failure(`MCP deadline must be between 1 and ${MAX_MCP_DEADLINE_MS} ms`))
      return
    }

    if (Buffer.byteLength(JSON.stringify(request)) > MAX_MCP_REQUEST_BYTES) {
      this.sendResult(request, failure(`MCP request exceeds ${MAX_MCP_REQUEST_BYTES} bytes`))
      return
    }

    const key = requestKey(request)
    if (this.inFlight.has(key)) {
      this.sendResult(request, failure('Duplicate MCP request id'))
      return
    }

    const owner = workerKey(request)
    const workerCount = this.perWorker.get(owner) ?? 0
    if (workerCount >= MAX_MCP_WORKER_IN_FLIGHT) {
      this.sendResult(request, failure('MCP worker in-flight limit reached'))
      return
    }
    if (this.inFlight.size >= MAX_MCP_GLOBAL_IN_FLIGHT) {
      this.sendResult(request, failure('MCP global in-flight limit reached'))
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      const entry = this.take(request)
      if (!entry) return
      entry.controller.abort(new Error('MCP request deadline exceeded'))
      this.deps.reconcile(request)
      this.sendResult(request, {
        ...failure('MCP request deadline exceeded; external effects may have occurred'),
        metadata: { reconciliationRequired: true },
      })
    }, request.deadlineMs)

    this.inFlight.set(key, { request, controller, timer })
    this.perWorker.set(owner, workerCount + 1)

    void this.deps
      .execute(request, controller.signal)
      .then((result) => {
        if (!this.take(request) || !this.deps.isCurrent(identityOf(request))) return
        this.sendResult(request, result)
      })
      .catch((error: unknown) => {
        if (!this.take(request) || !this.deps.isCurrent(identityOf(request))) return
        this.sendResult(request, failure(error instanceof Error ? error.message : String(error)))
      })
  }

  handleCancel(message: McpCancelMessage): void {
    if (!this.deps.isCurrent(identityOf(message))) return
    const entry = this.take(message)
    if (!entry) return
    entry.controller.abort(new Error('MCP request cancelled'))
    this.deps.reconcile(entry.request)
  }

  cancelWorker(identity: WorkerIpcIdentity): void {
    for (const entry of [...this.inFlight.values()]) {
      if (
        entry.request.sessionId !== identity.sessionId ||
        entry.request.workerId !== identity.workerId ||
        entry.request.generation !== identity.generation
      ) {
        continue
      }
      this.take(entry.request)
      entry.controller.abort(new Error('MCP worker stopped'))
      this.deps.reconcile(entry.request)
    }
  }

  private take(message: WorkerIpcIdentity & { requestId: string }): InFlightRequest | undefined {
    const key = requestKey(message)
    const entry = this.inFlight.get(key)
    if (!entry) return undefined
    this.inFlight.delete(key)
    clearTimeout(entry.timer)
    const owner = workerKey(entry.request)
    const remaining = (this.perWorker.get(owner) ?? 1) - 1
    if (remaining === 0) this.perWorker.delete(owner)
    else this.perWorker.set(owner, remaining)
    return entry
  }

  private sendResult(request: McpRequestMessage, result: ToolResult): void {
    if (!this.deps.isCurrent(identityOf(request))) return
    let bytes = Buffer.from(JSON.stringify(result))
    if (bytes.length > MAX_MCP_RESPONSE_BYTES) {
      this.deps.reconcile(request)
      bytes = Buffer.from(
        JSON.stringify({
          ...failure('MCP response exceeded the 8 MiB limit; external effects may have occurred'),
          metadata: { reconciliationRequired: true },
        } satisfies ToolResult),
      )
    }

    const rawChunkBytes = Math.floor((MAX_MCP_RESPONSE_CHUNK_BYTES * 3) / 4)
    let chunks = 0
    for (let offset = 0; offset < bytes.length; offset += rawChunkBytes) {
      this.deps.send({
        ...identityOf(request),
        type: 'mcp.response.chunk',
        requestId: request.requestId,
        index: chunks,
        data: bytes.subarray(offset, offset + rawChunkBytes).toString('base64'),
      })
      chunks++
    }
    this.deps.send({
      ...identityOf(request),
      type: 'mcp.response.end',
      requestId: request.requestId,
      chunks,
    })
  }
}
