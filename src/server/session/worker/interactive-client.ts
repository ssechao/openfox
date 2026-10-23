import { cancelQuestion, cancelQuestionsForSession, provideAnswer } from '../../tools/ask.js'
import {
  cancelPathConfirmation,
  cancelPathConfirmationsForSession,
  providePathConfirmation,
} from '../../tools/path-security.js'
import { setWorkerInteractiveRelay, type WorkerPathPrompt, type WorkerQuestionPrompt } from './interactive-relay.js'
import type {
  GatewayToWorkerMessage,
  InteractivePathOpenMessage,
  InteractiveQuestionOpenMessage,
  WorkerIpcIdentity,
  WorkerToGatewayMessage,
} from './protocol.js'

interface PendingPrompt {
  kind: 'question' | 'path'
  callId: string
}

function matchesIdentity(expected: WorkerIpcIdentity, message: WorkerIpcIdentity): boolean {
  return (
    expected.sessionId === message.sessionId &&
    expected.workerId === message.workerId &&
    expected.generation === message.generation
  )
}

export class WorkerInteractiveClient {
  private readonly pending = new Map<string, PendingPrompt>()
  private closed = false

  constructor(
    private readonly identity: WorkerIpcIdentity,
    private readonly send: (message: WorkerToGatewayMessage) => void,
  ) {
    setWorkerInteractiveRelay({
      question: (prompt) => this.openQuestion(prompt),
      path: (prompt) => this.openPath(prompt),
    })
  }

  pendingCount(): number {
    return this.pending.size
  }

  handleMessage(message: GatewayToWorkerMessage): void {
    if (
      (message.type !== 'interactive.question.response' &&
        message.type !== 'interactive.path.response' &&
        message.type !== 'interactive.cancelled') ||
      !matchesIdentity(this.identity, message)
    ) {
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending || pending.callId !== message.callId) return

    if (message.type === 'interactive.question.response' && pending.kind === 'question') {
      this.pending.delete(message.requestId)
      provideAnswer(message.callId, message.answer, message.skip)
    } else if (message.type === 'interactive.path.response' && pending.kind === 'path') {
      this.pending.delete(message.requestId)
      providePathConfirmation(message.callId, message.approved, message.alwaysAllow, false)
    } else if (message.type === 'interactive.cancelled' && message.kind === pending.kind) {
      this.pending.delete(message.requestId)
      if (pending.kind === 'question') cancelQuestion(message.callId, message.reason)
      else cancelPathConfirmation(message.callId, message.reason)
    }
  }

  cancelAll(reason: string): void {
    this.pending.clear()
    cancelQuestionsForSession(this.identity.sessionId, reason)
    cancelPathConfirmationsForSession(this.identity.sessionId, reason)
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    setWorkerInteractiveRelay(null)
    this.cancelAll(reason)
  }

  private openQuestion(prompt: WorkerQuestionPrompt): void {
    if (this.closed || prompt.sessionId !== this.identity.sessionId) {
      cancelQuestion(prompt.callId, 'Interactive IPC is unavailable')
      return
    }
    const requestId = crypto.randomUUID()
    this.pending.set(requestId, { kind: 'question', callId: prompt.callId })
    const message: InteractiveQuestionOpenMessage = {
      ...this.identity,
      type: 'interactive.question.open',
      requestId,
      callId: prompt.callId,
      question: prompt.question,
      questionType: prompt.type,
      ...(prompt.options ? { options: prompt.options } : {}),
    }
    this.send(message)
  }

  private openPath(prompt: WorkerPathPrompt): void {
    if (this.closed || prompt.sessionId !== this.identity.sessionId) {
      cancelPathConfirmation(prompt.callId, 'Interactive IPC is unavailable')
      return
    }
    const requestId = crypto.randomUUID()
    this.pending.set(requestId, { kind: 'path', callId: prompt.callId })
    const message: InteractivePathOpenMessage = {
      ...this.identity,
      type: 'interactive.path.open',
      requestId,
      callId: prompt.callId,
      paths: prompt.paths,
      tool: prompt.tool,
      workdir: prompt.workdir,
      reason: prompt.reason,
    }
    this.send(message)
  }
}
