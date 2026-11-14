import type { LLMToolDefinition } from '../llm/types.js'

export interface CachedToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  estimatedTokens: number
}

export interface McpServerConfig {
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Authorize against the server with OAuth instead of a static credential. HTTP transport only. */
  oauth?: boolean
  disabledTools?: string[]
  cachedTools?: CachedToolInfo[]
  timeout?: number
  disabled?: boolean
  sessionIdInjection?: Record<string, string>
}

export interface McpServerState {
  name: string
  config: McpServerConfig
  status: 'connected' | 'disconnected' | 'error'
  tools: McpToolInfo[]
  estimatedTokens: number
  error?: string
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  enabled: boolean
  estimatedTokens: number
}

export interface OpenFoxCallerIdentityIssueInput {
  callerSessionId: string
  toolName: string
  targetSessionId: string
}

export interface OpenFoxEndpointBindingInput {
  kind: 'direct' | 'proxy'
  serverName: string
  url?: string
  targetServerName?: string
}

export interface OpenFoxCallerIdentityGateway {
  issueProof(input: OpenFoxCallerIdentityIssueInput): string
  isOwnEndpoint(input: OpenFoxEndpointBindingInput): boolean
}

export interface McpManagerOptions {
  onServersChanged?: () => void
  onToolsDiscovered?: (serverName: string, tools: CachedToolInfo[]) => void
  openFoxCallerIdentity?: OpenFoxCallerIdentityGateway
}

export interface McpToolDefinition extends LLMToolDefinition {
  serverName: string
}
