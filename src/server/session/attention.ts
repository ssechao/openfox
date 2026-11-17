import { logger } from '../utils/logger.js'
import { getEventStore } from '../events/store.js'
import { getSession } from '../db/sessions.js'
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
  /** Worker mode: observations are forwarded to the gateway instead of tracked locally. */
  forward?: (observation: AttentionObservation) => void
}

export interface AttentionObservation {
  kind: 'blocked' | 'waiting' | 'waiting_resolved' | 'resumed'
  reason?: AttentionReason
  detail: string
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

function parsePeerId(output: string | undefined): string | null {
  if (!output) return null
  const match = output.match(/peer_id:\s*(\S+)/)
  return match?.[1] ?? null
}

/**
 * Aether notifier (decision D3): resolve the creator's current peer_id with
 * ht_get_contact_info under the creator's own injected identity, then send
 * ht_send_to_peer under the stalled session's identity. No fallback channel:
 * any failure is logged as attention_notify_failed and the event stands alone.
 */
export function createAetherNotifier(
  callTool: CallToolFn,
  proxyServerName = 'mcp-lazy',
  hubServerName = 'llm-aether',
): (params: AttentionNotifyParams) => Promise<void> {
  const viaProxy = (toolName: string, args: Record<string, unknown>, identitySessionId: string) =>
    callTool(
      proxyServerName,
      'mcp_execute_tool',
      { server_name: hubServerName, tool_name: toolName, arguments: args },
      identitySessionId,
    )
  return async (params) => {
    if (!params.createdBy) return
    const contact = await viaProxy('ht_get_contact_info', {}, params.createdBy)
    const peerId = parsePeerId(contact.output)
    if (!contact.success || !peerId) {
      logger.error('attention_notify_failed', {
        sessionId: params.sessionId,
        createdBy: params.createdBy,
        reason: params.reason,
        stage: 'ht_get_contact_info',
        error: contact.error ?? 'no peer_id in contact info',
      })
      return
    }
    const send = await viaProxy(
      'ht_send_to_peer',
      { peer_id: peerId, message: formatAttentionMessage(params) },
      params.sessionId,
    )
    if (!send.success) {
      logger.error('attention_notify_failed', {
        sessionId: params.sessionId,
        createdBy: params.createdBy,
        reason: params.reason,
        stage: 'ht_send_to_peer',
        error: send.error ?? 'delivery failed',
      })
    }
  }
}

interface AttentionEntry {
  reason: AttentionReason
  detail: string
  sinceMs: number
  armed: boolean
}

/**
 * Tracks one attention state per (session, reason). Entries are created only
 * by live hooks observed after process start (never backfilled from the DB or
 * from pending-interaction maps), so a restart never re-notifies an old state.
 * A required entry survives until cleared: the event is emitted once per entry
 * into the state and never re-emitted, even across restarts of this service.
 */
export class SessionAttentionService {
  private readonly now: () => number
  private readonly waitMs: number
  private readonly notify?: (params: AttentionNotifyParams) => Promise<void>
  private readonly forward?: (observation: AttentionObservation) => void
  private readonly getSessionTitle: (sessionId: string) => {
    title: string
    projectId: string
    createdBy: string | null
  } | null
  private readonly entries = new Map<string, AttentionEntry>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: AttentionServiceDeps = {}) {
    this.now = deps.now ?? Date.now
    this.waitMs = deps.waitMs ?? configWaitMs()
    if (deps.notify) this.notify = deps.notify
    if (deps.forward) this.forward = deps.forward
    this.getSessionTitle = deps.getSessionTitle ?? defaultSessionLookup
  }

  start(intervalMs = ATTENTION_SWEEP_INTERVAL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Blocked state observed live (transition into phase 'blocked'). */
  observeBlocked(sessionId: string, detail: string): void {
    if (this.forward) {
      this.forward({ kind: 'blocked', detail })
      return
    }
    this.enter(sessionId, 'blocked', detail, true)
  }

  /** Waiting state observed live (question, confirmation, workflow user step). */
  observeWaiting(sessionId: string, reason: AttentionReason, detail: string): void {
    if (this.forward) {
      this.forward({ kind: 'waiting', reason, detail })
      return
    }
    this.enter(sessionId, reason, detail, false)
  }

  /** A wait observed by observeWaiting resolved (before or after its event). */
  observeWaitingResolved(sessionId: string, detail: string): void {
    if (this.forward) {
      this.forward({ kind: 'waiting_resolved', detail })
      return
    }
    this.leave(sessionId, 'waiting_question')
    this.leave(sessionId, 'waiting_confirmation')
    this.leave(sessionId, 'waiting_workflow_step')
    void detail
  }

  /** Session left phase 'blocked'. */
  observeResumed(sessionId: string): void {
    if (this.forward) {
      this.forward({ kind: 'resumed', detail: 'phase' })
      return
    }
    this.leave(sessionId, 'blocked')
  }

  private enter(sessionId: string, reason: AttentionReason, detail: string, immediate: boolean): void {
    const key = `${sessionId}:${reason}`
    if (this.entries.has(key)) return
    const entry: AttentionEntry = { reason, detail, sinceMs: this.now(), armed: true }
    this.entries.set(key, entry)
    if (immediate) {
      entry.armed = false
      this.emitRequired(sessionId, entry)
    }
  }

  private leave(sessionId: string, reason: AttentionReason): void {
    const key = `${sessionId}:${reason}`
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (!entry.armed) this.emitCleared(sessionId, entry)
  }

  sweep(): void {
    const nowMs = this.now()
    for (const [key, entry] of this.entries.entries()) {
      if (!entry.armed) continue
      const sessionId = key.slice(0, key.lastIndexOf(':'))
      if (nowMs - entry.sinceMs < this.waitMs) continue
      entry.armed = false
      this.emitRequired(sessionId, entry)
    }
  }

  private emitRequired(sessionId: string, entry: AttentionEntry): void {
    const info = this.getSessionTitle(sessionId)
    if (!info) return
    getEventStore().append(sessionId, {
      type: 'session.attention_required',
      data: {
        sessionId,
        projectId: info.projectId,
        reason: entry.reason,
        detail: entry.detail,
        since: new Date(entry.sinceMs).toISOString(),
      },
    })
    if (!this.notify) return
    const params: AttentionNotifyParams = {
      sessionId,
      projectId: info.projectId,
      title: info.title,
      reason: entry.reason,
      detail: entry.detail,
      sinceMs: entry.sinceMs,
      createdBy: info.createdBy,
    }
    void Promise.resolve()
      .then(() => this.notify!(params))
      .catch((error: unknown) => {
        logger.error('attention_notify_failed', {
          sessionId,
          reason: entry.reason,
          stage: 'notify',
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private emitCleared(sessionId: string, entry: AttentionEntry): void {
    const info = this.getSessionTitle(sessionId)
    if (!info) return
    getEventStore().append(sessionId, {
      type: 'session.attention_cleared',
      data: { sessionId, projectId: info.projectId, reason: entry.reason },
    })
  }
}

function configWaitMs(): number {
  const raw = process.env['OPENFOX_ATTENTION_WAIT_MS']
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ATTENTION_WAIT_MS_DEFAULT
}

function defaultSessionLookup(sessionId: string): {
  title: string
  projectId: string
  createdBy: string | null
} | null {
  try {
    const session = getSession(sessionId)
    if (!session) return null
    return {
      title: session.metadata?.title ?? `Session ${sessionId.slice(0, 8)}`,
      projectId: session.projectId,
      createdBy: session.createdBy ?? null,
    }
  } catch {
    return null
  }
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
