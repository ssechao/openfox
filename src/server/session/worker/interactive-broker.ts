import type {
  InteractiveOpenMessage,
  InteractivePathOpenMessage,
  InteractiveQuestionOpenMessage,
  WorkerInteractiveResponseMessage,
  WorkerIpcIdentity,
} from './protocol.js'
import { MAX_MCP_GLOBAL_IN_FLIGHT, MAX_MCP_REQUEST_BYTES, MAX_MCP_WORKER_IN_FLIGHT } from './mcp-broker.js'

export type InteractiveAnswerResult = 'answered' | 'rejected' | 'not-handled'

interface PendingInteractiveRequest {
  message: InteractiveOpenMessage
  kind: 'question' | 'path'
}

interface WorkerInteractiveBrokerDeps {
  isCurrent: (identity: WorkerIpcIdentity) => boolean
  send: (message: WorkerInteractiveResponseMessage) => void
  registerQuestion: (
    callId: string,
    sessionId: string,
    question: string,
    type: 'text' | 'confirm' | 'choice',
    options: InteractiveQuestionOpenMessage['options'],
  ) => Promise<string> | null
  registerPath: (
    callId: string,
    paths: string[],
    sessionId: string,
    tool: string,
    workdir: string,
    reason: InteractivePathOpenMessage['reason'],
  ) => Promise<boolean>
  answerQuestion: (callId: string, answer: string, skip: boolean) => boolean
  answerPath: (callId: string, approved: boolean, alwaysAllow: boolean) => boolean
  cancelQuestion: (callId: string, reason: string) => boolean
  cancelPath: (callId: string, reason: string) => boolean
}

function identityOf(message: WorkerIpcIdentity): WorkerIpcIdentity {
  return { sessionId: message.sessionId, workerId: message.workerId, generation: message.generation }
}

function workerKey(identity: WorkerIpcIdentity): string {
  return `${identity.sessionId}:${identity.workerId}:${identity.generation}`
}

function requestKey(message: WorkerIpcIdentity & { requestId: string }): string {
  return `${workerKey(message)}:${message.requestId}`
}

function callKey(kind: 'question' | 'path', callId: string): string {
  return `${kind}:${callId}`
}

export class WorkerInteractiveBroker {
  private readonly pending = new Map<string, PendingInteractiveRequest>()
  private readonly byCall = new Map<string, string>()
  private readonly perWorker = new Map<string, number>()

  constructor(private readonly deps: WorkerInteractiveBrokerDeps) {}

  pendingCount(): number {
    return this.pending.size
  }

  handleOpen(message: InteractiveOpenMessage): void {
    if (!this.deps.isCurrent(identityOf(message))) return
    const kind = message.type === 'interactive.question.open' ? 'question' : 'path'
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_MCP_REQUEST_BYTES) {
      this.reject(message, kind, `Interactive request exceeds ${MAX_MCP_REQUEST_BYTES} bytes`)
      return
    }
    const key = requestKey(message)
    const call = callKey(kind, message.callId)
    if (this.pending.has(key) || this.byCall.has(call)) {
      this.reject(message, kind, 'Duplicate interactive request')
      return
    }
    const owner = workerKey(message)
    const workerCount = this.perWorker.get(owner) ?? 0
    if (workerCount >= MAX_MCP_WORKER_IN_FLIGHT || this.pending.size >= MAX_MCP_GLOBAL_IN_FLIGHT) {
      this.reject(message, kind, 'Interactive in-flight limit reached')
      return
    }

    if (message.type === 'interactive.question.open') {
      const promise = this.deps.registerQuestion(
        message.callId,
        message.sessionId,
        message.question,
        message.questionType,
        message.options,
      )
      if (!promise) {
        this.reject(message, kind, 'Interactive call id is already pending')
        return
      }
      void promise.catch(() => {})
    } else {
      const promise = this.deps.registerPath(
        message.callId,
        message.paths,
        message.sessionId,
        message.tool,
        message.workdir,
        message.reason,
      )
      void promise.catch(() => {})
    }

