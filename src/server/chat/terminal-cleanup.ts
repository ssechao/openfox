import type { ServerMessage } from '../../shared/protocol.js'
import type { TurnEvent } from '../events/types.js'
import { createMessageDoneEvent } from './stream-pure.js'
import { createChatMessageUpdatedMessage } from '../ws/protocol.js'

/**
 * Tracks the assistant messages that are still streaming inside one turn.
 *
 * A message becomes visible as soon as its `message.start` is appended, and
 * only `message.done` clears `isStreaming` when the state is replayed. Every
 * terminal path that skips `message.done` — a backend that throws mid-stream,
 * an abort, an unexpected EOF, a callback exception, an executor shutdown —
 * leaves the turn displayed as active with no producer behind it.
 *
 * The tracker observes the turn's single append path, so no call site has to
 * remember to close anything, and `finalize` is idempotent: a message already
 * closed by the normal path is no longer open, so no second, contradictory
 * terminal event can follow.
 */
export interface StreamLifecycleTracker {
  /** Feed every event written by the turn. */
  observe(event: TurnEvent): void
  /** Assistant messages started but not yet closed. */
  openMessageIds(): string[]
  /** Close whatever is still open. Returns the ids that had to be closed. */
  finalize(append: (event: TurnEvent) => void, onMessage?: (msg: ServerMessage) => void): string[]
}

export function createStreamLifecycleTracker(): StreamLifecycleTracker {
  const open = new Set<string>()

  return {
    observe(event: TurnEvent): void {
      if (event.type === 'message.start') {
        if (event.data.role === 'assistant') open.add(event.data.messageId)
        return
      }
      if (event.type === 'message.done') {
        open.delete(event.data.messageId)
      }
    },

    openMessageIds: (): string[] => [...open],

    finalize(append: (event: TurnEvent) => void, onMessage?: (msg: ServerMessage) => void): string[] {
      const closed = [...open]
      for (const messageId of closed) {
        // `partial: true` is the truth here: the producer disappeared before the
        // message was complete. Nothing is invented and nothing is hidden.
        append(createMessageDoneEvent(messageId, { partial: true }))
        onMessage?.(createChatMessageUpdatedMessage(messageId, { isStreaming: false, partial: true }))
      }
      open.clear()
      return closed
    },
  }
}
