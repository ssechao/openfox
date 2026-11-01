import { describe, expect, it, vi } from 'vitest'
import { WorkerBackgroundClient } from './background-client.js'

const identity = { sessionId: 's-1', workerId: 'w-1', generation: 1 }

describe('WorkerBackgroundClient', () => {
  it.fails('returns an explicit error when the gateway does not answer before the deadline', async () => {
    const send = vi.fn()
    const client = new WorkerBackgroundClient(identity, send, 20)

    await expect(client.execute('/tmp', { action: 'list' })).resolves.toEqual({
      ok: false,
      error: 'Background process request timed out after 20ms; the process state is unknown',
    })
  })

  it.fails('ignores a response carrying another worker identity', async () => {
    const send = vi.fn()
    const client = new WorkerBackgroundClient(identity, send, 50)
    const first = client.execute('/tmp', { action: 'list' })
    void first.catch(() => undefined)
    const firstRequest = send.mock.calls[0]?.[0] as { type: string; requestId: string } | undefined
    if (firstRequest?.type !== 'background.request') throw new Error('request not sent')

    client.handleMessage({
      ...identity,
      generation: 2,
      type: 'background.response',
      requestId: firstRequest.requestId,
      result: { ok: true, output: 'stale' },
    } as never)
    await expect(first).resolves.toEqual({
      ok: false,
      error: 'Background process request timed out after 50ms; the process state is unknown',
    })

    const second = client.execute('/tmp', { action: 'list' })
    const secondRequest = send.mock.calls[1]?.[0] as { type: string; requestId: string } | undefined
    if (secondRequest?.type !== 'background.request') throw new Error('request not sent')
    const result = { ok: true as const, output: 'current' }
    client.handleMessage({
      ...identity,
      type: 'background.response',
      requestId: secondRequest.requestId,
      result,
    } as never)
    await expect(second).resolves.toEqual(result)
  })

  it.fails('fails pending requests when closed', async () => {
    const send = vi.fn()
    const client = new WorkerBackgroundClient(identity, send)
    const pending = client.execute('/tmp', { action: 'list' })
    void pending.catch(() => undefined)

    client.close('Worker turn finished')

    await expect(pending).resolves.toEqual({ ok: false, error: 'Worker turn finished' })
    await expect(client.execute('/tmp', { action: 'list' })).resolves.toEqual({
      ok: false,
      error: 'Worker turn finished',
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
