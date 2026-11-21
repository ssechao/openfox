import { randomUUID } from 'node:crypto'
import { listSessionIds } from '../db/sessions.js'
import { getEventStore } from '../events/store.js'
import type { AttentionReason } from '../events/types.js'
export const REGISTRATION_CONCURRENCY = 16
export const REGISTRATION_DEADLINE_MS = 30_000
const SAMPLE_LIMIT = 8

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
) => Promise<{ success: boolean; error?: string }>

type Outcome = 'ready' | 'degraded'

export class IdlePeerRegistrationService {
  private settled: Outcome | null = null
  private done: Promise<Outcome> | null = null
  private resolve: ((outcome: Outcome) => void) | null = null
  private cancel: (() => void) | null = null
  private auditIds: string[] = []
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(private readonly deps: RegistrationDeps) {}

  state(): string {
    return this.settled ?? 'warming'
  }

  audit(): { state: string; sessionIds: string[] } {
    return { state: this.state(), sessionIds: [...this.auditIds] }
  }

  start(): Promise<Outcome> {
    if (this.done) return this.done
    const ids = this.deps.listSessionIds()
    this.auditIds = [...ids]
    this.done = new Promise<Outcome>((resolve) => {
      this.resolve = resolve
    })
    let cursor = 0
    let active = 0
    let finished = 0
    const launch = (): void => {
      if (this.settled) return
      while (active < REGISTRATION_CONCURRENCY && cursor < ids.length) {
        const sessionId = ids[cursor]
        if (sessionId === undefined) break
        cursor += 1
        active += 1
        void Promise.resolve(this.deps.callTool(sessionId)).then(
          () => complete(),
          () => complete(),
        )
      }
      if (ids.length === 0) this.finish('ready')
    }
    const complete = (): void => {
      active -= 1
      finished += 1
      if (this.settled) return
      if (finished === ids.length) this.finish('ready')
      else launch()
    }
    launch()
    if (!this.settled) {
      this.cancel = this.deps.schedule(() => this.finish('degraded'), REGISTRATION_DEADLINE_MS)
    }
    return this.done
  }

  register(sessionId: string): Promise<void> {
    const existing = this.inflight.get(sessionId)
    if (existing) return existing
    const pending = Promise.resolve(this.deps.callTool(sessionId)).then(
      () => undefined,
      () => undefined,
    )
    this.inflight.set(sessionId, pending)
    return pending
  }

  private finish(outcome: Outcome): void {
    if (this.settled) return
    this.settled = outcome
    this.cancel?.()
    this.cancel = null
    if (outcome === 'degraded') {
      const sample = this.auditIds.slice(0, SAMPLE_LIMIT)
      const omitted = this.auditIds.length - sample.length
      this.deps.journal?.(
        `idle peer registration degraded count=${this.auditIds.length} omitted=${omitted} sample=${sample.join(',')}`,
      )
      this.deps.attention?.({ count: this.auditIds.length, sample, omitted, reason: 'registration_deadline' })
    }
    this.resolve?.(outcome)
  }
}

let sender: PeerDeliverySender | null = null

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
      error: delivery.error,
      message: delivery.message,
      peerId: delivery.peerId,
    },
  })
}

export async function drainPendingPeerDeliveries(): Promise<void> {
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
      const result = await deliver(sessionId, data.peerId, data.message)
      if (!result.success) continue
      store.append(sessionId, { type: 'session.peer_delivery_delivered', data: { id: data.id } })
      delivered.add(data.id)
    }
  }
}
