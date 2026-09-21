import type { McpManager } from '../mcp/manager.js'

/**
 * Gateway to the shared Aether Memory RAG service (criterion 8), reached
 * through the existing `llm-aether` MCP server connection (rag_search,
 * rag_get, rag_propose, rag_feedback, rag_collections — see
 * llm-aether/src/mcp/tools.rs). This module deliberately never exposes an
 * "approve" action: publication is a human-only step on the Memory portal,
 * consistent with the hub's own contract (no rag_approve tool exists there
 * either).
 */
const LLM_AETHER_SERVER_NAME = 'llm-aether'

let mcpManager: McpManager | null = null

export function setSharedMemoryMcpManager(manager: McpManager | null): void {
  mcpManager = manager
}

export function isSharedMemoryAvailable(): boolean {
  if (!mcpManager) return false
  return mcpManager.getServer(LLM_AETHER_SERVER_NAME)?.status === 'connected'
}

export type SharedMemoryAction = 'search' | 'get' | 'propose' | 'feedback' | 'collections'

const ACTION_TO_TOOL: Record<SharedMemoryAction, string> = {
  search: 'rag_search',
  get: 'rag_get',
  propose: 'rag_propose',
  feedback: 'rag_feedback',
  collections: 'rag_collections',
}

export interface SharedMemoryResult {
  success: boolean
  data?: unknown
  error?: string
}

export async function callSharedMemory(
  action: SharedMemoryAction,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<SharedMemoryResult> {
  if (!mcpManager) {
    return { success: false, error: 'shared memory is not configured (no llm-aether MCP server)' }
  }
  const toolName = ACTION_TO_TOOL[action]
  const result = await mcpManager.callTool(LLM_AETHER_SERVER_NAME, toolName, args, sessionId)
  if (!result.success) {
    return { success: false, error: result.error ?? 'shared memory call failed' }
  }
  if (!result.output) {
    return { success: true, data: undefined }
  }
  try {
    return { success: true, data: JSON.parse(result.output) as unknown }
  } catch {
    return { success: false, error: 'shared memory returned a non-JSON response' }
  }
}

export interface SharedMemorySearchOptions {
  topK?: number
  timeoutMs?: number
  collections?: string[]
  sessionId?: string
}

// Bounded local cache of previously-approved search results (criterion 12:
// "cache borné des lectures approuvées"): a transient Memory outage right
// after a successful lookup can still be served from cache instead of
// failing the turn outright. Bounded by both size (eviction) and time (TTL)
// so a stale/revoked entry cannot linger forever.
interface CacheEntry {
  data: unknown
  expiresAt: number
}
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX_ENTRIES = 200
const searchCache = new Map<string, CacheEntry>()

function cacheKeyFor(query: string, opts: SharedMemorySearchOptions): string {
  return JSON.stringify({ query, topK: opts.topK ?? 5, collections: [...(opts.collections ?? [])].sort() })
}

function rememberInCache(key: string, data: unknown): void {
  searchCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
  if (searchCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value
    if (oldestKey !== undefined) searchCache.delete(oldestKey)
  }
}

function readFromCache(key: string): unknown | undefined {
  const entry = searchCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key)
    return undefined
  }
  return entry.data
}

/** Test-only: reset the bounded cache between test cases. */
export function clearSharedMemoryCache(): void {
  searchCache.clear()
}

/**
 * Bounded search used for automatic pre-turn retrieval (criterion 9): races
 * the real call against a timeout so a slow/unreachable Memory service can
 * never stall a turn — mirrors the bounded-error posture already enforced
 * hub-side (MemoryProxy) and Memory-service-side (health/db checks). On
 * failure/timeout, falls back to a still-fresh cached result rather than
 * failing outright (criterion 12).
 */
export async function searchSharedMemoryBounded(
  query: string,
  opts: SharedMemorySearchOptions = {},
): Promise<SharedMemoryResult> {
  const timeoutMs = opts.timeoutMs ?? 800
  const key = cacheKeyFor(query, opts)
  const args: Record<string, unknown> = { query, topK: opts.topK ?? 5 }
  if (opts.collections && opts.collections.length > 0) {
    args['collections'] = opts.collections
  }
  const call = callSharedMemory('search', args, opts.sessionId)
  const timeout = new Promise<SharedMemoryResult>((resolvePromise) => {
    setTimeout(() => resolvePromise({ success: false, error: 'shared memory search timed out' }), timeoutMs)
  })
  const result = await Promise.race([call, timeout])
  if (result.success) {
    rememberInCache(key, result.data)
    return result
  }
  const cached = readFromCache(key)
  if (cached !== undefined) {
    return { success: true, data: cached }
  }
  return result
}

export interface SharedMemoryHealth {
  configured: boolean
  status: 'connected' | 'disconnected' | 'error' | 'not_configured'
}

/** Visible health state (criterion 12: "état de santé visible"). */
export function getSharedMemoryHealth(): SharedMemoryHealth {
  if (!mcpManager) return { configured: false, status: 'not_configured' }
  const server = mcpManager.getServer(LLM_AETHER_SERVER_NAME)
  if (!server) return { configured: false, status: 'not_configured' }
  return { configured: true, status: server.status }
}
