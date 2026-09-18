import type { ToolResult } from '../../shared/types.js'
import { serverT } from '../i18n.js'
import { logger } from '../utils/logger.js'
import { fromSerializedToolResult, normalizeHubBase } from './types.js'
import type { RemoteAgentInfo } from './types.js'

export interface HubClientConfig {
  hubUrl: string
  hubToken: string
  /**
   * Control-plane credential for the remote-agent control routes
   * (`/ra/execute`, `/ra/await`, `/ra/agents`). When the hub has a control
   * token configured (`AETHER_RA_CONTROL_TOKEN`), ONLY this credential is
   * accepted on those routes — the shared `hubToken` is rejected (401). When
   * unset here, the `hubToken` is used (backward-compatible default).
   */
  controlToken?: string | undefined
  callTimeoutMs?: number | undefined
}

/**
 * The remote-agent CONTROL routes (the RCE surface). These authenticate with
 * the control credential, not the shared hub Bearer, so a peer/agent holding
 * the hub token cannot enumerate or drive remote execution.
 */
const CONTROL_ROUTES = new Set(['/ra/execute', '/ra/await', '/ra/agents'])

/**
 * Client for the aether hub's headless-agent (remote-agent) API. The OpenFox
 * server uses this to enumerate registered headless-agents and to route tool
 * calls to them. All traffic goes through the hub (the single gateway); the
 * server never contacts a headless-agent directly.
 *
 * Security: the server authenticates to the hub as a principal (Bearer token).
 * Each execution call is scoped to (session, agent) by a hub-issued ephemeral
 * token, preventing cross-agent replay.
 */
export class HubClient {
  constructor(private readonly config: HubClientConfig) {}

  private async http<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.config.callTimeoutMs ?? 120_000)
    // Control routes authenticate with the control credential (when set);
    // everything else uses the shared hub Bearer.
    const token = CONTROL_ROUTES.has(path) && this.config.controlToken ? this.config.controlToken : this.config.hubToken
    try {
      const res = await fetch(new URL(path, normalizeHubBase(this.config.hubUrl)).toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T)
      if (!res.ok) {
        const msg = (json as { error?: string }).error ?? `HTTP ${res.status}`
        throw new HubClientError(msg, res.status)
      }
      return json
    } finally {
      clearTimeout(timeout)
    }
  }

  /** List headless-agents registered on the hub (with liveness). */
  async listAgents(): Promise<RemoteAgentInfo[]> {
    const res = await this.http<{ agents: Array<Record<string, unknown>> }>('GET', '/ra/agents')
    return res.agents.map((a) => ({
      peerId: String(a['peer_id'] ?? ''),
      title: String(a['title'] ?? ''),
      workdir: String(a['workdir'] ?? ''),
      hostname: String(a['hostname'] ?? ''),
      capabilities: Array.isArray(a['capabilities']) ? (a['capabilities'] as string[]) : [],
      alive: Boolean(a['alive']),
      lastActivity: Number(a['last_activity'] ?? 0),
    }))
  }

  /**
   * Route a tool call to a headless-agent via the hub. Returns the tool result
   * (shape-identical to a local result). Throws HubClientError on failure.
   *
   * `remote` is the target agent (peer id or title). It must be a known, alive
   * headless-agent; otherwise an error listing the available agents is thrown
   * (no silent fallback to local execution).
   */
  async executeTool(
    sessionId: string,
    remote: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const start = Date.now()
    const agents = await this.listAgents()
    const agent = agents.find((a) => a.peerId === remote || a.title === remote)
    if (!agent) {
      const available = agents.map((a) => `${a.title} (${a.peerId})`).join(', ') || 'none'
      throw new HubClientError(
        serverT(
          {
            en: 'Unknown remote agent "{{remote}}". Available agents: {{available}}',
            fr: 'Agent distant inconnu « {{remote}} ». Agents disponibles : {{available}}',
          },
          { remote, available },
        ),
        404,
      )
    }
    if (!agent.alive) {
      throw new HubClientError(
        serverT(
          {
            en: 'Remote agent "{{remote}}" is offline. Available agents: {{available}}',
            fr: 'L’agent distant « {{remote}} » est hors ligne. Agents disponibles : {{available}}',
          },
          { remote: agent.title, available: agents.map((a) => a.title).join(', ') || 'none' },
        ),
        503,
      )
    }

    const timeoutMs = this.config.callTimeoutMs ?? 120_000
    // 1. Queue the execution (hub signs the envelope + issues a scoped token).
    const exec = await this.http<{ request_id: string }>(
      'POST',
      '/ra/execute',
      {
        session_id: sessionId,
        agent_peer_id: agent.peerId,
        tool,
        args,
        timeout_ms: timeoutMs,
      },
      timeoutMs,
    )
    // 2. Await the result (long-poll; bounded by the same timeout).
    const result = await this.http<unknown>(
      'POST',
      '/ra/await',
      { request_id: exec.request_id, timeout_ms: timeoutMs },
      timeoutMs + 5_000,
    )
    const toolResult = fromSerializedToolResult(result)
    logger.debug('remote tool executed via hub', {
      tool,
      remote: agent.title,
      success: toolResult.success,
      durationMs: Date.now() - start,
    })
    return { ...toolResult, durationMs: Date.now() - start }
  }
}

export class HubClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HubClientError'
  }
}

let hubClient: HubClient | null = null

/**
 * Configure the hub client (called at server startup from global config).
 * Pass null to disable remote-agent routing.
 */
export function setHubClient(config: HubClientConfig | null): void {
  hubClient = config ? new HubClient(config) : null
}

export function getHubClient(): HubClient | null {
  return hubClient
}
