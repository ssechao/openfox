import { logger } from '../utils/logger.js'
import { getEventStore } from '../events/store.js'
import type { StoredEvent } from '../events/types.js'
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
  kind: 'blocked' | 'waiting' | 'waiting_resolved' | 'resumed' | 'turn_failed' | 'turn_succeeded'
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
  const label =
    params.reason === 'blocked'
      ? 'SESSION BLOQUÉE'
      : params.reason === 'turn_failed'
        ? 'TOUR EN ÉCHEC'
        : 'SESSION EN ATTENTE'
  const since = new Date(params.sinceMs).toISOString()
  const errorCore = `${params.reason} ${params.detail}`
  const template = (title: string) => `⚠ ${label} ${title} (${params.sessionId}) : ${errorCore} depuis ${since}`
  return withTitleFittingBytes(template, params.title, ATTENTION_MESSAGE_MAX_BYTES)
}

export const ATTENTION_MESSAGE_MAX_BYTES = 800

/**
 * Cap the Aether message in UTF-8 bytes by shortening the session title only —
 * the error core (reason + whitelisted detail) is never cut. Titles are cut on
 * code points with an ellipse; if even an empty title overflows, the message is
 * returned as-is rather than mangling the error core.
 */
function withTitleFittingBytes(template: (title: string) => string, title: string, maxBytes: number): string {
  if (Buffer.byteLength(template(title), 'utf8') <= maxBytes) return template(title)
  const overhead = Buffer.byteLength(template('…'), 'utf8')
  const budget = maxBytes - overhead
  if (budget <= 0) return template('')
  let kept = ''
  let used = 0
  for (const char of title) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    kept += char
    used += size
  }
  return template(`${kept}…`)
}

const HTTP_STATUS_PATTERN = /HTTP\s+(\d{3})/
const ERROR_CODE_PATTERN = /"code"\s*:\s*"([a-z][a-z0-9_.-]{0,60})"/

/**
 * Whitelist for the persisted/notified turn detail (Astra B1): `HTTP <status>`
 * plus a structured error code extracted from the JSON body, nothing else.
 * Raw provider messages can embed credentials (Bearer keys, api_key values)
 * and must never reach the event store or the Aether channel.
 */
const WHITELISTED_DETAIL = /^HTTP \d{3}( [a-z][a-z0-9_.-]{0,60})?$/

export function sanitizeTurnDetail(raw: string): string {
  const trimmed = raw.trim()
  if (WHITELISTED_DETAIL.test(trimmed)) return trimmed
  const status = raw.match(HTTP_STATUS_PATTERN)?.[1]
  const code = raw.match(ERROR_CODE_PATTERN)?.[1]
  if (!status) return code ? `error ${code}` : 'turn_error'
  return code ? `HTTP ${status} ${code}` : `HTTP ${status}`
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
  /** For waiting reasons: callIds still pending; the entry closes when it empties. */
  waits: Set<string>
}

const WAITING_REASONS: AttentionReason[] = ['waiting_question', 'waiting_confirmation', 'waiting_workflow_step']

function isWaitingReason(reason: AttentionReason): boolean {
  return WAITING_REASONS.includes(reason)
}

