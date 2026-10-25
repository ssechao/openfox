import type { ToolResult } from '../../../shared/types.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import { applySessionIdInjection } from '../../mcp/session-id-injection.js'
import {
  MAX_MCP_DEADLINE_MS,
  MAX_MCP_REQUEST_BYTES,
  MAX_MCP_RESPONSE_CHUNK_BYTES,
  MAX_MCP_RESPONSE_BYTES,
} from './mcp-broker.js'
import type {
  GatewayToWorkerMessage,
  McpRequestMessage,
  WorkerIpcIdentity,
  WorkerMcpTool,
  WorkerToGatewayMessage,
} from './protocol.js'

interface PendingRequest {
  resolve: (result: ToolResult) => void
  chunks: Map<number, Buffer>
  totalBytes: number
  removeAbortListener: () => void
}

const DEFAULT_MCP_DEADLINE_MS = 300_000

function failure(error: string, uncertain = false): ToolResult {
  return {
    success: false,
    error,
    durationMs: 0,
    truncated: false,
    ...(uncertain ? { metadata: { reconciliationRequired: true } } : {}),
  }
}

function matchesIdentity(expected: WorkerIpcIdentity, message: WorkerIpcIdentity): boolean {
  return (
    expected.sessionId === message.sessionId &&
    expected.workerId === message.workerId &&
    expected.generation === message.generation
  )
}

export class WorkerMcpClient {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    private readonly identity: WorkerIpcIdentity,
    private readonly send: (message: WorkerToGatewayMessage) => void,
  ) {}

  pendingCount(): number {
    return this.pending.size
  }

  createTools(descriptors: WorkerMcpTool[]): Tool[] {
    return descriptors.map((descriptor) => ({
      name: descriptor.name,
      definition: descriptor.definition,
      mcpServer: descriptor.serverName,
      execute: (args, context) => this.execute(descriptor, args, context),
    }))
  }

  handleMessage(message: GatewayToWorkerMessage): void {
    if (
      (message.type !== 'mcp.response.chunk' && message.type !== 'mcp.response.end') ||
      !matchesIdentity(this.identity, message)
    ) {
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending) return

    if (message.type === 'mcp.response.chunk') {
      if (
        !Number.isInteger(message.index) ||
        message.index < 0 ||
        pending.chunks.has(message.index) ||
        Buffer.byteLength(message.data) > MAX_MCP_RESPONSE_CHUNK_BYTES
      ) {
        this.failProtocol(message.requestId, 'Invalid MCP response chunk')
        return
      }
      const bytes = Buffer.from(message.data, 'base64')
      if (pending.totalBytes + bytes.length > MAX_MCP_RESPONSE_BYTES) {
        this.failProtocol(message.requestId, 'MCP response exceeds 8 MiB')
        return
      }
      pending.chunks.set(message.index, bytes)
      pending.totalBytes += bytes.length
      return
    }

    if (
      !Number.isInteger(message.chunks) ||
      message.chunks < 1 ||
      message.chunks !== pending.chunks.size ||
      [...pending.chunks.keys()].some((index) => index < 0 || index >= message.chunks)
    ) {
      this.failProtocol(message.requestId, 'Incomplete MCP response')
      return
    }

    let result: ToolResult
    try {
      result = JSON.parse(
        Buffer.concat(
          Array.from({ length: message.chunks }, (_, index) => pending.chunks.get(index) as Buffer),
        ).toString('utf8'),
      ) as ToolResult
    } catch {
      this.failProtocol(message.requestId, 'Invalid MCP response')
      return
    }
    this.finish(message.requestId, result)
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(requestId, 'MCP request cancelled because the worker stopped')
    }
  }

  private execute(descriptor: WorkerMcpTool, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!context.toolCallId || !context.messageId) {
      return Promise.resolve(failure('MCP IPC requires tool call identity'))
    }
    if (context.signal?.aborted) {
      return Promise.resolve(failure('MCP request cancelled before dispatch'))
    }
    const injected = applySessionIdInjection(descriptor.sessionIdInjection, args, this.identity.sessionId)
    if (!injected.ok) return Promise.resolve(failure(injected.error))

    const requestId = crypto.randomUUID()
    const deadlineMs = Math.min(
      MAX_MCP_DEADLINE_MS,
      Math.max(1, Math.trunc(context.agentTimeout ?? DEFAULT_MCP_DEADLINE_MS)),
    )
    const request: McpRequestMessage = {
      ...this.identity,
      type: 'mcp.request',
      requestId,
      serverName: descriptor.serverName,
      toolName: descriptor.toolName,
      name: descriptor.name,
      args: injected.args,
      messageId: context.messageId,
      toolCallId: context.toolCallId,
      deadlineMs,
    }
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_MCP_REQUEST_BYTES) {
      return Promise.resolve(failure(`MCP request exceeds ${MAX_MCP_REQUEST_BYTES} bytes`))
    }

    return new Promise((resolve) => {
      const onAbort = (): void => this.cancel(requestId, 'MCP request cancelled; external effects may have occurred')
      context.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        resolve,
        chunks: new Map(),
        totalBytes: 0,
        removeAbortListener: () => context.signal?.removeEventListener('abort', onAbort),
      })
      this.send(request)
    })
  }

  private failProtocol(requestId: string, error: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.send({ ...this.identity, type: 'mcp.cancel', requestId })
    this.finish(requestId, failure(`${error}; external effects may have occurred`, true))
  }

  private cancel(requestId: string, error: string): void {
    if (!this.pending.has(requestId)) return
    this.send({ ...this.identity, type: 'mcp.cancel', requestId })
    this.finish(requestId, failure(error, true))
  }

  private finish(requestId: string, result: ToolResult): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    pending.removeAbortListener()
    pending.resolve(result)
  }
}
