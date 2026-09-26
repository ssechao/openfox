import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpServerState, McpToolInfo, McpManagerOptions, CachedToolInfo } from './types.js'
import type { LLMToolDefinition } from '../llm/types.js'
import { logger } from '../utils/logger.js'
import { McpOAuthProvider } from './oauth-provider.js'
import { readMcpOAuthEntry } from './oauth-store.js'
import { sanitizeToolSchema } from '../llm/schema-sanitizer.js'

/**
 * The server may answer up to a polling interval after its own deadline, so the SDK request
 * timeout needs headroom beyond the wait a tool asks for.
 */
const TOOL_CALL_TIMEOUT_MARGIN_SECONDS = 30
/** Preserves the SDK's implicit 60s default when neither config nor tool arg sets a timeout. */
const TOOL_CALL_TIMEOUT_DEFAULT_SECONDS = 60
const TOOL_CALL_TIMEOUT_MAX_SECONDS = 3600

/**
 * Effective SDK request timeout in seconds.
 *
 * Assumption (accepted tradeoff): any numeric `timeout` tool argument is treated as a wait
 * duration in SECONDS for every MCP server. This only ever extends the timeout (never
 * shortens it) and is bounded by TOOL_CALL_TIMEOUT_MAX_SECONDS, so a third-party tool that
 * uses `timeout` in a different unit can at most delay a failure — it cannot lower a
 * configured timeout.
 *
 * The per-server config timeout is never lowered: neither the tool arg nor the cap can
 * shorten it (a server configured above the cap keeps its full configured timeout).
 */
function effectiveRequestTimeoutSeconds(configTimeout: number | undefined, args: Record<string, unknown>): number {
  const configSeconds =
    typeof configTimeout === 'number' && Number.isFinite(configTimeout) && configTimeout > 0 ? configTimeout : 0
  const arg = args['timeout']
  const argSeconds = typeof arg === 'number' && Number.isFinite(arg) && arg > 0 ? arg : 0
  const argCandidate =
    argSeconds > 0 ? Math.min(argSeconds + TOOL_CALL_TIMEOUT_MARGIN_SECONDS, TOOL_CALL_TIMEOUT_MAX_SECONDS) : 0
  const effective = Math.max(configSeconds, argCandidate)
  return effective > 0 ? effective : TOOL_CALL_TIMEOUT_DEFAULT_SECONDS
}

/**
 * The SDK merges requestInit headers after the ones it derives from the auth provider, so a static
 * Authorization header would silently shadow the OAuth token and every request would look unauthorized.
 */
function withoutAuthorizationHeader(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  const kept = Object.entries(headers).filter(([key]) => key.trim().toLowerCase() !== 'authorization')
  if (kept.length === Object.keys(headers).length) return headers
  return Object.fromEntries(kept)
}

/** Rough token estimate: ~4 chars per token for JSON-serialized tool definitions */
export function estimateToolTokens(
  toolName: string,
  description: string | undefined,
  inputSchema: Record<string, unknown>,
): number {
  const def: LLMToolDefinition = {
    type: 'function',
    function: { name: toolName, description: description ?? '', parameters: inputSchema },
  }
  return Math.ceil(JSON.stringify(def).length / 4)
}

interface ServerEntry {
  config: McpServerConfig
  client: Client | undefined
  transport: Transport | null
  state: McpServerState
  /**
   * Bumped on every disconnect. A per-session spawn captures it before
   * connecting and refuses to publish a stale child, which is what makes a
   * disconnect that lands mid-connect still reap the process it raced.
   */
  generation: number
}

/** NUL keeps the two halves unambiguous: neither id nor server name can contain it. */
function sessionConnectKey(sessionId: string, serverName: string): string {
  return `${sessionId}\u0000${serverName}`
}

export class McpManager {
  private servers = new Map<string, ServerEntry>()
  private onServersChanged: (() => void) | undefined
  private onToolsDiscovered: ((serverName: string, tools: CachedToolInfo[]) => void) | undefined
  /**
   * One client per (sessionId, serverName) for per-session servers — see
   * `McpServerConfig.perSession`. A per-session server has no shared client
   * at all: this map is its only connection, and each entry is spawned with
   * that session's id in the child's environment.
   */
  private sessionClients = new Map<string, Map<string, Client>>()
  /**
   * In-flight connections, keyed by `(sessionId, serverName)`. Two concurrent
   * `ensureSessionClients` for the same session must share one attempt: storing
   * the client only after `connect()` resolved would let both spawn a child and
   * leave the loser unreferenced — an orphan process, and on the Aether side a
   * ghost peer that no release can ever reap.
   */
  private sessionConnects = new Map<string, Promise<Client>>()

