import { describe, expect, it, vi } from 'vitest'
import type { TurnEvent } from '../events/types.js'
import type { ServerMessage } from '../../shared/protocol.js'
import { createStreamLifecycleTracker } from './terminal-cleanup.js'

/**
 * Finding C (remediation plan): terminal cleanup must be centralized and
 * idempotent — it can never emit two contradictory terminal states for the
 * same message.
 */
describe('createStreamLifecycleTracker', () => {
  const startAssistant = (messageId: string): TurnEvent =>
    ({ type: 'message.start', data: { messageId, role: 'assistant' } }) as TurnEvent

  const done = (messageId: string): TurnEvent => ({ type: 'message.done', data: { messageId } }) as TurnEvent

  function collector() {
    const events: TurnEvent[] = []
    const messages: ServerMessage[] = []
    return {
      events,
      messages,
      append: (event: TurnEvent) => events.push(event),
      onMessage: (msg: ServerMessage) => messages.push(msg),
    }
  }

  it('closes an assistant message whose producer disappeared', () => {
    const tracker = createStreamLifecycleTracker()
    const sink = collector()

    tracker.observe(startAssistant('msg-1'))
    expect(tracker.openMessageIds()).toEqual(['msg-1'])

    expect(tracker.finalize(sink.append, sink.onMessage)).toEqual(['msg-1'])
    expect(sink.events).toEqual([{ type: 'message.done', data: { messageId: 'msg-1', partial: true } }])
    expect(sink.messages).toEqual([
      { type: 'chat.message_updated', payload: { messageId: 'msg-1', updates: { isStreaming: false, partial: true } } },
    ])
  })

  it('emits nothing when the message was already closed normally', () => {
    const tracker = createStreamLifecycleTracker()
    const sink = collector()

    tracker.observe(startAssistant('msg-1'))
    tracker.observe(done('msg-1'))

    expect(tracker.openMessageIds()).toEqual([])
    expect(tracker.finalize(sink.append, sink.onMessage)).toEqual([])
    expect(sink.events).toEqual([])
    expect(sink.messages).toEqual([])
  })

  it('is idempotent across repeated finalize calls', () => {
    const tracker = createStreamLifecycleTracker()
    const sink = collector()

    tracker.observe(startAssistant('msg-1'))
    tracker.finalize(sink.append, sink.onMessage)
    expect(tracker.finalize(sink.append, sink.onMessage)).toEqual([])
    expect(sink.events).toHaveLength(1)
    expect(sink.messages).toHaveLength(1)
  })

  it('closes the done event through the same append path so re-entry is impossible', () => {
    const tracker = createStreamLifecycleTracker()
    const events: TurnEvent[] = []
    const append = vi.fn((event: TurnEvent) => {
      tracker.observe(event)
      events.push(event)
    })

    tracker.observe(startAssistant('msg-1'))
    tracker.finalize(append)

    expect(append).toHaveBeenCalledTimes(1)
    expect(tracker.openMessageIds()).toEqual([])
  })

  it('ignores user and system messages', () => {
    const tracker = createStreamLifecycleTracker()
    const sink = collector()

    tracker.observe({ type: 'message.start', data: { messageId: 'u-1', role: 'user', content: 'hi' } } as TurnEvent)
    tracker.observe({ type: 'message.start', data: { messageId: 's-1', role: 'system', content: 'x' } } as TurnEvent)

    expect(tracker.openMessageIds()).toEqual([])
    expect(tracker.finalize(sink.append, sink.onMessage)).toEqual([])
  })

  it('closes every open assistant message, in start order', () => {
    const tracker = createStreamLifecycleTracker()
    const sink = collector()

    tracker.observe(startAssistant('msg-1'))
    tracker.observe(startAssistant('sub-agent-1'))
    tracker.observe(done('sub-agent-1'))
    tracker.observe(startAssistant('msg-2'))

    expect(tracker.finalize(sink.append, sink.onMessage)).toEqual(['msg-1', 'msg-2'])
    expect(sink.events.map((e) => (e.data as { messageId: string }).messageId)).toEqual(['msg-1', 'msg-2'])
  })
})
