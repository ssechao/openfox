import { describe, expect, it, vi } from 'vitest'
import { WorkerInteractiveBroker } from './interactive-broker.js'
import { MAX_MCP_REQUEST_BYTES } from './mcp-broker.js'
import type { GatewayToWorkerMessage, InteractiveOpenMessage, WorkerIpcIdentity } from './protocol.js'

const identity: WorkerIpcIdentity = { sessionId: 'session-1', workerId: 'worker-1', generation: 1 }

function question(requestId = 'request-1', callId = 'call-1'): InteractiveOpenMessage {
  return {
    ...identity,
    type: 'interactive.question.open',
    requestId,
    callId,
    question: 'Continue?',
    questionType: 'confirm',
  }
}

function createHarness(current = true) {
  const sent: GatewayToWorkerMessage[] = []
  const registerQuestion = vi.fn(() => Promise.resolve('yes'))
  const registerPath = vi.fn(() => Promise.resolve(true))
  const answerQuestion = vi.fn(() => true)
  const answerPath = vi.fn(() => true)
  const cancelQuestion = vi.fn(() => true)
  const cancelPath = vi.fn(() => true)
  const broker = new WorkerInteractiveBroker({
    isCurrent: () => current,
    send: (message) => sent.push(message),
    registerQuestion,
    registerPath,
    answerQuestion,
    answerPath,
    cancelQuestion,
    cancelPath,
  })
  return { broker, sent, registerQuestion, registerPath, answerQuestion, answerPath, cancelQuestion, cancelPath }
}

describe('WorkerInteractiveBroker', () => {
  it('registers and resolves a question with the complete worker identity', () => {
    const { broker, sent, registerQuestion, answerQuestion } = createHarness()
    broker.handleOpen(question())

    expect(registerQuestion).toHaveBeenCalledWith('call-1', 'session-1', 'Continue?', 'confirm', undefined)
    expect(broker.pendingCount()).toBe(1)
    expect(broker.answerQuestion('call-1', 'yes', false)).toBe('answered')
    expect(answerQuestion).toHaveBeenCalledWith('call-1', 'yes', false)
    expect(sent).toEqual([
      {
        ...identity,
        type: 'interactive.question.response',
        requestId: 'request-1',
        callId: 'call-1',
        answer: 'yes',
        skip: false,
      },
    ])
    expect(broker.pendingCount()).toBe(0)
  })

  it('rejects oversized answers before resolving or emitting them', () => {
    const { broker, sent, answerQuestion } = createHarness()
    broker.handleOpen(question())

    expect(broker.answerQuestion('call-1', 'x'.repeat(MAX_MCP_REQUEST_BYTES), false)).toBe('rejected')
    expect(answerQuestion).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(broker.pendingCount()).toBe(1)
  })

  it('drops stale opens and late responses', () => {
    const stale = createHarness(false)
    stale.broker.handleOpen(question())
    expect(stale.registerQuestion).not.toHaveBeenCalled()

    const current = createHarness()
    current.broker.handleOpen(question())
    current.broker.cancelWorker(identity, 'worker stopped')
    expect(current.cancelQuestion).toHaveBeenCalledWith('call-1', 'worker stopped')
    expect(current.broker.answerQuestion('call-1', 'late', false)).toBe('not-handled')
    expect(current.sent).toEqual([
      {
        ...identity,
        type: 'interactive.cancelled',
        requestId: 'request-1',
        callId: 'call-1',
        kind: 'question',
        reason: 'worker stopped',
      },
    ])
  })

  it('bounds pending prompts per worker', () => {
    const { broker, sent, registerQuestion } = createHarness()
    for (let index = 0; index < 9; index++) broker.handleOpen(question(`request-${index}`, `call-${index}`))

    expect(registerQuestion).toHaveBeenCalledTimes(8)
    expect(broker.pendingCount()).toBe(8)
    expect(sent.at(-1)).toMatchObject({
      ...identity,
      type: 'interactive.cancelled',
      requestId: 'request-8',
      callId: 'call-8',
      kind: 'question',
    })
  })
})
