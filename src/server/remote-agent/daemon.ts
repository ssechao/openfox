import express from 'express'
import { createServer } from 'node:http'
import { hostname as osHostname } from 'node:os'
import { getBuiltInTools } from '../tools/index.js'
import type { Tool, ToolContext } from '../tools/types.js'
import { McpManager } from '../mcp/manager.js'
import type { McpServerConfig } from '../mcp/types.js'
import { createMcpTools } from '../mcp/tool-adapter.js'
import { logger } from '../utils/logger.js'
import {
  AgentIdentity,
  verifyHubSignature,
  canonicalEnvelopePayload,
  canonicalCapabilities,
  enrollPayload,
  agentProofPayload,
  heartbeatProofExtra,
  resultProofExtra,
  freshNonce,
} from './identity.js'
import { createRemoteAgentContext, CONTROL_PLANE_TOOLS, MinimalSessionManager } from './context.js'
import { toSerializedToolResult, normalizeHubBase } from './types.js'
import type { ExecutionEnvelope } from './types.js'

export interface DaemonOptions {
  workdir: string
  hubUrl: string
  hubToken: string
  name?: string | undefined
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number
  /** Per-call execution timeout in ms (default 120000). */
  callTimeoutMs?: number
  /** Heartbeat interval in ms (default 15000). */
  heartbeatIntervalMs?: number
  /** MCP servers config (record of name -> mcpServerSchema) to run on the daemon. */
  mcpServers?: Record<string, unknown> | undefined
}

/**
 * The headless-agent daemon. It has no LLM, no UI, no session server. It:
 *  - generates an Ed25519 identity (private key stays local),
 *  - enrolls with the hub (proving key possession by signing a nonce),
 *  - heartbeats to stay enumerable,
 *  - polls the hub for signed execution envelopes, verifies the hub signature,
 *    executes the tool locally (anchored on --workdir), and posts the result,
 *  - exposes GET /healthz for operators.
 *
 * It is never contacted directly by anyone — all traffic is outbound to the
 * hub, so the hub is the single gateway (the OpenFox server never reaches the
 * agent directly).
 */
export class RemoteAgentDaemon {
  private identity: AgentIdentity
  private tools: Tool[]
  private mcpManager: McpManager | null = null
  private mcpStatus: Record<string, string> = {}
  private hubPublicKeyB64: string | null = null
  /** The hub's startup epoch (received at enrollment). Bound into every
   * agent-proof; a hub restart changes it, so the daemon re-enrolls to pick
   * up the new epoch (a captured proof from the previous process is invalid). */
  private _hubEpoch: string | null = null
  private peerId: string | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private inFlight = false
  private stopped = false
  private httpServer: ReturnType<typeof createServer> | null = null
  /**
   * Persistent per-session stubs so per-session state (the read-file cache that
   * edit_file validates against) survives across tool calls — mirroring the
   * real SessionManager, which is long-lived per session.
   */
  private sessionStubs = new Map<string, MinimalSessionManager>()

  constructor(private readonly opts: DaemonOptions) {
    this.identity = AgentIdentity.generate()
    // Expose the real built-in tools minus the control-plane tools that need a
    // full session server.
    this.tools = getBuiltInTools().filter((t) => !CONTROL_PLANE_TOOLS.has(t.name))
  }

  get publicWorkdir(): string {
    return this.opts.workdir
  }

  /** The daemon's Ed25519 public key (base64url). Exposed for tests that
   * need to impersonate / verify the agent's proofs. */
  get publicKeyB64(): string {
    return this.identity.publicKeyB64
  }

  /** The hub's startup epoch (received at enrollment). Exposed for tests that
   * must build agent-proof payloads the way the hub reconstructs them. */
  get hubEpoch(): string {
    return this._hubEpoch ?? ''
  }

  /** Sign an agent proof (op, nonce, epoch, extra) with the daemon's private
   * key. Exposed for tests (e.g. cross-agent impersonation). */
  signAgentProof(op: string, nonce: string, extra: string | Buffer): string {
    return this.identity.sign(agentProofPayload(op, this.identity.publicKeyB64, nonce, this._hubEpoch ?? '', extra))
  }

  /** Sign an already-built payload with the daemon's private key. Exposed for
   * tests that build a custom proof payload (e.g. Unicode metadata) and need
   * the daemon's key to sign it. */
  identitySign(payload: Buffer): string {
    return this.identity.sign(payload)
  }

