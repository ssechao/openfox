import { afterEach, describe, expect, it } from 'vitest'
import { askUserTool, getPendingQuestionsForSession } from '../../tools/ask.js'
import { getPendingConfirmationsBySession, registerPathConfirmation } from '../../tools/path-security.js'
import { WorkerInteractiveClient } from './interactive-client.js'
import { MAX_MCP_REQUEST_BYTES } from './mcp-broker.js'
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerToGatewayMessage } from './protocol.js'

const identity: WorkerIpcIdentity = { sessionId: 'session-1', workerId: 'worker-1', generation: 1 }
const clients: WorkerInteractiveClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close('test cleanup')
})

describe('WorkerInteractiveClient', () => {
  it('relays ask_user and accepts only the matching response identity', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerInteractiveClient(identity, (message) => sent.push(message))
    clients.push(client)

    const execution = askUserTool.execute(
      { question: 'Continue?', type: 'confirm' },
      { workdir: '/tmp', sessionId: identity.sessionId, sessionManager: {} as never, toolCallId: 'call-1' },
    )
    await expect(execution).rejects.toMatchObject({ name: 'AskUserInterrupt' })
    expect(sent[0]).toMatchObject({ ...identity, type: 'interactive.question.open', callId: 'call-1' })

    const requestId = (sent[0] as { requestId: string }).requestId
    client.handleMessage({
      ...identity,
      generation: 2,
      type: 'interactive.question.response',
      requestId,
      callId: 'call-1',
      answer: 'stale',
      skip: false,
    })
    expect(getPendingQuestionsForSession(identity.sessionId)).toHaveLength(1)

    client.handleMessage({
      ...identity,
      type: 'interactive.question.response',
      requestId,
      callId: 'call-1',
      answer: 'yes',
      skip: false,
    })
    expect(getPendingQuestionsForSession(identity.sessionId)).toEqual([])
  })

  it('rejects oversized prompts before IPC emission', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerInteractiveClient(identity, (message) => sent.push(message))
    clients.push(client)

    const execution = askUserTool.execute(
      { question: 'x'.repeat(MAX_MCP_REQUEST_BYTES) },
      {
        workdir: '/tmp',
        sessionId: identity.sessionId,
        sessionManager: {} as never,
        toolCallId: 'call-oversized',
      },
    )

    await expect(execution).rejects.toMatchObject({ name: 'AskUserInterrupt' })
    expect(sent).toEqual([])
    expect(client.pendingCount()).toBe(0)
    expect(getPendingQuestionsForSession(identity.sessionId)).toEqual([])
  })

  it('relays path confirmations and cancels them when the worker stops', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerInteractiveClient(identity, (message) => sent.push(message))
    clients.push(client)

    const pending = registerPathConfirmation(
      'path-1',
      ['/outside'],
      identity.sessionId,
      'read_file',
      '/work',
      'outside_workdir',
    )
    void pending.catch(() => {})
    expect(sent[0]).toMatchObject({ ...identity, type: 'interactive.path.open', callId: 'path-1' })
    expect(getPendingConfirmationsBySession()[identity.sessionId]).toHaveLength(1)

    client.cancelAll('worker stopped')
    await expect(pending).rejects.toThrow('worker stopped')
    expect(getPendingConfirmationsBySession()[identity.sessionId] ?? []).toEqual([])
  })

  it('rejects mismatched call ids and closes late responses', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerInteractiveClient(identity, (message) => sent.push(message))
    clients.push(client)

    const execution = askUserTool.execute(
      { question: 'Continue?' },
      { workdir: '/tmp', sessionId: identity.sessionId, sessionManager: {} as never, toolCallId: 'call-2' },
    )
    await expect(execution).rejects.toMatchObject({ name: 'AskUserInterrupt' })
    const requestId = (sent[0] as { requestId: string }).requestId

    const response: GatewayToWorkerMessage = {
      ...identity,
      type: 'interactive.question.response',
      requestId,
      callId: 'other-call',
      answer: 'yes',
      skip: false,
    }
    client.handleMessage(response)
    expect(getPendingQuestionsForSession(identity.sessionId)).toHaveLength(1)

    client.close('worker stopped')
    expect(getPendingQuestionsForSession(identity.sessionId)).toEqual([])
    client.handleMessage({ ...response, callId: 'call-2' })
    expect(getPendingQuestionsForSession(identity.sessionId)).toEqual([])
  })
})
