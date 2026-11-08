import { describe, expect, it, vi } from 'vitest'
import type { QueuedMessage } from '../../../shared/protocol.js'
import type { AsapDrainResponseMessage, WorkerIpcIdentity } from './protocol.js'
import { WorkerAsapBroker } from './asap-broker.js'

const identity: WorkerIpcIdentity = { sessionId: 's-1', workerId: 'w-1', generation: 1 }

function queued(content: string, extras: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    queueId: content,
    mode: 'asap',
    content,
    queuedAt: '2026-11-08T00:00:00.000Z',
    ...extras,
  }
}

function harness(holdMs = 40) {
  let queue: QueuedMessage[] = []
  let current = true
  const send = vi.fn()
  const onRestored = vi.fn()
  const commitAsap = vi.fn()
  const broker = new WorkerAsapBroker({
    isCurrent: () => current,
    send,
    takeAsap: () => {
      const asap = queue.filter((message) => message.mode === 'asap')
      queue = queue.filter((message) => message.mode !== 'asap')
      return asap
    },
    restoreAsap: (_sessionId, messages) => {
      const present = new Set(queue.map((message) => message.queueId))
      queue = [...messages.filter((message) => !present.has(message.queueId)), ...queue]
    },
    commitAsap,
    queueState: () => [...queue],
    onRestored,
    holdMs,
  })
  return {
    broker,
    send,
    onRestored,
    commitAsap,
    setCurrent: (value: boolean) => {
      current = value
    },
    setQueue: (messages: QueuedMessage[]) => {
      queue = messages
    },
    queue: () => queue,
  }
}

function request(requestId: string, generation = identity.generation) {
  return { ...identity, generation, type: 'asap.drain.request' as const, requestId }
}

