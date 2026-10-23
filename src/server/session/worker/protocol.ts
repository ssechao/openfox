import type { Config } from '../../../shared/types.js'
import type { ServerMessage } from '../../../shared/protocol.js'
import type { DiagnosticsData } from '../../../shared/diagnostics.js'
import type { LLMToolDefinition } from '../../llm/types.js'
import type { WorkerToken } from './token.js'

export type { WorkerToken }

export interface WorkerIpcIdentity extends WorkerToken {
  sessionId: string
}

export interface WorkerMcpTool {
  name: string
  serverName: string
  toolName: string
  definition: LLMToolDefinition
}

export type McpRequestMessage = WorkerIpcIdentity & {
  type: 'mcp.request'
  requestId: string
  serverName: string
  toolName: string
  name: string
  args: Record<string, unknown>
  messageId: string
  toolCallId: string
  deadlineMs: number
}

export type McpCancelMessage = WorkerIpcIdentity & {
  type: 'mcp.cancel'
  requestId: string
}

export type McpResponseChunkMessage = WorkerIpcIdentity & {
  type: 'mcp.response.chunk'
  requestId: string
  index: number
  data: string
}

export type McpResponseEndMessage = WorkerIpcIdentity & {
  type: 'mcp.response.end'
  requestId: string
  chunks: number
}

export type WorkerMcpResponseMessage = McpResponseChunkMessage | McpResponseEndMessage

export type GatewayToWorkerMessage =
  | (WorkerToken & { type: 'start'; sessionId: string; config: Config; mcpTools: WorkerMcpTool[] })
  | (WorkerToken & { type: 'abort' })
  | WorkerMcpResponseMessage

export type WorkerToGatewayMessage =
  | (WorkerToken & { type: 'ready'; pid: number })
  | (WorkerToken & { type: 'ws'; msg: ServerMessage })
  | (WorkerToken & { type: 'health'; data: DiagnosticsData })
  | (WorkerToken & { type: 'done'; ok: boolean; error?: string })
  | McpRequestMessage
  | McpCancelMessage
