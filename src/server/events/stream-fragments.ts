import type { TurnEvent } from './types.js'

export type StreamFragmentEvent = Extract<TurnEvent, { type: 'message.thinking' | 'message.delta' | 'tool.preparing' }>

export function isStreamFragment(event: TurnEvent): event is StreamFragmentEvent {
  return event.type === 'message.thinking' || event.type === 'message.delta' || event.type === 'tool.preparing'
}

export function streamFragmentKey(event: StreamFragmentEvent): string {
  switch (event.type) {
    case 'message.thinking':
      return `thinking\u0000${event.data.messageId}`
    case 'message.delta':
      return `delta\u0000${event.data.messageId}\u0000${event.data.subAgentType ?? ''}`
    case 'tool.preparing':
      return `preparing\u0000${event.data.messageId}\u0000${event.data.index}`
  }
}

export function mergeStreamFragments(pending: StreamFragmentEvent, next: StreamFragmentEvent): StreamFragmentEvent {
  if (pending.type === 'message.thinking' && next.type === 'message.thinking') {
    return { type: 'message.thinking', data: { ...pending.data, content: pending.data.content + next.data.content } }
  }
  if (pending.type === 'message.delta' && next.type === 'message.delta') {
    return { type: 'message.delta', data: { ...pending.data, content: pending.data.content + next.data.content } }
  }
  return next
}

export function streamFragmentGrowth(pending: StreamFragmentEvent | undefined, next: StreamFragmentEvent): number {
  if (next.type === 'tool.preparing') {
    if (pending?.type !== 'tool.preparing') return 0
    return Math.max(0, (next.data.arguments?.length ?? 0) - (pending.data.arguments?.length ?? 0))
  }
  return Buffer.byteLength(next.data.content, 'utf8')
}
