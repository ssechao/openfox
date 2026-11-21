import { logger } from '../utils/logger.js'
import { getEventStore, type EventStore } from '../events/store.js'
import type { StoredEvent, TurnEvent } from '../events/types.js'
import { getSession } from '../db/sessions.js'
import { recordPendingPeerDelivery } from '../mcp/idle-peer-registration.js'
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
  /** What the pilot has to do, when the wait is a workflow user step. */
  notice?: AttentionNotice
}

/** Actionable context for a paused user step: what to answer, with which tool. */
export interface AttentionNotice {
  stepName?: string
  choices?: Array<{ id: string; label: string }>
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
  notice?: AttentionNotice
}

export interface CallToolFn {
  (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ success: boolean; output?: string; error?: string }>
}

export function formatAttentionMessage(params: AttentionNotifyParams): string | null {
  const parts: AttentionMessageParts = {
    label: params.reason === 'blocked' ? 'SESSION BLOQUÉE' : 'SESSION EN ATTENTE',
    title: params.title,
    sessionId: params.sessionId,
    reason: params.reason,
    detail: params.detail,
    since: new Date(params.sinceMs).toISOString(),
    actions: actionHints(params),
  }
  return fitAttentionMessage(parts)
}

const ATTENTION_MESSAGE_MAX_BYTES = 800
const ELLIPSIS = '…'

