import type { ToolResult } from '../../shared/types.js'

/**
 * Metadata about a headless-agent (remote-agent) as known to the hub.
 */
export interface RemoteAgentInfo {
  peerId: string
  title: string
  workdir: string
  hostname: string
  capabilities: string[]
  alive: boolean
  lastActivity: number
}

/**
 * A signed execution envelope relayed by the hub to a headless-agent.
 * Wire format is snake_case (serde default on the hub). The agent verifies
 * `signature` (hub Ed25519) over the canonical payload before executing, and
 * executes exactly `JSON.parse(args_canonical)` — the signed string.
 */
export interface ExecutionEnvelope {
  request_id: string
  agent_peer_id: string
  session_id: string
  tool: string
  args: Record<string, unknown>
  /** Exact canonical JSON string the signature covers (executed verbatim). */
  args_canonical: string
  signature: string
  token: string
}

/**
 * A ToolResult serialized for transit over the hub.
 */
export interface SerializedToolResult {
  success: boolean
  output?: string
  error?: string
  durationMs: number
  truncated: boolean
}

export function toSerializedToolResult(result: ToolResult): SerializedToolResult {
  const out: SerializedToolResult = {
    success: result.success,
    durationMs: result.durationMs,
    truncated: result.truncated,
  }
  if (result.output !== undefined) out.output = result.output
  if (result.error !== undefined) out.error = result.error
  return out
}

export function fromSerializedToolResult(data: unknown): ToolResult {
  if (data && typeof data === 'object') {
    const r = data as Partial<ToolResult>
    return {
      success: Boolean(r.success),
      ...(typeof r.output === 'string' ? { output: r.output } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
      truncated: Boolean(r.truncated),
    }
  }
  return { success: false, error: 'Malformed remote tool result', durationMs: 0, truncated: false }
}

/**
 * Normalize a hub URL to its base (root) for building `/ra/*` and `/mcp`
 * paths. The hub advertises `http://host:port/mcp`; the remote-agent routes
 * live at the root, so strip a trailing `/mcp` (and any trailing slash).
 */
export function normalizeHubBase(hubUrl: string): string {
  let base = hubUrl.trim()
  // Strip a trailing /mcp (and any trailing slashes), repeating in case of
  // both (e.g. "http://h:1/mcp/").
  for (;;) {
    const stripped = base.replace(/\/+$/, '')
    if (stripped.endsWith('/mcp')) {
      base = stripped.slice(0, -'/mcp'.length)
      continue
    }
    base = stripped
    break
  }
  return base
}
