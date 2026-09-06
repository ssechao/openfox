import type { TurnEvent } from '../events/types.js'
import type { PureStreamResult } from './stream-pure.js'

export const STREAM_FLUSH_INTERVAL_MS = 50
const MAX_BUFFERED_CHARACTERS = 64 * 1024

type BufferedEvent = Extract<
  TurnEvent,
  { type: 'message.delta' | 'message.thinking' | 'tool.output' | 'tool.preparing' }
>

// Coalesce before EventStore.append, so live subscriptions and replay consume
// the same durable events. Only adjacent events with identical targets merge.
export async function* coalesceStreamEvents(
  source: AsyncGenerator<TurnEvent, PureStreamResult>,
): AsyncGenerator<TurnEvent, PureStreamResult> {
  let pending: BufferedEvent | undefined
  let key = ''
  let deadline = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let tick: Promise<{ kind: 'flush' }> | undefined
  const readNext = () =>
    source.next().then(
      (value) => ({ kind: 'event' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
  let next = readNext()
  const take = () => {
    const event = pending
    pending = undefined
    clearTimeout(timer)
    timer = undefined
    tick = undefined
    return event!
  }

  try {
    while (true) {
      const outcome = tick ? await Promise.race([next, tick]) : await next
      if (outcome.kind === 'flush') {
        yield take()
        continue
      }
      if (outcome.kind === 'error') {
        if (pending) yield take()
        throw outcome.error
      }
      if (outcome.value.done) {
        if (pending) yield take()
        return outcome.value.value
      }
      const event = outcome.value.value
      if (pending && Date.now() >= deadline) yield take()
      if (
        event.type === 'message.delta' ||
        event.type === 'message.thinking' ||
        event.type === 'tool.output' ||
        event.type === 'tool.preparing'
      ) {
        const eventKey = JSON.stringify([
          event.type,
          event.data.messageId,
          event.type === 'tool.output'
            ? [event.data.toolCallId, event.data.stream]
            : event.type === 'tool.preparing'
              ? [event.data.index, event.data.name]
              : event.type === 'message.delta'
                ? event.data.subAgentType
                : null,
        ])
        if (pending && key !== eventKey) yield take()
        if (!pending) {
          pending = { ...event, data: { ...event.data } } as BufferedEvent
          key = eventKey
          deadline = Date.now() + STREAM_FLUSH_INTERVAL_MS
          tick = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'flush' }), STREAM_FLUSH_INTERVAL_MS)
          })
        } else if ('content' in pending.data && 'content' in event.data) {
          pending.data.content += event.data.content
        } else {
          // Preparing arguments are cumulative snapshots, not string deltas.
          pending = event
        }
        if ('content' in pending.data && pending.data.content.length >= MAX_BUFFERED_CHARACTERS) yield take()
      } else {
        if (pending) yield take()
        yield event
      }
      next = readNext()
    }
  } finally {
    clearTimeout(timer)
    await source.return(undefined as never)
  }
}
