import { randomUUID } from 'node:crypto'
import { listSessionIds } from '../db/sessions.js'
import { getEventStore } from '../events/store.js'
import type { AttentionReason } from '../events/types.js'

export const REGISTRATION_CONCURRENCY = 16
export const REGISTRATION_DEADLINE_MS = 30_000
const SAMPLE_LIMIT = 8
const ERROR_MAX_BYTES = 240
const MESSAGE_MAX_BYTES = 800
const SECRET = /sk-[A-Za-z0-9_-]+/g

export interface RegistrationNotice {
  count: number
  sample: string[]
  omitted: number
  reason: string
}

export interface RegistrationDeps {
  listSessionIds: () => string[]
  callTool: (sessionId: string) => Promise<unknown>
  schedule: (callback: () => void, delayMs: number) => () => void
  journal?: (line: string) => void
  attention?: (notice: RegistrationNotice) => void
}

export interface PendingPeerDelivery {
  sessionId: string
  targetSessionId: string
  reason: AttentionReason
  error: string
  message: string
  peerId: string
}

export type PeerDeliverySender = (
  sessionId: string,
  peerId: string,
  message: string,
  msgSeq?: string,
) => Promise<{ success: boolean; error?: string }>

type Outcome = 'ready' | 'degraded'

interface DurableAudit {
  state: 'degraded'
  sessionIds: string[]
}

let sender: PeerDeliverySender | null = null
let durableAudit: DurableAudit | null = null
let drainTail: Promise<void> = Promise.resolve()

export function startsRegistrationFor(serverName: string): boolean {
  return serverName === 'mcp-lazy'
}

function registrationFailed(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    (result as { success: unknown }).success === false
  )
}

function boundText(value: string, maxBytes: number): string {
  const redacted = value.replace(SECRET, '[redacted]')
  const buffer = Buffer.from(redacted)
  if (buffer.length <= maxBytes) return redacted
  let end = maxBytes
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end -= 1
  if (end > 0 && (buffer[end - 1]! & 0xc0) === 0xc0) end -= 1
  return buffer.subarray(0, Math.max(0, end)).toString('utf8')
}

export class IdlePeerRegistrationService {
  private settled: Outcome | null = null
  private done: Promise<Outcome> | null = null
  private resolve: ((outcome: Outcome) => void) | null = null
  private cancel: (() => void) | null = null
  private auditIds: string[] = []
  private ownsAudit = false
  private cursor = 0
  private active = 0
  private finished = 0
  private failures = 0
  private readonly ids: string[] = []
  private readonly waiters: Array<() => void> = []
  private readonly settledWaiters: Array<() => void> = []
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(private readonly deps: RegistrationDeps) {}

  state(): string {
    return this.settled ?? 'warming'
  }

  audit(): { state: string; sessionIds: string[] } {
    if (this.ownsAudit) return { state: this.state(), sessionIds: [...this.auditIds] }
    if (durableAudit) return { state: durableAudit.state, sessionIds: [...durableAudit.sessionIds] }
    return { state: this.state(), sessionIds: [...this.auditIds] }
  }

  start(): Promise<Outcome> {
    if (this.done) return this.done
    this.ownsAudit = true
    this.ids.push(...this.deps.listSessionIds())
    this.auditIds = [...this.ids]
    this.done = new Promise<Outcome>((resolve) => {
      this.resolve = resolve
    })
    this.pump()
    if (this.ids.length === 0) this.finish('ready')
    else if (!this.settled) {
      this.cancel = this.deps.schedule(() => this.finish('degraded'), REGISTRATION_DEADLINE_MS)
    }
    return this.done
  }

  waitUntilSettled(): Promise<void> {
    if (this.settled) return Promise.resolve()
    return new Promise((resolve) => {
      if (this.settled) {
        resolve()
        return
      }
      this.settledWaiters.push(resolve)
    })
  }

  register(sessionId: string): Promise<void> {
    const existing = this.inflight.get(sessionId)
    if (existing) return existing
    const pending = new Promise<void>((resolve) => {
      const run = (): void => {
        void this.runCall(sessionId).finally(() => {
          this.inflight.delete(sessionId)
          this.releaseSlot()
          resolve()
        })
      }
      if (this.active >= REGISTRATION_CONCURRENCY) this.waiters.push(run)
      else {
        this.active += 1
        run()
      }
    })
    this.inflight.set(sessionId, pending)
    return pending
  }

