import type { AsapDrainBatch } from '../../chat/drain-queue.js'
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerToGatewayMessage } from './protocol.js'

export const ASAP_DRAIN_CLIENT_DEADLINE_MS = 2_000
const BUSY_RETRY_MS = 15

interface PendingDrain {
  activeId: string
  timeout: NodeJS.Timeout
  retry: NodeJS.Timeout | null
  release: () => void
  resolve: (batch: AsapDrainBatch) => void
}

function inertBatch(): AsapDrainBatch {
  return {
    messages: [],
    queueState: [],
    commit() {},
    abort() {},
  }
}

export class WorkerAsapClient {
  private readonly pending = new Map<string, PendingDrain>()
  private tail: Promise<void> = Promise.resolve()
  private closedReason: string | null = null

  constructor(
    private readonly identity: WorkerIpcIdentity,
    private readonly send: (message: WorkerToGatewayMessage) => void,
    private readonly deadlineMs = ASAP_DRAIN_CLIENT_DEADLINE_MS,
  ) {}

  drain(): Promise<AsapDrainBatch> {
    let opened = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = () => {
        if (!opened) return
        opened = false
        resolve()
      }
    })
    const run = this.tail.then(() => this.request(release))
    this.tail = gate
    return run
  }

  handleMessage(message: GatewayToWorkerMessage): void {
    if (message.type !== 'asap.drain.response') return
    if (
      message.sessionId !== this.identity.sessionId ||
      message.workerId !== this.identity.workerId ||
      message.generation !== this.identity.generation
    ) {
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending || pending.activeId !== message.requestId) return
    if (message.status === 'busy') {
      this.scheduleRetry(pending)
      return
    }
    this.pending.delete(message.requestId)
    clearTimeout(pending.timeout)
    if (pending.retry) clearTimeout(pending.retry)
    let settled = false
    const finish = (kind: 'asap.drain.ack' | 'asap.drain.abort') => {
      if (settled) return
      settled = true
      this.send({ ...this.identity, type: kind, requestId: message.requestId })
      pending.release()
    }
    pending.resolve({
      messages: message.messages,
      queueState: message.queueState,
      commit: () => finish('asap.drain.ack'),
      abort: () => finish('asap.drain.abort'),
    })
  }

  close(reason: string): void {
    if (this.closedReason !== null) return
    this.closedReason = reason
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(pending.activeId)
      clearTimeout(pending.timeout)
      if (pending.retry) clearTimeout(pending.retry)
      this.send({ ...this.identity, type: 'asap.drain.abort', requestId: pending.activeId })
      pending.resolve(inertBatch())
      pending.release()
    }
  }

  private request(release: () => void): Promise<AsapDrainBatch> {
    if (this.closedReason !== null) {
      release()
      return Promise.resolve(inertBatch())
    }
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const pending: PendingDrain = {
        activeId: requestId,
        retry: null,
        release,
        resolve,
        timeout: setTimeout(() => this.expire(pending), this.deadlineMs),
      }
      this.pending.set(requestId, pending)
      this.send({ ...this.identity, type: 'asap.drain.request', requestId })
    })
  }

  private expire(pending: PendingDrain): void {
    if (this.pending.get(pending.activeId) !== pending) return
    this.pending.delete(pending.activeId)
    if (pending.retry) clearTimeout(pending.retry)
    this.send({ ...this.identity, type: 'asap.drain.abort', requestId: pending.activeId })
    pending.resolve(inertBatch())
    pending.release()
  }

  private scheduleRetry(pending: PendingDrain): void {
    this.pending.delete(pending.activeId)
    if (pending.retry) clearTimeout(pending.retry)
    const nextId = crypto.randomUUID()
    pending.activeId = nextId
    this.pending.set(nextId, pending)
    pending.retry = setTimeout(() => {
      pending.retry = null
      if (this.pending.get(nextId) !== pending || this.closedReason !== null) return
      this.send({ ...this.identity, type: 'asap.drain.request', requestId: nextId })
    }, BUSY_RETRY_MS)
  }
}