interface AttentionMessageParts {
  label: string
  title: string
  sessionId: string
  reason: string
  detail: string
  since: string
  /** Action candidates, most detailed first; the fit drops them in order. */
  actions: string[]
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function renderAttentionMessage(parts: AttentionMessageParts, action: string): string {
  const detail = parts.detail ? ` ${parts.detail}` : ''
  const since = parts.since ? ` depuis ${parts.since}` : ''
  return `⚠ ${parts.label} ${parts.title} (${parts.sessionId}) : ${parts.reason}${detail}${since}${action}`
}

/** Cut to at most `maxBytes` UTF-8 bytes, at a code-point boundary. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (bytesOf(text) <= maxBytes) return text
  const budget = maxBytes - bytesOf(ELLIPSIS)
  if (budget <= 0) return ''
  let out = ''
  let used = 0
  for (const char of text) {
    const size = bytesOf(char)
    if (used + size > budget) break
    out += char
    used += size
  }
  return out + ELLIPSIS
}

/**
 * What the pilot has to do about it, from the most to the least detailed form.
 * A bare "session waiting" costs the pilot the same time as no alert at all: a
 * paused user step must name the step, the answers available and the tool that
 * gives one. The shorter forms exist only so the alert survives the byte budget.
 */
function actionHints(params: AttentionNotifyParams): string[] {
  const notice = params.notice
  const choices = notice?.choices ?? []
  if (choices.length === 0) return []
  const step = notice?.stepName?.trim()
  const prefix = `${step ? ` — étape "${step}"` : ''} : répondre avec openfox_resume_workflow choice=`
  const detailed = choices.slice(0, 4).map((choice) => {
    const id = choice.id.trim()
    const label = choice.label.trim()
    return label && label !== id ? `"${id}" (${label})` : `"${id}"`
  })
  const idsOnly = choices.slice(0, 4).map((choice) => `"${choice.id.trim()}"`)
  return [
    prefix + detailed.join(' ou '),
    prefix + idsOnly.join('|'),
    `${step ? ` — étape "${step}"` : ''} : openfox_resume_workflow`,
  ]
}

/**
 * Fit the alert into the hub's per-message budget. `ATTENTION_MESSAGE_MAX_BYTES`
 * is an absolute invariant, re-checked on whatever remains: the action is
 * shortened first (labels, then the choice list, then the action itself), then
 * the detail, then the title, then the timestamp. Every removal is journaled
 * with what was dropped. When even the irreducible core — reason and session
 * id — does not fit, there is no message to send and the caller must say so.
 */
function fitAttentionMessage(parts: AttentionMessageParts): string | null {
  for (let index = 0; index < parts.actions.length; index += 1) {
    const candidate = renderAttentionMessage(parts, parts.actions[index]!)
    if (bytesOf(candidate) <= ATTENTION_MESSAGE_MAX_BYTES) {
      if (index > 0) journalTruncation(parts, index === 1 ? 'action labels' : 'action choices', candidate)
      return candidate
    }
  }

  const withoutAction = renderAttentionMessage(parts, '')
  if (bytesOf(withoutAction) <= ATTENTION_MESSAGE_MAX_BYTES) {
    if (parts.actions.length > 0) journalTruncation(parts, 'action', withoutAction)
    return withoutAction
  }

  const head: AttentionMessageParts = { ...parts, actions: [], detail: '' }
  const detailBudget = ATTENTION_MESSAGE_MAX_BYTES - bytesOf(renderAttentionMessage(head, ''))
  const detail = detailBudget > 0 ? truncateUtf8(parts.detail, detailBudget) : ''
  const withDetail: AttentionMessageParts = detail ? { ...head, detail } : head
  const withDetailRendered = renderAttentionMessage(withDetail, '')
  if (detail && bytesOf(withDetailRendered) <= ATTENTION_MESSAGE_MAX_BYTES) {
    journalTruncation(parts, 'action, detail', withDetailRendered)
    return withDetailRendered
  }

  const titleBudget = ATTENTION_MESSAGE_MAX_BYTES - bytesOf(renderAttentionMessage({ ...head, title: '' }, ''))
  const title = titleBudget > 0 ? truncateUtf8(parts.title, titleBudget) : ''
  const withTitle = renderAttentionMessage({ ...head, title }, '')
  if (title && bytesOf(withTitle) <= ATTENTION_MESSAGE_MAX_BYTES) {
    journalTruncation(parts, 'action, detail, title', withTitle)
    return withTitle
  }

  const core = renderAttentionMessage({ ...head, title: '', since: '' }, '')
  if (bytesOf(core) <= ATTENTION_MESSAGE_MAX_BYTES) {
    journalTruncation(parts, 'action, detail, title, since', core)
    return core
  }

  // Reason and session id alone already exceed the budget: nothing can be sent.
  logger.error('attention_message_unbounded', {
    sessionId: parts.sessionId,
    reason: parts.reason,
    bytes: bytesOf(core),
    maxBytes: ATTENTION_MESSAGE_MAX_BYTES,
  })
  return null
}

function journalTruncation(parts: AttentionMessageParts, omitted: string, message: string): void {
  logger.warn('attention_message_truncated', {
    sessionId: parts.sessionId,
    reason: parts.reason,
    omitted,
    bytes: bytesOf(message),
    maxBytes: ATTENTION_MESSAGE_MAX_BYTES,
  })
}

/** A canonical hub identity, as the registry derives it (a UUID). */
const PEER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PeerIdLookup {
  /** The identity to address, or null when the payload did not carry a usable one. */
  peerId: string | null
  /** The value found after `peer_id:`, kept verbatim so a rejection can name it. */
  candidate: string | null
}

/**
 * Unwrap a proxied MCP tool payload.
 *
 * Measured: `mcp-lazy`'s `mcp_execute_tool` answers
 * `content: [{ type: 'text', text: JSON.stringify(result) }]`, and the manager
 * hands that text through unchanged. The payload is therefore a JSON envelope
 * in which the inner newlines are the two literal characters '\' and 'n' — not
 * whitespace. A direct (unproxied) transport still answers plain text, so both
 * shapes are accepted; a payload that is neither is used verbatim.
 */
function unwrapMcpPayload(output: string): string {
  let current = output
  for (let depth = 0; depth < 3; depth += 1) {
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch {
      return current
    }
    if (typeof parsed === 'string') {
      current = parsed
      continue
    }
    const content = (parsed as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) return current
    const text = content
      .filter(
        (part): part is { type?: string; text: string } =>
          typeof (part as { text?: unknown } | null)?.text === 'string',
      )
      .filter((part) => part.type === undefined || part.type === 'text')
      .map((part) => part.text)
    if (text.length === 0) return current
    current = text.join('\n')
  }
  return current
}

/**
 * Read the hub identity out of a `ht_get_contact_info` answer.
 *
 * The extracted value is validated against the canonical shape rather than
 * accepted as "whatever follows the colon": an identity that does not have that
 * shape can never be routed, so it must be reported instead of being used for a
 * send that is bound to fail with `unknown peer`.
 */
function parsePeerId(output: string | undefined): PeerIdLookup {
  if (!output) return { peerId: null, candidate: null }
  const match = unwrapMcpPayload(output).match(/peer_id:\s*(\S+)/)
  const candidate = match?.[1] ?? null
  if (candidate && PEER_ID_PATTERN.test(candidate)) return { peerId: candidate, candidate }
  return { peerId: null, candidate }
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
    const lookup = parsePeerId(contact.success ? contact.output : undefined)
    if (!contact.success || !lookup.peerId) {
      const error =
        contact.error ??
        (lookup.candidate
          ? `peer_id is not a canonical hub identity: ${lookup.candidate}`
          : 'no peer_id in contact info')
      logger.error('attention_notify_failed', {
        sessionId: params.sessionId,
        createdBy: params.createdBy,
        reason: params.reason,
        stage: 'ht_get_contact_info',
        ...(lookup.candidate ? { peerId: lookup.candidate } : {}),
        error,
      })
      try {
        recordPendingPeerDelivery({
          sessionId: params.sessionId,
          targetSessionId: params.createdBy,
          reason: params.reason,
          error,
          message: formatAttentionMessage(params) ?? params.reason,
          peerId: lookup.candidate ?? '',
        })
      } catch (recordError) {
        logger.error('attention_notify_failed', {
          sessionId: params.sessionId,
          createdBy: params.createdBy,
          reason: params.reason,
          stage: 'record_pending',
          ...(lookup.candidate ? { peerId: lookup.candidate } : {}),
          error: recordError instanceof Error ? recordError.message : String(recordError),
        })
      }
      return
    }
    const peerId = lookup.peerId
    const message = formatAttentionMessage(params)
    if (!message) {
      // The invariant held: nothing above the budget is ever sent.
      logger.error('attention_notify_failed', {
        sessionId: params.sessionId,
        createdBy: params.createdBy,
        reason: params.reason,
        stage: 'format_message',
        peerId,
        error: `alert cannot be represented within ${ATTENTION_MESSAGE_MAX_BYTES} bytes; nothing sent`,
      })
      return
    }
    const send = await viaProxy('ht_send_to_peer', { peer_id: peerId, message }, params.sessionId)
    if (!send.success) {
      const error = send.error ?? 'delivery failed'
      logger.error('attention_notify_failed', {
        sessionId: params.sessionId,
        createdBy: params.createdBy,
        reason: params.reason,
        stage: 'ht_send_to_peer',
        peerId,
        error,
      })
      try {
        recordPendingPeerDelivery({
          sessionId: params.sessionId,
          targetSessionId: params.createdBy,
          reason: params.reason,
          error,
          message,
          peerId,
        })
      } catch (recordError) {
        logger.error('attention_notify_failed', {
          sessionId: params.sessionId,
          createdBy: params.createdBy,
          reason: params.reason,
          stage: 'record_pending',
          peerId,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        })
      }
      return
    }
    // Delivery is recorded on success too: "no error logged" is not evidence
    // that the alert reached anyone.
    logger.info('attention_notified', {
      sessionId: params.sessionId,
      createdBy: params.createdBy,
      reason: params.reason,
      peerId,
    })
  }
}