  constructor(options?: McpManagerOptions) {
    this.onServersChanged = options?.onServersChanged
    this.onToolsDiscovered = options?.onToolsDiscovered
  }

  async addServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`MCP server '${name}' already exists`)
    }
    const state: McpServerState = { name, config, status: 'disconnected', tools: [], estimatedTokens: 0 }
    this.servers.set(name, { config, client: undefined, transport: null, state, generation: 0 })
    await this.connectServer(name)
  }

  removeServer(name: string): void {
    const entry = this.servers.get(name)
    if (entry) {
      this.disconnectServer(name)
      this.servers.delete(name)
    }
  }

  async connectServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return

    // A per-session server never gets a shared client: its connections are
    // spawned one per OpenFox session (see `ensureSessionClients`). Its
    // catalogue comes from the persisted cache, and is (re)seeded by the
    // first session client, so there is nothing to connect here.
    if (entry.config.perSession) {
      this.applyCachedTools(name, entry)
      return
    }

    try {
      await this.disconnectServer(name)

      const client = new Client({ name: 'openfox-mcp', version: '2.0.0' })
      let transport: Transport | null = null

      if (entry.config.transport === 'stdio') {
        if (!entry.config.command) throw new Error('command is required for stdio transport')
        const stdioTransport = new StdioClientTransport({
          command: entry.config.command,
          ...(entry.config.args ? { args: entry.config.args } : {}),
          ...(entry.config.env ? { env: entry.config.env } : {}),
          stderr: 'pipe',
        })
        // Discard diagnostics continuously so a full stderr pipe cannot block the server.
        const stderrStream = stdioTransport.stderr
        if (stderrStream instanceof Readable) stderrStream.resume()
        transport = stdioTransport
      } else if (entry.config.transport === 'http') {
        if (!entry.config.url) throw new Error('url is required for http transport')
        const httpOpts: StreamableHTTPClientTransportOptions = {}
        const headers = entry.config.oauth ? withoutAuthorizationHeader(entry.config.headers) : entry.config.headers
        if (headers) {
          httpOpts.requestInit = { headers }
        }
        if (entry.config.oauth) {
          // A connection attempt is a probe, never an authorization: it must not touch stored
          // credentials, or it would clobber an authorization the user has pending in a browser.
          // But if tokens are already stored, the real provider must be used so they get attached.
          const stored = await readMcpOAuthEntry(name, entry.config.url)
          httpOpts.authProvider = stored?.tokens
            ? new McpOAuthProvider(name, entry.config.url)
            : McpOAuthProvider.forBackgroundProbe(name, entry.config.url)
        }
        transport = new StreamableHTTPClientTransport(new URL(entry.config.url), httpOpts) as unknown as Transport
      } else {
        throw new Error(`Unsupported transport: ${entry.config.transport}`)
      }

      if (!transport) throw new Error('Failed to create transport')

      // Intercept onmessage to remove outputSchema from tool definitions.
      // Some servers (like Stitch) include outputSchema with broken references (e.g. $defs/ScreenInstance),
      // which causes AJV validation in the MCP SDK to crash and fail to load any tools.
      let sdkOnMessage: ((message: unknown) => void) | undefined = undefined
      Object.defineProperty(transport, 'onmessage', {
        get() {
          return sdkOnMessage
        },
        set(fn) {
          sdkOnMessage = (message: unknown) => {
            const msg = message as { result?: { tools?: Array<{ outputSchema?: unknown }> } }
            if (msg && msg.result && Array.isArray(msg.result.tools)) {
              for (const tool of msg.result.tools) {
                if (tool && tool.outputSchema) {
                  delete tool.outputSchema
                }
              }
            }
            fn?.(message)
          }
        },
        configurable: true,
      })

      await client.connect(transport)

      const { tools: mcpTools } = await client.listTools()

      const { tools, estimatedTokens } = this.describeTools(entry, mcpTools)

      entry.client = client
      entry.transport = transport
      entry.state = { name, config: entry.config, status: 'connected', tools, estimatedTokens }

      this.cacheDiscoveredTools(name, entry, tools)

      logger.info('Connected to MCP server', { name, toolCount: tools.length })
      this.onServersChanged?.()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to connect MCP server', { name, error: msg })

      // Fall back to cached tools if available
      const cachedTools = entry.config.cachedTools
      if (cachedTools && cachedTools.length > 0) {
        const { tools, estimatedTokens } = this.describeTools(entry, cachedTools)
        entry.state = { name, config: entry.config, status: 'error', tools, estimatedTokens, error: msg }
      } else {
        entry.state = { name, config: entry.config, status: 'error', tools: [], estimatedTokens: 0, error: msg }
      }
      this.onServersChanged?.()
    }
  }

  /**
   * Seed a per-session server's state from its persisted cache, so its tool
   * definitions are available before any session client has connected.
   */
  private applyCachedTools(name: string, entry: ServerEntry): void {
    const { tools, estimatedTokens } = this.describeTools(entry, entry.config.cachedTools ?? [])
    entry.state = {
      name,
      config: entry.config,
      status: tools.length > 0 ? 'connected' : 'disconnected',
      tools,
      estimatedTokens,
    }
    this.onServersChanged?.()
  }

  /**
   * Project a catalogue onto `McpToolInfo`, applying the server's disabled set.
   * Cached entries already carry a token estimate; live ones are measured here.
   */
  private describeTools(
    entry: ServerEntry,
    source: ReadonlyArray<{
      name: string
      description?: string | undefined
      inputSchema: unknown
      estimatedTokens?: number | undefined
    }>,
  ): { tools: McpToolInfo[]; estimatedTokens: number } {
    const disabledSet = new Set(entry.config.disabledTools ?? [])
    const tools: McpToolInfo[] = source.map((t) => {
      const inputSchema = t.inputSchema as Record<string, unknown>
      return {
        name: t.name,
        description: t.description ?? '',
        inputSchema,
        enabled: !disabledSet.has(t.name),
        estimatedTokens: t.estimatedTokens ?? estimateToolTokens(t.name, t.description, inputSchema),
      }
    })
    const estimatedTokens = tools.filter((t) => t.enabled).reduce((sum, t) => sum + t.estimatedTokens, 0)
    return { tools, estimatedTokens }
  }

  /** Persist a freshly discovered catalogue, without the per-server enabled state. */
  private cacheDiscoveredTools(name: string, entry: ServerEntry, tools: McpToolInfo[]): void {
    const cachedTools: CachedToolInfo[] = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
      estimatedTokens: t.estimatedTokens,
    }))
    entry.config.cachedTools = cachedTools
    this.onToolsDiscovered?.(name, cachedTools)
  }

  private perSessionServerNames(): string[] {
    return [...this.servers.entries()]
      .filter(([, e]) => e.config.perSession === true && !e.config.disabled)
      .map(([name]) => name)
  }

  /** Names of per-session servers with a live client for `sessionId`. */
  sessionServerNames(sessionId: string): string[] {
    const bySession = this.sessionClients.get(sessionId)
    return bySession ? [...bySession.keys()] : []
  }

  /**
   * Ensure one dedicated child process exists for `sessionId` on every
   * per-session server. Idempotent: an already-live client is reused, so a
   * duplicate `session_created` never spawns a second process. Failures are
   * logged and swallowed — a missing child degrades that session to "no
   * Aether peer", never a crash.
   */
  async ensureSessionClients(sessionId: string): Promise<void> {
    for (const name of this.perSessionServerNames()) {
      try {
        await this.connectSessionClient(name, sessionId)
      } catch (err) {
        logger.warn('Failed to start per-session MCP client', {
          name,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Spawn (or reuse) the child for `(serverName, sessionId)`. The child's
   * environment carries `OPENFOX_SESSION_ID`, which is what lets it own
   * exactly one identity on the far side.
   */
  private async connectSessionClient(serverName: string, sessionId: string): Promise<Client> {
    const entry = this.servers.get(serverName)
    if (!entry) throw new Error(`MCP server '${serverName}' not found`)
    if (!entry.config.perSession) throw new Error(`MCP server '${serverName}' is not per-session`)
    if (entry.config.transport !== 'stdio') {
      throw new Error(`per-session MCP server '${serverName}' must use the stdio transport`)
    }
    if (!entry.config.command) throw new Error(`command is required for stdio transport`)

    let bySession = this.sessionClients.get(sessionId)
    if (!bySession) {
      bySession = new Map<string, Client>()
      this.sessionClients.set(sessionId, bySession)
    }
    const existing = bySession.get(serverName)
    if (existing?.transport) return existing

    const key = sessionConnectKey(sessionId, serverName)
    const pending = this.sessionConnects.get(key)
    if (pending) return pending

    const attempt = this.spawnSessionClient(
      serverName,
      sessionId,
      entry,
      entry.generation,
      entry.config.command,
      bySession,
    )
    this.sessionConnects.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.sessionConnects.delete(key)
    }
  }

  /**
   * The spawn half of `connectSessionClient`, run at most once per
   * `(sessionId, serverName)` thanks to the in-flight map.
   */
  private async spawnSessionClient(
    serverName: string,
    sessionId: string,
    entry: ServerEntry,
    generation: number,
    command: string,
    bySession: Map<string, Client>,
  ): Promise<Client> {
    const client = new Client({ name: `openfox-mcp/${serverName}/${sessionId}`, version: '2.0.0' })
    const transport = new StdioClientTransport({
      command,
      ...(entry.config.args ? { args: entry.config.args } : {}),
      env: { ...(entry.config.env ?? {}), OPENFOX_SESSION_ID: sessionId },
      stderr: 'pipe',
    })
    // Same reason as the shared client: a per-session child that writes more
    // than the pipe buffer to stderr blocks on its next write and never answers
    // initialize/tools/list/tools/call. Discard its diagnostics continuously.
    const stderrStream = transport.stderr
    if (stderrStream instanceof Readable) stderrStream.resume()

    client.onclose = () => {
      const live = this.sessionClients.get(sessionId)
      if (live?.get(serverName) === client) live.delete(serverName)
    }

    await client.connect(transport)

    // The session may have been released, or the server disconnected or
    // removed, while this connect was in flight. Adopting the child in any of
    // those cases would strand it — a disconnect only closes what the map
    // already holds — so close it instead of handing back a client nobody
    // will ever reap.
    const sessionGone = this.sessionClients.get(sessionId) !== bySession
    const serverGone = this.servers.get(serverName) !== entry || entry.generation !== generation
    if (sessionGone || serverGone) {
      await client.close().catch(() => undefined)
      const what = sessionGone ? `session '${sessionId}' was released` : `server '${serverName}' was disconnected`
      throw new Error(`${what} while connecting to '${serverName}'`)
    }
    bySession.set(serverName, client)

    // The first client for this server also seeds the shared catalogue, so a
    // fresh install with no cache still discovers the tools (they are only
    // ever callable from within a session anyway).
    if (entry.state.tools.length === 0) {
      try {
        const { tools: mcpTools } = await client.listTools()
        const { tools, estimatedTokens } = this.describeTools(entry, mcpTools)
        entry.state = {
          name: serverName,
          config: entry.config,
          status: 'connected',
          tools,
          estimatedTokens,
        }
        this.cacheDiscoveredTools(serverName, entry, tools)
        this.onServersChanged?.()
      } catch (err) {
        logger.warn('Failed to seed per-session MCP catalogue', {
          name: serverName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return client
  }

  /**
   * Close and forget every per-session client belonging to `sessionId`.
   * Dropping the session map first is what tells an in-flight spawn that its
   * child is no longer wanted; awaiting those attempts afterwards is what
   * guarantees none of them outlives the release.
   */
  async releaseSessionClients(sessionId: string): Promise<void> {
    const bySession = this.sessionClients.get(sessionId)
    this.sessionClients.delete(sessionId)

    const prefix = sessionConnectKey(sessionId, '')
    await this.settleWhere((key) => key.startsWith(prefix))

    if (!bySession) return
    for (const client of bySession.values()) {
      await client.close().catch(() => undefined)
    }
  }

  /** Wait for the in-flight spawns of one server, across every session. */
  private async settleSessionConnects(serverName: string): Promise<void> {
    const suffix = sessionConnectKey('', serverName)
    await this.settleWhere((key) => key.endsWith(suffix))
  }

  /**
   * Await the matching in-flight spawns. Their own guards decide whether to
   * publish or self-close; we only need them finished before we look at the
   * maps, so a settled rejection is a normal outcome here.
   */
  private async settleWhere(match: (key: string) => boolean): Promise<void> {
    const inFlight = [...this.sessionConnects.entries()].filter(([key]) => match(key)).map(([, attempt]) => attempt)
    if (inFlight.length > 0) await Promise.allSettled(inFlight)
  }

  async disconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    // Synchronous, and before any await: an in-flight spawn must see the bump
    // even when the caller never awaits us (removeServer does not).
    entry.generation += 1
    if (entry.config.perSession) {
      await this.settleSessionConnects(name)
      for (const [sessionId, bySession] of [...this.sessionClients.entries()]) {
        const client = bySession.get(name)
        if (!client) continue
        bySession.delete(name)
        if (bySession.size === 0) this.sessionClients.delete(sessionId)
        await client.close().catch(() => undefined)
      }
      entry.state = { name, config: entry.config, status: 'disconnected', tools: [], estimatedTokens: 0 }
      return
    }
    try {
      await entry.client?.close()
    } catch {
      /* ignore close errors */
    }
    entry.client = undefined
    entry.transport = null
    entry.state = { name, config: entry.config, status: 'disconnected', tools: [], estimatedTokens: 0 }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.servers.keys()) {
      await this.disconnectServer(name)
    }
  }

  async reconnectServer(name: string): Promise<void> {
    await this.connectServer(name)
  }

  getServer(name: string): McpServerState | undefined {
    return this.servers.get(name)?.state
  }

  getAllServers(): McpServerState[] {
    return Array.from(this.servers.values())
      .map((e) => e.state)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private *iterEnabledServers(override?: { disabledServers?: string[] }): Generator<ServerEntry> {
    for (const [, entry] of this.servers) {
      if (override?.disabledServers?.includes(entry.state.name)) continue
      const serverDisabled =
        entry.config.disabled && (!override?.disabledServers || !override.disabledServers.includes(entry.state.name))
      if (serverDisabled) continue
      yield entry
    }
  }

  getToolDefinitions(override?: { disabledServers?: string[]; disabledTools?: string[] }): LLMToolDefinition[] {
    const defs: LLMToolDefinition[] = []
    for (const entry of this.iterEnabledServers(override)) {
      for (const tool of entry.state.tools) {
        if (!tool.enabled) continue
        if (override?.disabledTools?.includes(tool.name)) continue
        defs.push({
          type: 'function',
          function: {
            name: `${entry.state.name}_${tool.name}`,
            description: tool.description ?? '',
            parameters: sanitizeToolSchema(tool.inputSchema as Record<string, unknown>),
          },
        })
      }
    }
    return defs
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const entry = this.servers.get(serverName)
    if (!entry) return { success: false, error: `MCP server '${serverName}' not found` }

    // A per-session server has no shared client: resolve (or spawn) the one
    // dedicated to the calling session. Without a session id there is no
    // correct client to use, and guessing one would misattribute the call —
    // so it is refused explicitly rather than silently routed to a sibling.
    let client: Client | undefined = entry.client
    if (entry.config.perSession) {
      if (!sessionId) {
        return {
          success: false,
          error: `MCP server '${serverName}' is per-session: a session id is required to call it`,
        }
      }
      try {
        client = await this.connectSessionClient(serverName, sessionId)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    if (!client) return { success: false, error: `MCP server '${serverName}' is not connected` }
    const timeoutSeconds = effectiveRequestTimeoutSeconds(entry.config.timeout, args)
    const timeoutMs = timeoutSeconds * 1000
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Aborting makes the SDK cancel the in-flight request (cancelled notification to the
        // remote server), so a timed-out call does not leak a pending request.
        const reason = new Error(`MCP tool call timed out after ${timeoutSeconds} seconds`)
        controller.abort(reason)
        reject(reason)
      }, timeoutMs)
    })
    try {
      let result
      try {
        result = await Promise.race([
          client.callTool({ name: toolName, arguments: args }, undefined, {
            timeout: timeoutMs,
            signal: controller.signal,
          }),
          timeoutPromise,
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      const content = result.content as Array<{ type: string; text?: string }>
      const textParts = content.filter((c) => c.type === 'text').map((c) => c.text)
      const text = textParts.join('\n')
      if (result.isError) {
        return { success: false, error: text || 'MCP tool call failed' }
      }
      return { success: true, output: text }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async setToolEnabled(serverName: string, toolName: string, enabled: boolean): Promise<void> {
    const entry = this.servers.get(serverName)
    if (!entry) throw new Error(`MCP server '${serverName}' not found`)
    const tool = entry.state.tools.find((t) => t.name === toolName)
    if (!tool) throw new Error(`Tool '${toolName}' not found on server '${serverName}'`)
    tool.enabled = enabled
    entry.state.estimatedTokens = entry.state.tools
      .filter((t) => t.enabled)
      .reduce((sum, t) => sum + t.estimatedTokens, 0)
    this.onServersChanged?.()
  }

  getToolFingerprint(override?: { disabledServers?: string[] }): string {
    const parts: string[] = []
    for (const entry of this.iterEnabledServers(override)) {
      for (const tool of entry.state.tools) {
        if (tool.enabled) {
          parts.push(`${entry.state.name}:${tool.name}`)
        }
      }
    }
    return parts.sort().join(',')
  }
}
