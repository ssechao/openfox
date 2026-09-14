import { randomUUID } from 'node:crypto'
import type { ToolContext } from '../tools/types.js'
import type { SessionManager } from '../session/manager.js'

/**
 * Tools that require a full OpenFox session server (LLM, DB, EventStore,
 * interactive UI) and therefore cannot run inside a headless-agent daemon.
 * The daemon does not expose them — it simply omits them from its registry.
 */
export const CONTROL_PLANE_TOOLS: ReadonlySet<string> = new Set([
  'ask_user',
  'session_metadata',
  'mcp_config',
  'call_sub_agent',
  'workspace',
  'project_tasks',
  'step_done',
  'remote_agents',
])

/**
 * Minimal SessionManager stub for tools that only call workdir resolution and
 * the read-file cache. A headless-agent has no real session, so the cache is
 * in-memory and per-daemon.
 */
export class MinimalSessionManager {
  private readFiles = new Map<string, { hash: string; readAt: string }>()

  getEffectiveWorkdir(_sessionId: string): string {
    return this.workdir
  }

  getProjectWorkdir(_sessionId: string): string {
    return this.workdir
  }

  getReadFiles(_sessionId: string): Record<string, { hash: string; readAt: string }> {
    return Object.fromEntries(this.readFiles)
  }

  recordFileRead(_sessionId: string, filePath: string, contentHash: string): void {
    this.readFiles.set(filePath, { hash: contentHash, readAt: new Date().toISOString() })
  }

  updateFileHash(_sessionId: string, filePath: string, contentHash: string): void {
    this.readFiles.set(filePath, { hash: contentHash, readAt: new Date().toISOString() })
  }

  constructor(readonly workdir: string) {}
}

export interface RemoteAgentContextOptions {
  workdir: string
  /** Per-call timeout in ms (default 120s). */
  timeoutMs?: number
  /** Log progress messages (shell output, etc.). */
  onProgress?: (message: string) => void
  /** Abort signal for the current call. */
  signal?: AbortSignal
  /** Session id (stable per daemon, or per call). */
  sessionId?: string
  /**
   * A persistent SessionManager stub. When provided (and matching the
   * session), it is reused so per-session state (e.g. the read-file cache that
   * edit_file validates against) survives across tool calls — mirroring the
   * real SessionManager. Absent → a fresh stub is created for this call.
   */
  sessionManager?: SessionManager
}

/**
 * Build a minimal-but-valid ToolContext for executing built-in tools inside a
 * headless-agent daemon.
 *
 * - `dangerLevel: 'dangerous'`: the daemon has no UI client, so path/shell
 *   confirmations would fail-closed. The security boundary is "you connected
 *   to this daemon" (hub enrollment + signed envelopes), not per-path.
 * - No LLM / providerManager / EventStore / DB.
 */
export function createRemoteAgentContext(opts: RemoteAgentContextOptions): ToolContext {
  const sessionId = opts.sessionId ?? 'remote-agent'
  const stub = (opts.sessionManager as MinimalSessionManager | undefined) ?? new MinimalSessionManager(opts.workdir)
  return {
    workdir: opts.workdir,
    sessionId,
    sessionManager: stub as unknown as SessionManager,
    dangerLevel: 'dangerous',
    signal: opts.signal,
    onProgress: opts.onProgress,
    agentTimeout: opts.timeoutMs ?? 120_000,
  }
}

/**
 * A stable per-daemon session id (used as the ToolContext.sessionId).
 */
export function newDaemonSessionId(): string {
  return randomUUID()
}
