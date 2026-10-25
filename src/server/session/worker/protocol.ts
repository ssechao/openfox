import type { Config } from '../../../shared/types.js'
import type { ChoiceOption, ServerMessage } from '../../../shared/protocol.js'
import type { DiagnosticsData } from '../../../shared/diagnostics.js'
import type { LLMToolDefinition } from '../../llm/types.js'
import type { WorkerToken } from './token.js'
import type { WorkflowLaunchPayload } from '../../runner/launch.js'
import type { RequestInvariantLog } from '../../llm/request-invariant.js'

export type { WorkerToken }

export interface WorkerIpcIdentity extends WorkerToken {
  sessionId: string
}

export interface WorkerMcpTool {
  name: string
  serverName: string
  toolName: string
  definition: LLMToolDefinition
  sessionIdInjection?: Record<string, string>
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

export type InteractiveQuestionOpenMessage = WorkerIpcIdentity & {
  type: 'interactive.question.open'
  requestId: string
  callId: string
  question: string
  questionType: 'text' | 'confirm' | 'choice'
  options?: ChoiceOption[]
}

export type InteractivePathOpenMessage = WorkerIpcIdentity & {
  type: 'interactive.path.open'
  requestId: string
  callId: string
  paths: string[]
  tool: string
  workdir: string
  reason: 'outside_workdir' | 'sensitive_file' | 'both' | 'dangerous_command' | 'git_no_verify'
}

export type InteractiveOpenMessage = InteractiveQuestionOpenMessage | InteractivePathOpenMessage

export type InteractiveQuestionResponseMessage = WorkerIpcIdentity & {
  type: 'interactive.question.response'
  requestId: string
  callId: string
  answer: string
  skip: boolean
}

export type InteractivePathResponseMessage = WorkerIpcIdentity & {
  type: 'interactive.path.response'
  requestId: string
  callId: string
  approved: boolean
  alwaysAllow: boolean
}

export type InteractiveCancelledMessage = WorkerIpcIdentity & {
  type: 'interactive.cancelled'
  requestId: string
  callId: string
  kind: 'question' | 'path'
  reason: string
}

export type WorkerInteractiveResponseMessage =
  InteractiveQuestionResponseMessage | InteractivePathResponseMessage | InteractiveCancelledMessage

export type WorkerTurnCommand =
  { kind: 'chat' } | { kind: 'retry' } | { kind: 'compact' } | { kind: 'workflow'; payload: WorkflowLaunchPayload }

export type GatewayToWorkerMessage =
  | (WorkerToken & {
      type: 'start'
      sessionId: string
      config: Config
      mcpTools: WorkerMcpTool[]
      command: WorkerTurnCommand
    })
  | (WorkerToken & { type: 'abort' })
  | WorkerMcpResponseMessage
  | WorkerInteractiveResponseMessage

export type WorkerToGatewayMessage =
  | (WorkerToken & { type: 'ready'; pid: number })
  | (WorkerToken & { type: 'ws'; msg: ServerMessage })
  | (WorkerToken & { type: 'health'; data: DiagnosticsData })
  | (WorkerToken & { type: 'request.invariant'; data: RequestInvariantLog })
  | (WorkerToken & { type: 'done'; ok: boolean; error?: string })
  | McpRequestMessage
  | McpCancelMessage
  | InteractiveOpenMessage