describe('WorkerAsapBroker', () => {
  it('removes asap messages once and repeats the same payload for the same request', () => {
    const { broker, send, queue, setQueue } = harness()
    const first = queued('one', { attachments: [{ id: 'a', filename: 'n.txt', mimeType: 'text/plain', size: 1 }] })
    const second = queued('two', { messageKind: 'command' })
    setQueue([first, queued('keep', { mode: 'completion' }), second])
    broker.handleRequest(request('r-1'))
    broker.handleRequest(request('r-1'))
    broker.handleAck({ ...identity, type: 'asap.drain.ack', requestId: 'r-1' })
    expect(queue().map((message) => message.content)).toEqual(['keep'])
    expect(send).toHaveBeenCalledTimes(2)
    const payloads = send.mock.calls.map((call) => call[0] as AsapDrainResponseMessage)
    expect(payloads[0]).toMatchObject({ status: 'ok', messages: [first, second], queueState: queue() })
    expect(payloads[1]?.messages).toEqual(payloads[0]?.messages)
  })

  it('does not drain a second concurrent request', () => {
    const { broker, send, queue, setQueue } = harness()
    setQueue([queued('one'), queued('two')])
    broker.handleRequest(request('r-1'))
    broker.handleRequest(request('r-2'))
    broker.handleAck({ ...identity, type: 'asap.drain.ack', requestId: 'r-1' })
    expect(queue()).toEqual([])
    const second = send.mock.calls[1]?.[0] as AsapDrainResponseMessage
    expect(second).toMatchObject({ requestId: 'r-2', status: 'busy', messages: [] })
  })

  it('commits exactly once and ignores a late ack', async () => {
    const { broker, queue, setQueue, onRestored, commitAsap } = harness(30)
    const message = queued('one')
    setQueue([message])
    broker.handleRequest(request('r-1'))
    expect(queue()).toEqual([])
    broker.handleAck({ ...identity, type: 'asap.drain.ack', requestId: 'r-1' })
    expect(commitAsap).toHaveBeenCalledTimes(1)
    expect(commitAsap).toHaveBeenCalledWith('s-1', [message])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(queue()).toEqual([])
    expect(onRestored).not.toHaveBeenCalled()
    broker.handleAck({ ...identity, type: 'asap.drain.ack', requestId: 'r-1' })
    expect(commitAsap).toHaveBeenCalledTimes(1)
    expect(queue()).toEqual([])
  })

  it('restores the same messages after timeout and ignores the late ack', async () => {
    const { broker, queue, setQueue, onRestored, commitAsap } = harness(30)
    const messages = [queued('one', { messageKind: 'command' }), queued('two')]
    setQueue(messages)
    broker.handleRequest(request('r-1'))
    expect(queue()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(queue()).toEqual(messages)
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(commitAsap).not.toHaveBeenCalled()
    broker.handleAck({ ...identity, type: 'asap.drain.ack', requestId: 'r-1' })
    expect(commitAsap).not.toHaveBeenCalled()
    expect(queue()).toEqual(messages)
  })

  it('leaves the queue untouched for a stale worker and restores when that worker exits', () => {
    const { broker, send, queue, setQueue, setCurrent } = harness()
    setQueue([queued('one')])
    setCurrent(false)
    broker.handleRequest(request('r-old', 1))
    expect(queue().map((message) => message.content)).toEqual(['one'])
    expect(send).not.toHaveBeenCalled()

    setCurrent(true)
    broker.handleRequest(request('r-new'))
    expect(queue()).toEqual([])
    broker.releaseWorker(identity)
    expect(queue().map((message) => message.content)).toEqual(['one'])
    broker.handleAck({ ...identity, type: 'asap.drain.ack', requestId: 'r-new' })
    expect(queue().map((message) => message.content)).toEqual(['one'])
  })

  it('gives a superseded generation back before the current worker drains', () => {
    const { broker, queue, setQueue, setCurrent } = harness()
    setQueue([queued('one')])
    broker.handleRequest(request('r-old'))
    expect(queue()).toEqual([])
    setCurrent(true)
    const replacement = { ...identity, workerId: 'w-2', generation: 2 }
    broker.handleRequest({ ...replacement, type: 'asap.drain.request', requestId: 'r-new' })
    const after = queue()
    expect(after).toEqual([])
    broker.handleAbort({ ...replacement, type: 'asap.drain.abort', requestId: 'r-new' })
    expect(queue().map((message) => message.content)).toEqual(['one'])
  })

  it('hold 100, clearMessageQueue, admit 100, then abort of the old hold restores 200', () => {
    const { broker, setQueue, queue } = harness()
    const held = Array.from({ length: 100 }, (_, index) => queued(`old-${index}`))
    const admitted = Array.from({ length: 100 }, (_, index) => queued(`new-${index}`))
    setQueue(held)
    broker.handleRequest(request('r-1'))
    const clearMessageQueue = () => setQueue([])
    clearMessageQueue()
    setQueue(admitted)
    broker.handleAbort({ ...identity, type: 'asap.drain.abort', requestId: 'r-1' })
    expect(queue()).toHaveLength(200)
    expect(queue().slice(0, 100)).toEqual(held)
    expect(queue().slice(100)).toEqual(admitted)
  })

  it('hold 100, clearMessageQueue, admit 100, then timeout of the old hold restores 200', async () => {
    const { broker, setQueue, queue } = harness(30)
    const held = Array.from({ length: 100 }, (_, index) => queued(`old-${index}`))
    const admitted = Array.from({ length: 100 }, (_, index) => queued(`new-${index}`))
    setQueue(held)
    broker.handleRequest(request('r-1'))
    const clearMessageQueue = () => setQueue([])
    clearMessageQueue()
    setQueue(admitted)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(queue()).toHaveLength(200)
    expect(queue().slice(0, 100)).toEqual(held)
    expect(queue().slice(100)).toEqual(admitted)
  })

  it('discards a hold without restoring it after a late abort or timeout', async () => {
    const { broker, queue, setQueue, onRestored, commitAsap } = harness(30)
    setQueue([queued('old')])
    broker.handleRequest(request('r-1'))
    broker.discardHold('s-1')
    setQueue([queued('fresh')])
    await new Promise((resolve) => setTimeout(resolve, 50))
    broker.handleAbort({ ...identity, type: 'asap.drain.abort', requestId: 'r-1' })
    expect(queue().map((message) => message.content)).toEqual(['fresh'])
    expect(onRestored).not.toHaveBeenCalled()
    expect(commitAsap).not.toHaveBeenCalled()
  })
})
