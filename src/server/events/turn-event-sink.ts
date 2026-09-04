import type { EventStore } from './store.js'
import type { TurnEvent } from './types.js'

export const TRANSIENT_TURN_EVENT_TYPES = new Set<TurnEvent['type']>([
  'message.delta',
  'message.thinking',
  'tool.preparing',
  'tool.output',
])

const CHECKPOINT_INTERVAL_MS = 2000
const CHECKPOINT_INTERVAL_CHARS = 16 * 1024

export function createTurnEventSink(store: EventStore, sessionId: string): (event: TurnEvent) => void {
  const contentByMessage = new Map<string, string>()
  const thinkingByMessage = new Map<string, string>()
  const checkpointState = new Map<string, { size: number; timestamp: number }>()

  const checkpoint = (messageId: string) => {
    const content = contentByMessage.get(messageId) ?? ''
    const thinkingContent = thinkingByMessage.get(messageId)
    const size = content.length + (thinkingContent?.length ?? 0)
    const timestamp = Date.now()
    const previous = checkpointState.get(messageId)
    if (
      previous &&
      size - previous.size < CHECKPOINT_INTERVAL_CHARS &&
      timestamp - previous.timestamp < CHECKPOINT_INTERVAL_MS
    ) {
      return
    }
    store.upsertMessageCheckpoint(sessionId, {
      messageId,
      content,
      ...(thinkingContent !== undefined && { thinkingContent }),
    })
    checkpointState.set(messageId, { size, timestamp })
  }

  const flushBefore = (nextMessageId: string) => {
    const pendingIds = new Set([...contentByMessage.keys(), ...thinkingByMessage.keys()])
    for (const messageId of pendingIds) {
      if (messageId === nextMessageId) continue
      const content = contentByMessage.get(messageId)
      const thinkingContent = thinkingByMessage.get(messageId)
      store.append(sessionId, {
        type: 'message.done',
        data: {
          messageId,
          ...(content !== undefined && { content }),
          ...(thinkingContent !== undefined && { thinkingContent }),
          partial: true,
        },
      })
      store.deleteMessageCheckpoint(sessionId, messageId)
      contentByMessage.delete(messageId)
      thinkingByMessage.delete(messageId)
      checkpointState.delete(messageId)
    }
  }

  return (incomingEvent) => {
    let event = incomingEvent
    let completedMessageId: string | undefined

    if (event.type === 'message.start') {
      flushBefore(event.data.messageId)
      contentByMessage.delete(event.data.messageId)
      thinkingByMessage.delete(event.data.messageId)
      checkpointState.delete(event.data.messageId)
    } else if (event.type === 'message.delta') {
      contentByMessage.set(
        event.data.messageId,
        (contentByMessage.get(event.data.messageId) ?? '') + event.data.content,
      )
      checkpoint(event.data.messageId)
    } else if (event.type === 'message.thinking') {
      thinkingByMessage.set(
        event.data.messageId,
        (thinkingByMessage.get(event.data.messageId) ?? '') + event.data.content,
      )
      checkpoint(event.data.messageId)
    } else if (event.type === 'message.done') {
      const content = contentByMessage.get(event.data.messageId)
      const thinkingContent = thinkingByMessage.get(event.data.messageId)
      event = {
        ...event,
        data: {
          ...event.data,
          ...(content !== undefined && { content }),
          ...(thinkingContent !== undefined && { thinkingContent }),
        },
      }
      completedMessageId = event.data.messageId
      contentByMessage.delete(event.data.messageId)
      thinkingByMessage.delete(event.data.messageId)
      checkpointState.delete(event.data.messageId)
    }

    if (TRANSIENT_TURN_EVENT_TYPES.has(event.type)) {
      store.publish(sessionId, event)
    } else {
      store.append(sessionId, event)
    }

    if (completedMessageId !== undefined) {
      store.deleteMessageCheckpoint(sessionId, completedMessageId)
    }
  }
}