    this.pending.set(key, { message, kind })
    this.byCall.set(call, key)
    this.perWorker.set(owner, workerCount + 1)
  }

  answerQuestion(callId: string, answer: string, skip: boolean): InteractiveAnswerResult {
    const entry = this.find('question', callId)
    if (!entry || entry.message.type !== 'interactive.question.open') return 'not-handled'
    if (!this.deps.isCurrent(identityOf(entry.message))) {
      this.cancelEntry(entry, 'Worker identity is no longer current', false)
      return 'rejected'
    }
    const response: WorkerInteractiveResponseMessage = {
      ...identityOf(entry.message),
      type: 'interactive.question.response',
      requestId: entry.message.requestId,
      callId,
      answer,
      skip,
    }
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_MCP_REQUEST_BYTES) return 'rejected'
    if (!this.deps.answerQuestion(callId, answer, skip)) {
      this.take(entry)
      return 'rejected'
    }
    this.deps.send(response)
    this.take(entry)
    return 'answered'
  }

  answerPath(callId: string, approved: boolean, alwaysAllow: boolean): boolean {
    const entry = this.find('path', callId)
    if (!entry || entry.message.type !== 'interactive.path.open') return false
    if (!this.deps.isCurrent(identityOf(entry.message))) {
      this.cancelEntry(entry, 'Worker identity is no longer current', false)
      return false
    }
    if (!this.deps.answerPath(callId, approved, alwaysAllow)) {
      this.take(entry)
      return false
    }
    this.sendPathResponse(entry.message, approved, alwaysAllow)
    this.take(entry)
    return true
  }

  relayResolvedPath(callId: string, approved: boolean, alwaysAllow: boolean): boolean {
    const entry = this.find('path', callId)
    if (!entry || entry.message.type !== 'interactive.path.open') return false
    if (!this.deps.isCurrent(identityOf(entry.message))) {
      this.take(entry)
      return false
    }
    this.sendPathResponse(entry.message, approved, alwaysAllow)
    this.take(entry)
    return true
  }

  cancelWorker(identity: WorkerIpcIdentity, reason: string): void {
    for (const entry of [...this.pending.values()]) {
      const message = entry.message
      if (
        message.sessionId === identity.sessionId &&
        message.workerId === identity.workerId &&
        message.generation === identity.generation
      ) {
        this.cancelEntry(entry, reason, true)
      }
    }
  }

  private find(kind: 'question' | 'path', callId: string): PendingInteractiveRequest | undefined {
    const key = this.byCall.get(callKey(kind, callId))
    return key ? this.pending.get(key) : undefined
  }

  private take(entry: PendingInteractiveRequest): void {
    const key = requestKey(entry.message)
    if (!this.pending.delete(key)) return
    this.byCall.delete(callKey(entry.kind, entry.message.callId))
    const owner = workerKey(entry.message)
    const remaining = (this.perWorker.get(owner) ?? 1) - 1
    if (remaining === 0) this.perWorker.delete(owner)
    else this.perWorker.set(owner, remaining)
  }

  private cancelEntry(entry: PendingInteractiveRequest, reason: string, notify: boolean): void {
    if (entry.kind === 'question') this.deps.cancelQuestion(entry.message.callId, reason)
    else this.deps.cancelPath(entry.message.callId, reason)
    if (notify && this.deps.isCurrent(identityOf(entry.message))) this.reject(entry.message, entry.kind, reason)
    this.take(entry)
  }

  private reject(message: InteractiveOpenMessage, kind: 'question' | 'path', reason: string): void {
    this.deps.send({
      ...identityOf(message),
      type: 'interactive.cancelled',
      requestId: message.requestId,
      callId: message.callId,
      kind,
      reason,
    })
  }

  private sendPathResponse(message: InteractivePathOpenMessage, approved: boolean, alwaysAllow: boolean): void {
    this.deps.send({
      ...identityOf(message),
      type: 'interactive.path.response',
      requestId: message.requestId,
      callId: message.callId,
      approved,
      alwaysAllow,
    })
  }
}
