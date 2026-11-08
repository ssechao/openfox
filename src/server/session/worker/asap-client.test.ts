import { describe, expect, it, vi } from 'vitest'
import type { QueuedMessage } from '../../../shared/protocol.js'
import { WorkerAsapClient } from './asap-client.js'

const identity = { sessionId: 's-1', workerId: 'w-1', generation: 1 }

function queued(content: string, queueId = content): QueuedMessage {
  return { queueId, mode: 'asap', content, queuedAt: '2026-11-08T00:00:00.000Z' }
}

function response(requestId: string, messages: QueuedMessage[], generation = identity.generation) {
  return {
    ...identity,
    generation,
    type: 'asap.drain.response' as const,
    requestId,
    status: 'ok' as const,
    messages,
    queueState: [],
  }
}

describe('WorkerAsapClient', () => {
  it('returns one batch and acks only after commit', async () => {
    const send = vi.fn()
    const client = new WorkerAsapClient(identity, send, 200)
    const pending = client.drain()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const request = send.mock.calls[0]?.[0] as { type: string; requestId: string }
    expect(request.type).toBe('asap.drain.request')
    const messages = [queued('ack')]
    client.handleMessage(response(request.requestId, messages))
    const batch = await pending
    expect(batch.messages).toEqual(messages)
    expect(send).toHaveBeenCalledTimes(1)
    batch.commit()
    expect(send.mock.calls[1]?.[0]).toMatchObject({ type: 'asap.drain.ack', requestId: request.requestId })
    batch.commit()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('keeps a second drain waiting until the first one commits', async () => {
    const send = vi.fn()
    const client = new WorkerAsapClient(identity, send, 200)
    const first = client.drain()
    const second = client.drain()
    await Promise.resolve()
    const firstRequest = send.mock.calls[0]?.[0] as { requestId: string }
    expect(send).toHaveBeenCalledTimes(1)
    client.handleMessage(response(firstRequest.requestId, [queued('first')]))
    const firstBatch = await first
    expect(send).toHaveBeenCalledTimes(1)
    firstBatch.commit()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    const secondRequest = send.mock.calls[2]?.[0] as { type: string; requestId: string }
    expect(secondRequest.type).toBe('asap.drain.request')
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId)
    client.handleMessage(response(secondRequest.requestId, [queued('second')]))
    await expect(second).resolves.toMatchObject({ messages: [queued('second')] })
  })

  it('ignores a stale generation and a late payload after timeout', async () => {
    const send = vi.fn()
    const client = new WorkerAsapClient(identity, send, 40)
    const pending = client.drain()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    const request = send.mock.calls[0]?.[0] as { requestId: string }
    client.handleMessage(response(request.requestId, [queued('stale')], 2))
    await expect(pending).resolves.toEqual({
      messages: [],
      queueState: [],
      commit: expect.any(Function),
      abort: expect.any(Function),
    })
    expect(send.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      'asap.drain.request',
      'asap.drain.abort',
    ])
    client.handleMessage(response(request.requestId, [queued('late')]))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('aborts pending drains when closed and ignores a later response', async () => {
    const send = vi.fn()
    const client = new WorkerAsapClient(identity, send, 200)
    const pending = client.drain()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const request = send.mock.calls[0]?.[0] as { requestId: string }
    client.close('Worker turn finished')
    await expect(pending).resolves.toMatchObject({ messages: [] })
    expect(send.mock.calls[1]?.[0]).toMatchObject({ type: 'asap.drain.abort', requestId: request.requestId })
    client.handleMessage(response(request.requestId, [queued('late')]))
    await expect(client.drain()).resolves.toMatchObject({ messages: [] })
    expect(send).toHaveBeenCalledTimes(2)
  })
})