/**
 * Tracks one attention state per (session, reason). The registry is seeded
 * once per service instance from the persisted attention events (read straight
 * from the events table, never re-emitted at load), so a restart neither
 * re-notifies a stall that is still open nor loses the ability to close it.
 * Waiting entries track their pending callIds: a reason closes only when its
 * last wait resolves. A required entry survives until cleared: the event is
 * emitted once per entry into the state and never re-emitted.
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
  private readonly seeded = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: AttentionServiceDeps = {}) {
    this.now = deps.now ?? Date.now
    this.waitMs = deps.waitMs ?? ATTENTION_WAIT_MS_DEFAULT
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

  /**
   * A wait observed by observeWaiting resolved. `detail` is the callId (or
   * step id) of the resolved wait; the sentinel 'phase' (a live phase change
   * away from waiting) closes every waiting reason for the session.
   */
  observeWaitingResolved(sessionId: string, detail: string): void {
    if (this.forward) {
      this.forward({ kind: 'waiting_resolved', detail })
      return
    }
    this.seed(sessionId)
    for (const reason of WAITING_REASONS) {
      if (detail === 'phase') {
        this.leave(sessionId, reason)
        continue
      }
      this.resolveWait(sessionId, reason, detail)
    }
  }

  /** Session left phase 'blocked'. */
  observeResumed(sessionId: string): void {
    if (this.forward) {
      this.forward({ kind: 'resumed', detail: 'phase' })
      return
    }
    this.seed(sessionId)
    this.leave(sessionId, 'blocked')
  }

  /** A chat turn ended in a non-recoverable LLM error (STALL-NOTIFY-2). */
  observeTurnFailed(sessionId: string, detail: string): void {
    const sanitized = sanitizeTurnDetail(detail).slice(0, 120)
    if (this.forward) {
      this.forward({ kind: 'turn_failed', detail: sanitized })
      return
    }
    this.enter(sessionId, 'turn_failed', sanitized, true)
  }

  /** A chat turn completed without error (STALL-NOTIFY-2). */
  observeTurnSucceeded(sessionId: string): void {
    if (this.forward) {
      this.forward({ kind: 'turn_succeeded', detail: 'turn' })
      return
    }
    this.seed(sessionId)
    this.leave(sessionId, 'turn_failed')
  }

  /**
   * Lazily rebuild the open-attention registry for one session from persisted
   * events, once per service instance. Read-only: never emits, so a restart
   * re-notifies nothing; seeded entries are armed=false (already notified) and
   * can still be closed by later observations.
   */
  private seed(sessionId: string): void {
    if (this.seeded.has(sessionId)) return
    this.seeded.add(sessionId)
    let events: StoredEvent[]
    try {
      events = getEventStore().getEvents(sessionId)
    } catch {
      return
    }
    for (const event of events) {
      if (event.type === 'session.attention_required') {
        const data = event.data as { reason: AttentionReason; detail: string; since: string }
        const key = `${sessionId}:${data.reason}`
        if (this.entries.has(key)) continue
        const sinceMs = Date.parse(data.since)
        this.entries.set(key, {
          reason: data.reason,
          detail: data.detail,
          sinceMs: Number.isFinite(sinceMs) ? sinceMs : this.now(),
          armed: false,
          waits: isWaitingReason(data.reason) ? new Set([data.detail]) : new Set<string>(),
        })
      } else if (event.type === 'session.attention_cleared') {
        const data = event.data as { reason: AttentionReason }
        this.entries.delete(`${sessionId}:${data.reason}`)
      }
    }
  }

  private enter(sessionId: string, reason: AttentionReason, detail: string, immediate: boolean): void {
    this.seed(sessionId)
    const key = `${sessionId}:${reason}`
    const existing = this.entries.get(key)
    if (existing) {
      if (isWaitingReason(reason)) existing.waits.add(detail)
      return
    }
    const entry: AttentionEntry = {
      reason,
      detail,
      sinceMs: this.now(),
      armed: true,
      waits: isWaitingReason(reason) ? new Set([detail]) : new Set<string>(),
    }
    this.entries.set(key, entry)
    if (immediate) {
      entry.armed = false
      this.emitRequired(sessionId, entry)
    }
  }

  /** Remove one resolved wait; the reason closes only when its last wait goes. */
  private resolveWait(sessionId: string, reason: AttentionReason, callId: string): void {
    const key = `${sessionId}:${reason}`
    const entry = this.entries.get(key)
    if (!entry) return
    entry.waits.delete(callId)
    if (entry.waits.size > 0) {
      if (entry.detail === callId) entry.detail = entry.waits.values().next().value ?? entry.detail
      return
    }
    this.entries.delete(key)
    if (!entry.armed) this.emitCleared(sessionId, entry)
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