  get toolNames(): string[] {
    return this.tools.map((t) => t.name)
  }

  /** Start the daemon: set up MCP, enroll, then begin polling + heartbeating. */
  async start(): Promise<void> {
    await this.setupMcpServers()
    await this.enroll()
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((e) =>
        logger.warn('heartbeat failed', { error: e instanceof Error ? e.message : String(e) }),
      )
    }, this.opts.heartbeatIntervalMs ?? 15_000)
    this.pollTimer = setInterval(() => {
      this.pollLoop().catch((e) => logger.warn('poll failed', { error: e instanceof Error ? e.message : String(e) }))
    }, this.opts.pollIntervalMs ?? 2_000)
    this.startHealthz()
    logger.info('remote-agent daemon started', {
      workdir: this.opts.workdir,
      peerId: this.peerId,
      tools: this.toolNames,
      mcpServers: this.mcpStatus,
    })
  }

  /**
   * Connect the daemon's own MCP servers (if any) and expose their tools
   * remotely. A server that fails to connect is marked `error` and its tools
   * are simply not exposed — it never crashes the daemon.
   */
  private async setupMcpServers(): Promise<void> {
    const configs = this.opts.mcpServers
    if (!configs || Object.keys(configs).length === 0) return
    this.mcpManager = new McpManager()
    for (const [name, raw] of Object.entries(configs)) {
      const config = raw as McpServerConfig
      try {
        await this.mcpManager.addServer(name, config)
        this.mcpStatus[name] = 'connected'
      } catch (error) {
        this.mcpStatus[name] = 'error'
        logger.warn('remote-agent MCP server failed to connect', {
          name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // Wrap the connected MCP tools and add them to the exposed registry.
    const mcpTools = createMcpTools(this.mcpManager)
    this.tools.push(...mcpTools)
    if (mcpTools.length > 0) {
      logger.info('remote-agent exposing MCP tools', { count: mcpTools.length, tools: mcpTools.map((t) => t.name) })
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.mcpManager) {
      await this.mcpManager.disconnectAll().catch(() => undefined)
    }
    if (this.httpServer) await new Promise<void>((r) => this.httpServer!.close(() => r()))
    logger.info('remote-agent daemon stopped')
  }

  private async http<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, normalizeHubBase(this.opts.hubUrl)).toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.hubToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? null : JSON.stringify(body),
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const msg = (json as { error?: string }).error ?? `HTTP ${res.status}`
      const err = new Error(`${method} ${path} -> ${res.status}: ${msg}`)
      ;(err as { status?: number }).status = res.status
      throw err
    }
    return json as T
  }

  private capabilities(): string[] {
    return this.toolNames
  }

  private async enroll(): Promise<void> {
    // A fresh, timestamped, unguessable nonce (randomBytes, not Math.random).
    // The signature covers the FULL enrollment payload (title, key, workdir,
    // hostname, capabilities + nonce), so a captured enrollment cannot be
    // replayed with modified metadata; the hub also consumes the nonce
    // (single-use) and rejects it outside the replay window.
    const nonce = freshNonce()
    const caps = this.capabilities()
    const payload = enrollPayload(
      this.opts.name ?? this.opts.workdir,
      this.identity.publicKeyB64,
      this.opts.workdir,
      this.hostname(),
      canonicalCapabilities(caps),
      nonce,
    )
    const signature = this.identity.sign(payload)
    const res = await this.http<{ peer_id: string; hub_public_key: string; hub_epoch: string }>('POST', '/ra/enroll', {
      title: this.opts.name ?? this.opts.workdir,
      public_key: this.identity.publicKeyB64,
      nonce,
      signature,
      workdir: this.opts.workdir,
      hostname: this.hostname(),
      capabilities: caps,
    })
    this.peerId = res.peer_id
    this.hubPublicKeyB64 = res.hub_public_key
    this._hubEpoch = res.hub_epoch
  }

  private async heartbeat(): Promise<void> {
    // Agent-signed proof (fresh timestamped nonce) so only the key holder can
    // refresh this agent's liveness. The proof binds the FULL mutable body
    // (title, workdir, hostname, canonical capabilities) AND the hub's
    // startup epoch, so a captured heartbeat cannot be replayed with modified
    // metadata and is invalid after a hub restart (epoch changed).
    const nonce = freshNonce()
    const caps = this.capabilities()
    const title = this.opts.name ?? this.opts.workdir
    const extra = heartbeatProofExtra(title, this.opts.workdir, this.hostname(), canonicalCapabilities(caps))
    const payload = agentProofPayload('heartbeat', this.identity.publicKeyB64, nonce, this._hubEpoch ?? '', extra)
    try {
      await this.http('POST', '/ra/heartbeat', {
        public_key: this.identity.publicKeyB64,
        title,
        workdir: this.opts.workdir,
        hostname: this.hostname(),
        capabilities: caps,
        nonce,
        signature: this.identity.sign(payload),
      })
    } catch (error) {
      // 401 = the hub no longer accepts our proof: most likely the hub
      // RESTARTED (new epoch) and our consumed-nonce cache / epoch are stale.
      // Re-enroll to pick up the new epoch + public key, then retry once.
      if ((error as { status?: number }).status === 401) {
        logger.warn('heartbeat rejected (401) — re-enrolling to sync hub epoch')
        await this.enroll()
        const retryNonce = freshNonce()
        const retryPayload = agentProofPayload(
          'heartbeat',
          this.identity.publicKeyB64,
          retryNonce,
          this._hubEpoch ?? '',
          extra,
        )
        await this.http('POST', '/ra/heartbeat', {
          public_key: this.identity.publicKeyB64,
          title,
          workdir: this.opts.workdir,
          hostname: this.hostname(),
          capabilities: caps,
          nonce: retryNonce,
          signature: this.identity.sign(retryPayload),
        })
        return
      }
      throw error
    }
  }

  private hostname(): string {
    try {
      return osHostname()
    } catch {
      return 'unknown'
    }
  }

  private async pollLoop(): Promise<void> {
    if (this.inFlight || this.stopped) return
    // Hold the guard across the poll HTTP call too: the hub only removes an
    // envelope from the queue on the result ack, so two overlapping polls
    // would otherwise both fetch the same envelope and execute it twice.
    this.inFlight = true
    try {
      // Agent-signed proof (fresh timestamped nonce + hub epoch): only the
      // key holder may drain this agent's queue.
      const nonce = freshNonce()
      const payload = agentProofPayload('poll', this.identity.publicKeyB64, nonce, this._hubEpoch ?? '', '')
      let res: { envelope: ExecutionEnvelope | null }
      try {
        res = await this.http<{ envelope: ExecutionEnvelope | null }>('POST', '/ra/poll', {
          public_key: this.identity.publicKeyB64,
          nonce,
          signature: this.identity.sign(payload),
        })
      } catch (error) {
        // 401 = the hub no longer accepts our proof: the hub most likely
        // RESTARTED (new epoch). Re-enroll to pick up the new epoch, then
        // retry the poll once.
        if ((error as { status?: number }).status === 401) {
          logger.warn('poll rejected (401) — re-enrolling to sync hub epoch')
          await this.enroll()
          const retryNonce = freshNonce()
          const retryPayload = agentProofPayload(
            'poll',
            this.identity.publicKeyB64,
            retryNonce,
            this._hubEpoch ?? '',
            '',
          )
          res = await this.http<{ envelope: ExecutionEnvelope | null }>('POST', '/ra/poll', {
            public_key: this.identity.publicKeyB64,
            nonce: retryNonce,
            signature: this.identity.sign(retryPayload),
          })
        } else {
          throw error
        }
      }
      if (!res.envelope) return
      await this.handleEnvelope(res.envelope)
    } finally {
      this.inFlight = false
    }
  }

  private async handleEnvelope(env: ExecutionEnvelope): Promise<void> {
    // Verify the hub signature before executing anything.
    if (!this.hubPublicKeyB64) {
      await this.postResult(
        env.request_id,
        { success: false, error: 'not enrolled', durationMs: 0, truncated: false },
        env.token,
      )
      return
    }
    const payload = canonicalEnvelopePayload(
      env.request_id,
      env.agent_peer_id,
      env.session_id,
      env.tool,
      env.args_canonical,
    )
    if (!verifyHubSignature(this.hubPublicKeyB64, payload, env.signature)) {
      logger.warn('rejecting envelope with invalid hub signature', { requestId: env.request_id })
      await this.postResult(
        env.request_id,
        {
          success: false,
          error: 'invalid hub signature',
          durationMs: 0,
          truncated: false,
        },
        env.token,
      )
      return
    }
    // Execute exactly the signed canonical args (not the redundant `args`).
    let args: Record<string, unknown>
    try {
      args = JSON.parse(env.args_canonical) as Record<string, unknown>
    } catch {
      await this.postResult(
        env.request_id,
        {
          success: false,
          error: 'malformed signed args',
          durationMs: 0,
          truncated: false,
        },
        env.token,
      )
      return
    }
    const tool = this.tools.find((t) => t.name === env.tool)
    if (!tool) {
      await this.postResult(
        env.request_id,
        {
          success: false,
          error: `Unknown tool: ${env.tool}. Available: ${this.toolNames.join(', ')}`,
          durationMs: 0,
          truncated: false,
        },
        env.token,
      )
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.opts.callTimeoutMs ?? 120_000)
    // Reuse the per-session stub so the read-file cache persists across calls
    // (edit_file on an existing file requires a prior read, like local mode).
    const stub = this.sessionStubs.get(env.session_id) ?? new MinimalSessionManager(this.opts.workdir)
    this.sessionStubs.set(env.session_id, stub)
    const context: ToolContext = createRemoteAgentContext({
      workdir: this.opts.workdir,
      sessionId: env.session_id,
      signal: controller.signal,
      timeoutMs: this.opts.callTimeoutMs ?? 120_000,
      onProgress: (m) => logger.debug('remote-agent progress', { tool: env.tool, m }),
      sessionManager: stub as unknown as ToolContext['sessionManager'],
    })
    const start = Date.now()
    try {
      const result = await tool.execute(args, context)
      await this.postResult(env.request_id, toSerializedToolResult(result), env.token)
    } catch (error) {
      const result = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - start,
        truncated: false,
      }
      await this.postResult(env.request_id, result, env.token)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async postResult(requestId: string, result: unknown, token?: string): Promise<void> {
    // Retry a few times: the hub only removes the envelope from the queue when
    // the result is acknowledged, so a failed submission would otherwise lead
    // to a re-delivered (and re-executed) envelope on the next poll. The hub
    // treats a retried submission of an already-resolved request as idempotent.
    // Each attempt presents a FRESH timestamped agent proof (the hub consumes
    // the nonce); the proof binds request_id + token + the canonical result
    // JSON, so none of them can be tampered with after signing. The hub
    // stores/delivers `resultCanonical` — exactly the signed string.
    const resultCanonical = JSON.stringify(result)
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nonce = freshNonce()
        const extra = resultProofExtra(requestId, token ?? '', resultCanonical)
        const payload = agentProofPayload('result', this.identity.publicKeyB64, nonce, this._hubEpoch ?? '', extra)
        await this.http('POST', '/ra/result', {
          public_key: this.identity.publicKeyB64,
          request_id: requestId,
          nonce,
          signature: this.identity.sign(payload),
          ...(token ? { token } : {}),
          result_canonical: resultCanonical,
        })
        return
      } catch (error) {
        lastError = error
        // 401 = the hub no longer accepts our proof (most likely a hub
        // RESTART changed the epoch). Re-enroll to pick up the new epoch,
        // then retry.
        if ((error as { status?: number }).status === 401) {
          logger.warn('result rejected (401) — re-enrolling to sync hub epoch')
          await this.enroll().catch(() => undefined)
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('failed to post execution result')
  }

  private startHealthz(): void {
    const app = express()
    app.use(express.json())
    app.get('/healthz', (_req, res) => {
      res.json({
        ok: true,
        workdir: this.opts.workdir,
        peerId: this.peerId,
        tools: this.toolNames,
        mcpServers: this.mcpStatus,
      })
    })
    // Dynamic port (0) so multiple daemons can coexist; healthz is an operator
    // convenience and must never crash the daemon if the port is unavailable.
    this.httpServer = createServer(app)
    this.httpServer.on('error', (err) => {
      logger.warn('remote-agent healthz failed to bind', { error: err instanceof Error ? err.message : String(err) })
    })
    this.httpServer.listen(0, '127.0.0.1', () => {
      const addr = this.httpServer?.address()
      if (addr && typeof addr === 'object') {
        logger.info('remote-agent healthz listening', { port: addr.port })
      }
    })
  }
}
