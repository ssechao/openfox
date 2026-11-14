import type { ToolResult } from '../../../shared/types.js'
import type { McpCancelMessage, McpRequestMessage, WorkerIpcIdentity, WorkerMcpResponseMessage } from './protocol.js'

export const MAX_MCP_WORKER_IN_FLIGHT = 8
export const MAX_MCP_GLOBAL_IN_FLIGHT = 64
export const MAX_MCP_REQUEST_BYTES = 256 * 1024
export const MAX_MCP_RESPONSE_CHUNK_BYTES = 64 * 1024
export const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_MCP_DEADLINE_MS = 3_600_000
export const DEFAULT_MCP_DEADLINE_MS = 300_000

export function resolveMcpDeadlineMs(agentTimeout?: number): number {
  return Math.min(MAX_MCP_DEADLINE_MS, Math.max(1, Math.trunc(agentTimeout ?? DEFAULT_MCP_DEADLINE_MS)))
}

export function maxMcpWaitTimeoutSeconds(agentTimeout?: number): number {
  return Math.max(1, Math.floor(resolveMcpDeadlineMs(agentTimeout) / 1000) - 30)
}

const READ_ONLY_MCP_TOOL_NAMES = new Set([
  'openfox_wait',
  'openfox_session_status',
  'openfox_sessions',
  'openfox_session_detail',
  'ht_list_peers',
  'ht_get_contact_info',
])

interface InFlightRequest {
  request: McpRequestMessage
  controller: AbortController
  timer: NodeJS.Timeout
}

interface WorkerMcpBrokerDeps {
  execute: (request: McpRequestMessage, signal: AbortSignal) => Promise<ToolResult>
  isCurrent: (identity: WorkerIpcIdentity) => boolean
  send: (message: WorkerMcpResponseMessage) => void
  reconcile: (request: McpRequestMessage, durationMs?: number) => void
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

function matchesReadOnlyMcpToolName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return [...READ_ONLY_MCP_TOOL_NAMES].some((name) => value === name || value.endsWith(`_${name}`))
}

function isReadOnlyRequest(request: McpRequestMessage): boolean {
  if (matchesReadOnlyMcpToolName(request.toolName) || matchesReadOnlyMcpToolName(request.name)) return true
  const proxy =
    request.toolName === 'mcp_execute_tool' ||
    request.toolName.endsWith('_mcp_execute_tool') ||
    request.name === 'mcp_execute_tool' ||
    request.name.endsWith('_mcp_execute_tool')
  return proxy && matchesReadOnlyMcpToolName(request.args['tool_name'])
}

function withoutReconciliation(result: ToolResult): ToolResult {
  if (result.metadata?.['reconciliationRequired'] !== true) return result
  const normalized = { ...result }
  const metadata = { ...result.metadata }
  delete metadata['reconciliationRequired']
  if (Object.keys(metadata).length === 0) delete normalized.metadata
  else normalized.metadata = metadata
  return normalized
}

export class WorkerMcpBroker {
  private readonly inFlight = new Map<string, InFlightRequest>()
  private readonly perWorker = new Map<string, number>()
  private readonly reconciled = new Set<string>()

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
    if (this.reconciled.has(key)) {
      this.sendResult(request, failure('MCP request replay refused pending reconciliation'))
      return
    }
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
      const result = {
        ...failure(
          isReadOnlyRequest(request)
            ? 'MCP request deadline exceeded'
            : 'MCP request deadline exceeded; external effects may have occurred',
        ),
        durationMs: request.deadlineMs,
        ...(isReadOnlyRequest(request) ? {} : { metadata: { reconciliationRequired: true } }),
      } satisfies ToolResult
      this.sendResult(request, result)
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
    if (!isReadOnlyRequest(entry.request)) this.markReconciliation(entry.request)
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
      if (!isReadOnlyRequest(entry.request)) this.markReconciliation(entry.request)
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

  private markReconciliation(request: McpRequestMessage, durationMs?: number): void {
    const key = requestKey(request)
    if (this.reconciled.has(key)) return
    this.reconciled.add(key)
    if (durationMs === undefined) this.deps.reconcile(request)
    else this.deps.reconcile(request, durationMs)
  }

  private sendResult(request: McpRequestMessage, result: ToolResult): void {
    if (!this.deps.isCurrent(identityOf(request))) return
    const readOnly = isReadOnlyRequest(request)
    const normalizedResult = readOnly ? withoutReconciliation(result) : result
    if (normalizedResult.metadata?.['reconciliationRequired'] === true) {
      this.markReconciliation(request, normalizedResult.durationMs)
    }
    let bytes = Buffer.from(JSON.stringify(normalizedResult))
    if (bytes.length > MAX_MCP_RESPONSE_BYTES) {
      if (!readOnly) this.markReconciliation(request)
      bytes = Buffer.from(
        JSON.stringify({
          ...failure(
            readOnly
              ? 'MCP response exceeded the 8 MiB limit'
              : 'MCP response exceeded the 8 MiB limit; external effects may have occurred',
          ),
          ...(readOnly ? {} : { metadata: { reconciliationRequired: true } }),
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
