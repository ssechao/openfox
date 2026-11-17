import type { AttentionReason } from '../events/types.js'

export const ATTENTION_WAIT_MS_DEFAULT = 10 * 60 * 1000
export const ATTENTION_SWEEP_INTERVAL_MS = 30 * 1000

export interface AttentionNotifyParams {
  sessionId: string
  projectId: string
  title: string
  reason: AttentionReason
  detail: string
  sinceMs: number
  createdBy: string | null
}

export interface AttentionServiceDeps {
  now?: () => number
  waitMs?: number
  notify?: (params: AttentionNotifyParams) => Promise<void>
  getSessionTitle?(sessionId: string): { title: string; projectId: string; createdBy: string | null } | null
}

export interface CallToolFn {
  (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ success: boolean; output?: string; error?: string }>
}

export function formatAttentionMessage(params: AttentionNotifyParams): string {
  const label = params.reason === 'blocked' ? 'SESSION BLOQUÉE' : 'SESSION EN ATTENTE'
  const since = new Date(params.sinceMs).toISOString()
  return `⚠ ${label} ${params.title} (${params.sessionId}) : ${params.reason} ${params.detail} depuis ${since}`
}

/**
 * Aether notifier (decision D3): resolve the creator's current peer_id with
 * ht_get_contact_info under the creator's own injected identity, then send
 * ht_send_to_peer under the stalled session's identity. No fallback channel:
 * any failure is logged as attention_notify_failed and the event stands alone.
 */
export function createAetherNotifier(
  _callTool: CallToolFn,
  _proxyServerName = 'mcp-lazy',
): (params: AttentionNotifyParams) => Promise<void> {
  return async () => {}
}

/**
 * Tracks one attention state per (session, reason). Entries are created only
 * by live hooks observed after process start (never backfilled from the DB or
 * from pending-interaction maps), so a restart never re-notifies an old state.
 * A required entry survives until cleared: the event is emitted once per entry
 * into the state and never re-emitted, even across restarts of this service.
 */
export class SessionAttentionService {
  constructor(_deps: AttentionServiceDeps = {}) {}
  start(_intervalMs = ATTENTION_SWEEP_INTERVAL_MS): void {}
  stop(): void {}
  observeBlocked(_sessionId: string, _detail: string): void {}
  observeWaiting(_sessionId: string, _reason: AttentionReason, _detail: string): void {}
  observeWaitingResolved(_sessionId: string, _detail: string): void {}
  observeResumed(_sessionId: string): void {}
  sweep(): void {}
}

let instance: SessionAttentionService | null = null
let pendingDeps: AttentionServiceDeps = {}

export function configureAttentionService(deps: AttentionServiceDeps): void {
  pendingDeps = deps
  instance?.stop()
  instance = null
}

export function getAttentionService(): SessionAttentionService {
  if (!instance) instance = new SessionAttentionService(pendingDeps)
  return instance
}

export function resetAttentionService(): void {
  instance?.stop()
  instance = null
  pendingDeps = {}
}
