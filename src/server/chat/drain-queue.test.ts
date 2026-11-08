import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueuedMessage } from '../../shared/protocol.js'
import type { StoredEvent } from '../events/types.js'
import { drainQueue, setAsapQueueDrain, type AsapDrainBatch } from './drain-queue.js'

const { events } = vi.hoisted(() => ({
  events: [] as StoredEvent[],
}))

vi.mock('../events/index.js', () => ({
  getCurrentWindowMessageOptions: () => ({ contextWindowId: 'window-1' }),
  getEventStore: () => ({
    getEvents: () => events,
  }),
}))

function queued(content: string, extras: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    queueId: `id-${content}`,
    mode: 'asap',
    content,
    queuedAt: '2026-11-08T00:00:00.000Z',
    ...extras,
  }
}

function batch(
  messages: QueuedMessage[],
  queueState: QueuedMessage[] = [],
): AsapDrainBatch & {
  commits: number
  aborts: number
} {
  const state = { commits: 0, aborts: 0, messages, queueState, commit() {}, abort() {} }
  state.commit = () => {
    state.commits += 1
  }
  state.abort = () => {
    state.aborts += 1
  }
  return state
}

describe('drainQueue', () => {
  afterEach(() => {
    events.length = 0
    setAsapQueueDrain(null)
  })

  it('keeps order, attachments, message kind, and the classic event sequence', async () => {
    const first = queued('one', {
      attachments: [{ id: 'file-1', filename: 'note.txt', mimeType: 'text/plain', size: 4, data: 'note' }],
    })
    const second = queued('two', { messageKind: 'command' })
    const background = queued('exit', { messageKind: 'background-exit' })
    const remaining = queued('later', { mode: 'completion' })
    const drained = batch([first, second, background], [remaining])
    const sessionManager = {
      drainAsapMessages: vi.fn(() => {
        throw new Error('local queue')
      }),
      getQueueState: vi.fn(),
    }
    const appended: Array<{ type: string; data: Record<string, unknown> }> = []
    const outbound: Array<{ type: string; payload: Record<string, unknown> }> = []
    setAsapQueueDrain(() => drained)

    const result = await drainQueue(
      sessionManager as never,
      'session-1',
      (event) => {
        appended.push(event as { type: string; data: Record<string, unknown> })
        events.push(event as StoredEvent)
      },
      (message) => outbound.push(message as { type: string; payload: Record<string, unknown> }),
    )

    expect(sessionManager.drainAsapMessages).not.toHaveBeenCalled()
    expect(result.messages.map((message) => message.content)).toEqual(['one', 'two', 'exit'])
    expect(appended.map((event) => event.type)).toEqual([
      'message.start',
      'message.done',
      'message.start',
      'message.done',
      'message.start',
      'message.done',
    ])
    expect(appended[0]?.data).toMatchObject({
      messageId: 'id-one',
      role: 'user',
      content: 'one',
      contextWindowId: 'window-1',
      attachments: first.attachments,
    })
    expect(appended[2]?.data).toMatchObject({ messageId: 'id-two', content: 'two', messageKind: 'command' })
    expect(appended[4]?.data).toMatchObject({
      messageId: 'id-exit',
      content: 'exit',
      messageKind: 'auto-prompt',
      isSystemGenerated: true,
    })
    expect(outbound.map((message) => message.type)).toEqual([
      'chat.message',
      'chat.done',
      'chat.message',
      'chat.done',
      'chat.message',
      'chat.done',
      'queue.state',
    ])
    expect(outbound[0]?.payload['message']).toMatchObject({
      id: 'id-one',
      content: 'one',
      attachments: first.attachments,
    })
    expect(outbound[2]?.payload['message']).toMatchObject({ id: 'id-two', messageKind: 'command' })
    expect(outbound[4]?.payload['message']).toMatchObject({
      id: 'id-exit',
      messageKind: 'auto-prompt',
      isSystemGenerated: true,
    })
    expect(outbound[6]?.payload).toEqual({ messages: [remaining] })
    expect(drained.commits).toBe(1)
    expect(drained.aborts).toBe(0)
  })

  it('appends a repeated delivery only once', async () => {
    const drained = batch([queued('one'), queued('two')])
    setAsapQueueDrain(() => drained)
    const append = (event: StoredEvent) => {
      events.push(event)
    }
    await drainQueue({} as never, 'session-1', append as never)
    await drainQueue({} as never, 'session-1', append as never)
    expect(events.filter((event) => event.type === 'message.start')).toHaveLength(2)
    expect(drained.commits).toBe(2)
  })

  it('returns a failed delivery to the gateway when appending throws', async () => {
    const drained = batch([queued('one')])
    setAsapQueueDrain(() => drained)
    await expect(
      drainQueue({} as never, 'session-1', () => {
        throw new Error('disk')
      }),
    ).rejects.toThrow('disk')
    expect(drained.commits).toBe(0)
    expect(drained.aborts).toBe(1)
    expect(events).toEqual([])
  })

  it('still drains the local queue when no gateway drain is installed', async () => {
    const message = queued('local', { messageKind: 'command' })
    const sessionManager = {
      drainAsapMessages: vi.fn(() => [message]),
      getQueueState: vi.fn(() => []),
    }
    const appended: Array<{ type: string; data: { content?: string; messageKind?: string } }> = []
    await drainQueue(sessionManager as never, 'session-1', (event) => {
      appended.push(event as { type: string; data: { content?: string; messageKind?: string } })
      events.push(event as StoredEvent)
    })
    expect(sessionManager.drainAsapMessages).toHaveBeenCalledWith('session-1')
    expect(appended[0]?.data).toMatchObject({ content: 'local', messageKind: 'command' })
  })
})