interface AttentionEntry {
  reason: AttentionReason
  detail: string
  sinceMs: number
  armed: boolean
  /** For waiting reasons: callIds still pending; the entry closes when it empties. */
  waits: Set<string>
  /** Actionable context of the wait, carried to the notification. */
  notice?: AttentionNotice
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
  observeWaiting(sessionId: string, reason: AttentionReason, detail: string, notice?: AttentionNotice): void {
    if (this.forward) {
      this.forward({ kind: 'waiting', reason, detail, ...(notice ? { notice } : {}) })
      return
    }
    this.enter(sessionId, reason, detail, false, notice)
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

  private enter(
    sessionId: string,
    reason: AttentionReason,
    detail: string,
    immediate: boolean,
    notice?: AttentionNotice,
  ): void {
    this.seed(sessionId)
    const key = `${sessionId}:${reason}`
    const existing = this.entries.get(key)
    if (existing) {
      if (isWaitingReason(reason)) existing.waits.add(detail)
      if (notice) existing.notice = notice
      return
    }
    const entry: AttentionEntry = {
      reason,
      detail,
      sinceMs: this.now(),
      armed: true,
      waits: isWaitingReason(reason) ? new Set([detail]) : new Set<string>(),
      ...(notice ? { notice } : {}),
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
    appendAttentionEvent(sessionId, entry.reason, {
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
      ...(entry.notice ? { notice: entry.notice } : {}),
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
    appendAttentionEvent(sessionId, entry.reason, {
      type: 'session.attention_cleared',
      data: { sessionId, projectId: info.projectId, reason: entry.reason },
    })
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN_ERROR'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function attentionStore(): EventStore | null {
  try {
    return getEventStore()
  } catch {
    return null
  }
}

/**
 * Attention events still queued behind a busy store, per session. While one is
 * pending, every later event for that session must queue too: a synchronous
 * append would otherwise be persisted BEFORE the event still waiting for its
 * retry, and a replay would end on the wrong state (an alert closed that was
 * never opened, or an active alert erased by a cleared event that logically
 * came before it). The persisted order of required/cleared always equals the
 * logical order.
 */
const pendingAttentionAppends = new Map<string, number>()

/**
 * Persist an attention event without ever letting a locked database take the
 * process down, and without ever reordering the persisted stream.
 *
 * Measured in production (18/11 02:41:54): the gateway tolerates a 5 ms busy
 * wait, so a 10 ms write lock made `append` throw `EventStoreBusyTimeoutError`
 * straight out of an event handler (`observeWaitingResolved` -> `resolveWait` ->
 * `emitCleared`). Nothing caught it and the 450 died, cutting twelve turns.
 * A sweep timer reaches the same code, so the throw is not tied to a turn.
 *
 * The synchronous attempt is kept only while nothing is pending for the
 * session; otherwise the event joins the store's recoverable queue, which is
 * FIFO per session and retries on its own deadline. Every failure is journaled
 * with the store's error code, never thrown.
 */
function appendAttentionEvent(sessionId: string, reason: AttentionReason, event: TurnEvent): void {
  const store = attentionStore()
  if (!store) {
    logger.error('attention_event_append_failed', {
      sessionId,
      reason,
      eventType: event.type,
      code: 'EVENT_STORE_UNAVAILABLE',
      error: 'event store is not initialized',
    })
    return
  }
  const pending = pendingAttentionAppends.get(sessionId) ?? 0
  if (pending === 0) {
    try {
      store.append(sessionId, event)
      return
    } catch (error) {
      logger.error('attention_event_append_failed', {
        sessionId,
        reason,
        eventType: event.type,
        code: errorCode(error),
        error: errorMessage(error),
      })
    }
  }
  pendingAttentionAppends.set(sessionId, pending + 1)
  void store
    .appendRecoverable(sessionId, event)
    .catch((error: unknown) => {
      logger.error('attention_event_append_failed', {
        sessionId,
        reason,
        eventType: event.type,
        code: errorCode(error),
        error: errorMessage(error),
      })
    })
    .finally(() => {
      const left = (pendingAttentionAppends.get(sessionId) ?? 1) - 1
      if (left <= 0) pendingAttentionAppends.delete(sessionId)
      else pendingAttentionAppends.set(sessionId, left)
    })
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
