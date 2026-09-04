import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildContextMessagesFromEventHistory, buildMessagesFromStoredEvents } from './folding.js'
import { EventStore } from './store.js'
import { createTurnEventSink, TRANSIENT_TURN_EVENT_TYPES } from './turn-event-sink.js'

describe('turn event persistence', () => {
  let db: Database.Database
  let store: EventStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new EventStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('broadcasts streaming events without inserting them and consolidates the terminal message', async () => {
    const sink = createTurnEventSink(store, 'session-1')
    const subscription = store.subscribe('session-1')
    const received: string[] = []
    const consume = (async () => {
      for await (const event of subscription.iterator) {
        received.push(event.type)
        if (event.type === 'message.done') break
      }
    })()

    sink({
      type: 'message.start',
      data: { messageId: 'assistant-1', role: 'assistant' },
    })
    sink({ type: 'message.delta', data: { messageId: 'assistant-1', content: 'Hello ' } })
    sink({ type: 'message.thinking', data: { messageId: 'assistant-1', content: 'Reasoning' } })
    sink({ type: 'message.delta', data: { messageId: 'assistant-1', content: 'world' } })
    sink({
      type: 'tool.preparing',
      data: { messageId: 'assistant-1', index: 0, name: 'read_file' },
    })
    sink({
      type: 'tool.output',
      data: { messageId: 'assistant-1', toolCallId: 'call-1', stream: 'stdout', content: 'live' },
    })
    sink({ type: 'message.done', data: { messageId: 'assistant-1', partial: true } })

    await consume
    subscription.unsubscribe()

    expect(received).toEqual([
      'message.start',
      'message.delta',
      'message.thinking',
      'message.delta',
      'tool.preparing',
      'tool.output',
      'message.done',
    ])

    const rows = db.prepare('SELECT event_type FROM events ORDER BY seq').all() as Array<{ event_type: string }>
    expect(rows.map((row) => row.event_type)).toEqual(['message.start', 'message.done'])

    const messages = buildMessagesFromStoredEvents(store.getEvents('session-1')).messages
    expect(messages[0]).toMatchObject({
      id: 'assistant-1',
      content: 'Hello world',
      thinkingContent: 'Reasoning',
      partial: true,
      isStreaming: false,
    })
    expect(buildContextMessagesFromEventHistory(store.getEvents('session-1'))).toEqual([
      { role: 'assistant', content: 'Hello world', thinkingContent: 'Reasoning' },
    ])
  })

  it('consolidates an unfinished stream before the next message starts', () => {
    const sink = createTurnEventSink(store, 'session-1')
    sink({ type: 'message.start', data: { messageId: 'assistant-1', role: 'assistant' } })
    sink({ type: 'message.delta', data: { messageId: 'assistant-1', content: 'Partial' } })
    sink({ type: 'message.start', data: { messageId: 'correction-1', role: 'user', content: 'Retry' } })

    expect(store.getEvents('session-1').map((event) => event.type)).toEqual([
      'message.start',
      'message.done',
      'message.start',
    ])
    expect(buildMessagesFromStoredEvents(store.getEvents('session-1')).messages[0]).toMatchObject({
      id: 'assistant-1',
      content: 'Partial',
      isStreaming: false,
    })
  })

  it('reduces persisted rows by at least eighty percent for a streamed message', () => {
    const sink = createTurnEventSink(store, 'session-1')
    sink({ type: 'message.start', data: { messageId: 'assistant-1', role: 'assistant' } })
    for (let index = 0; index < 100; index += 1) {
      sink({ type: 'message.delta', data: { messageId: 'assistant-1', content: 'x' } })
    }
    sink({ type: 'message.done', data: { messageId: 'assistant-1' } })

    const persistedCount = (db.prepare('SELECT COUNT(*) count FROM events').get() as { count: number }).count
    expect(persistedCount).toBeLessThanOrEqual(102 * 0.2)
  })

  it('persists terminal tool calls and results', () => {
    const sink = createTurnEventSink(store, 'session-1')
    sink({ type: 'message.start', data: { messageId: 'assistant-1', role: 'assistant' } })
    sink({
      type: 'tool.call',
      data: { messageId: 'assistant-1', toolCall: { id: 'call-1', name: 'read_file', arguments: { path: 'a' } } },
    })
    sink({
      type: 'tool.result',
      data: {
        messageId: 'assistant-1',
        toolCallId: 'call-1',
        result: { success: true, output: 'ok', durationMs: 1, truncated: false },
      },
    })
    sink({ type: 'message.done', data: { messageId: 'assistant-1' } })

    expect(store.getEvents('session-1').map((event) => event.type)).toEqual([
      'message.start',
      'tool.call',
      'tool.result',
      'message.done',
    ])
  })

  it('keeps the transient event set explicit and persists other events by default', () => {
    expect([...TRANSIENT_TURN_EVENT_TYPES]).toEqual([
      'message.delta',
      'message.thinking',
      'tool.preparing',
      'tool.output',
    ])

    const sink = createTurnEventSink(store, 'session-1')
    sink({ type: 'phase.changed', data: { phase: 'build' } })
    expect(store.getEvents('session-1').map((event) => event.type)).toEqual(['phase.changed'])
  })

  it('restores a bounded partial checkpoint after a process restart', () => {
    const sink = createTurnEventSink(store, 'session-1')
    const content = 'x'.repeat(16 * 1024)
    sink({ type: 'message.start', data: { messageId: 'assistant-1', role: 'assistant' } })
    sink({ type: 'message.delta', data: { messageId: 'assistant-1', content } })

    const checkpointEvents = store.getEvents('session-1')
    expect(checkpointEvents.map((event) => event.type)).toEqual(['message.start', 'message.checkpoint'])
    expect(buildMessagesFromStoredEvents(checkpointEvents).messages[0]).toMatchObject({ content, isStreaming: true })

    const restartedStore = new EventStore(db)
    expect(restartedStore.recoverMessageCheckpoints()).toBe(1)
    const events = restartedStore.getEvents('session-1')
    expect(events.map((event) => event.type)).toEqual(['message.start', 'message.done'])
    expect(buildMessagesFromStoredEvents(events).messages[0]).toMatchObject({
      content,
      partial: true,
      isStreaming: false,
    })
  })
})