  forget = (sessionId: string): void => {
    this.auditIds = this.auditIds.filter((id) => id !== sessionId)
    this.inflight.delete(sessionId)
    if (!durableAudit) return
    durableAudit = {
      state: 'degraded',
      sessionIds: durableAudit.sessionIds.filter((id) => id !== sessionId),
    }
  }

  private pump(): void {
    if (this.settled) return
    while (this.active < REGISTRATION_CONCURRENCY && this.cursor < this.ids.length) {
      const sessionId = this.ids[this.cursor]
      if (sessionId === undefined) break
      this.cursor += 1
      this.active += 1
      void this.runCall(sessionId).then((ok) => {
        if (!ok) this.failures += 1
        this.finished += 1
        this.releaseSlot()
        if (this.settled) return
        if (this.finished === this.ids.length) this.finish(this.failures > 0 ? 'degraded' : 'ready')
        else this.pump()
      })
    }
  }

  private async runCall(sessionId: string): Promise<boolean> {
    try {
      const result = await this.deps.callTool(sessionId)
      return !registrationFailed(result)
    } catch {
      return false
    }
  }

  private releaseSlot(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active -= 1
  }

  private finish(outcome: Outcome): void {
    if (this.settled) return
    this.settled = outcome
    this.cancel?.()
    this.cancel = null
    if (outcome === 'degraded') this.persistDegraded()
    this.resolve?.(outcome)
    const waiting = this.settledWaiters.splice(0)
    for (const resolve of waiting) resolve()
    if (outcome === 'ready') void drainPendingPeerDeliveries()
  }

  private persistDegraded(): void {
    const sessionIds = [...this.auditIds]
    durableAudit = { state: 'degraded', sessionIds }
    const sample = sessionIds.slice(0, SAMPLE_LIMIT)
    const omitted = sessionIds.length - sample.length
    const notice = { count: sessionIds.length, sample, omitted, reason: 'registration_deadline' }
    this.deps.journal?.(
      `idle peer registration degraded count=${notice.count} omitted=${notice.omitted} sample=${sample.join(',')}`,
    )
    this.deps.attention?.(notice)
    const owner = sessionIds[0]
    if (!owner) return
    try {
      getEventStore().append(owner, {
        type: 'session.peer_registration_attention',
        data: { ...notice, sessionIds },
      })
    } catch {
      return
    }
  }
}

export function installIdlePeerRegistration(
  deps: RegistrationDeps,
  deliver: PeerDeliverySender,
): IdlePeerRegistrationService {
  sender = deliver
  return new IdlePeerRegistrationService(deps)
}

export function recordPendingPeerDelivery(delivery: PendingPeerDelivery): void {
  getEventStore().append(delivery.sessionId, {
    type: 'session.peer_delivery_pending',
    data: {
      id: randomUUID(),
      targetSessionId: delivery.targetSessionId,
      reason: delivery.reason,
      error: boundText(delivery.error, ERROR_MAX_BYTES),
      message: boundText(delivery.message, MESSAGE_MAX_BYTES),
      peerId: delivery.peerId,
    },
  })
}

export function drainPendingPeerDeliveries(): Promise<void> {
  const run = drainTail.then(
    () => drainPendingOnce(),
    () => drainPendingOnce(),
  )
  drainTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function drainPendingOnce(): Promise<void> {
  if (!sender) return
  const deliver = sender
  const store = getEventStore()
  for (const sessionId of listSessionIds()) {
    const events = store.getEvents(sessionId)
    const delivered = new Set(
      events
        .filter((event) => event.type === 'session.peer_delivery_delivered')
        .map((event) => (event.data as { id: string }).id),
    )
    for (const event of events) {
      if (event.type !== 'session.peer_delivery_pending') continue
      const data = event.data as { id: string; peerId: string; message: string }
      if (delivered.has(data.id)) continue
      const result = await deliver(sessionId, data.peerId, data.message, data.id)
      if (!result.success) continue
      store.append(sessionId, { type: 'session.peer_delivery_delivered', data: { id: data.id } })
      delivered.add(data.id)
    }
  }
}
