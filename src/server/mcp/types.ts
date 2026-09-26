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
  /**
   * Stdio only. When true, OpenFox spawns one dedicated child process of this
   * server per OpenFox session instead of a single shared one, and hands each
   * child its session id in `OPENFOX_SESSION_ID`. The child then owns exactly
   * one identity on the far side (for Aether: one hub peer per session), so a
   * call issued by session B is attributed to B and never to a sibling. No
   * shared client is connected for a per-session server; the tool catalogue
   * comes from `cachedTools` and is (re)seeded from the first session client.
   */
  perSession?: boolean
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

export interface McpManagerOptions {
  onServersChanged?: () => void
  onToolsDiscovered?: (serverName: string, tools: CachedToolInfo[]) => void
}

export interface McpToolDefinition extends LLMToolDefinition {
  serverName: string
}
