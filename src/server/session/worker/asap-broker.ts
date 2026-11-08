import type { QueuedMessage } from '../../../shared/protocol.js'
import type {
  AsapDrainAbortMessage,
  AsapDrainAckMessage,
  AsapDrainRequestMessage,
  AsapDrainResponseMessage,
  WorkerIpcIdentity,
} from './protocol.js'

export const ASAP_DRAIN_HOLD_MS = 3_000

interface HeldDrain {
  requestId: string
  workerId: string
  generation: number
  messages: QueuedMessage[]
  queueState: QueuedMessage[]
  timer: NodeJS.Timeout
}

interface WorkerAsapBrokerDeps {
  isCurrent: (identity: WorkerIpcIdentity) => boolean
  send: (message: AsapDrainResponseMessage) => void
  takeAsap: (sessionId: string) => QueuedMessage[]
  restoreAsap: (sessionId: string, messages: QueuedMessage[]) => void
  commitAsap: (sessionId: string, messages: QueuedMessage[]) => void
  queueState: (sessionId: string) => QueuedMessage[]
  onRestored?: ((sessionId: string) => void) | undefined
  holdMs?: number
}

function sameWorker(held: HeldDrain, identity: WorkerIpcIdentity): boolean {
  return held.workerId === identity.workerId && held.generation === identity.generation
}

export class WorkerAsapBroker {
  private readonly held = new Map<string, HeldDrain>()
  private readonly holdMs: number

  constructor(private readonly deps: WorkerAsapBrokerDeps) {
    this.holdMs = deps.holdMs ?? ASAP_DRAIN_HOLD_MS
  }

  handleRequest(message: AsapDrainRequestMessage): void {
    if (!this.deps.isCurrent(message)) return
    const previous = this.held.get(message.sessionId)
    if (previous && !sameWorker(previous, message)) {
      this.giveBack(message.sessionId, previous.requestId)
    }
    const current = this.held.get(message.sessionId)
    if (current) {
      if (current.requestId === message.requestId) {
        this.reply(message, 'ok', current.messages, current.queueState)
        return
      }
      this.reply(message, 'busy', [], this.deps.queueState(message.sessionId))
      return
    }

    const messages = this.deps.takeAsap(message.sessionId)
    const queueState = this.deps.queueState(message.sessionId)
    if (messages.length === 0) {
      this.reply(message, 'ok', [], queueState)
      return
    }
    const timer = setTimeout(() => this.giveBack(message.sessionId, message.requestId), this.holdMs)
    this.held.set(message.sessionId, {
      requestId: message.requestId,
      workerId: message.workerId,
      generation: message.generation,
      messages,
      queueState,
      timer,
    })
    this.reply(message, 'ok', messages, queueState)
  }

  handleAck(message: AsapDrainAckMessage): void {
    const current = this.held.get(message.sessionId)
    if (!current || current.requestId !== message.requestId || !sameWorker(current, message)) return
    clearTimeout(current.timer)
    this.held.delete(message.sessionId)
    this.deps.commitAsap(message.sessionId, current.messages)
  }

  handleAbort(message: AsapDrainAbortMessage): void {
    this.giveBack(message.sessionId, message.requestId, message)
  }

  releaseWorker(identity: WorkerIpcIdentity): void {
    const current = this.held.get(identity.sessionId)
    if (!current || !sameWorker(current, identity)) return
    this.giveBack(identity.sessionId, current.requestId)
  }

  discardHold(sessionId: string): void {
    const current = this.held.get(sessionId)
    if (!current) return
    clearTimeout(current.timer)
    this.held.delete(sessionId)
  }

  private giveBack(sessionId: string, requestId: string, identity?: WorkerIpcIdentity): void {
    const current = this.held.get(sessionId)
    if (!current || current.requestId !== requestId) return
    if (identity && !sameWorker(current, identity)) return
    clearTimeout(current.timer)
    this.held.delete(sessionId)
    this.deps.restoreAsap(sessionId, current.messages)
    this.deps.onRestored?.(sessionId)
  }

  private reply(
    message: WorkerIpcIdentity & { requestId: string },
    status: 'ok' | 'busy',
    messages: QueuedMessage[],
    queueState: QueuedMessage[],
  ): void {
    this.deps.send({
      sessionId: message.sessionId,
      workerId: message.workerId,
      generation: message.generation,
      type: 'asap.drain.response',
      requestId: message.requestId,
      status,
      messages,
      queueState,
    })
  }
}
