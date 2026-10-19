import { describe, expect, it } from 'vitest'
import { applyEvents } from './apply-events.js'
import type { StoredEvent, TurnEvent } from './types.js'

type Msg = Parameters<typeof applyEvents>[0][number]

function stored(events: TurnEvent[]): StoredEvent[] {
  return events.map((event, i) => ({ ...event, seq: i + 1, sessionId: 's', timestamp: i + 1 }))
}

function output(toolCallId: string, content: string): TurnEvent {
  return { type: 'tool.output', data: { messageId: 'ignored', toolCallId, stream: 'stdout', content } }
}

function assistant(id: string, toolCallIds: string[]): Msg {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: toolCallIds.map((tc) => ({ id: tc, name: 'run_command', arguments: {} })),
  }
}

function streamed(
  messages: ReadonlyArray<{ id: string; toolCalls?: Array<{ id: string; streamingOutput?: unknown[] }> }>,
  messageId: string,
  toolCallId: string,
): string[] {
  const tc = messages.find((m) => m.id === messageId)?.toolCalls?.find((t) => t.id === toolCallId)
  return ((tc?.streamingOutput ?? []) as Array<{ content: string }>).map((o) => o.content)
}

describe('applyEvents tool.output routing', () => {
  it('routes output to the message owning the call among many messages', () => {
    const initial = Array.from({ length: 5000 }, (_, i) => assistant(`m${i}`, [`t${i}`]))
    const result = applyEvents(initial, stored([output('t4999', 'last'), output('t0', 'first')]), {
      timestampAsNumber: true,
    })
    expect(streamed(result, 'm4999', 't4999')).toEqual(['last'])
    expect(streamed(result, 'm0', 't0')).toEqual(['first'])
  })

  it('routes output to a call attached during the same replay', () => {
    const result = applyEvents(
      [assistant('m1', ['t1'])],
      stored([
        output('t1', 'a'),
        { type: 'message.start', data: { messageId: 'm2', role: 'assistant', content: '' } },
        {
          type: 'tool.call',
          data: { messageId: 'm2', toolCall: { id: 't2', name: 'run_command', arguments: {}, startedAt: 1 } },
        },
        output('t2', 'b'),
      ]),
      { timestampAsNumber: true },
    )
    expect(streamed(result, 'm1', 't1')).toEqual(['a'])
    expect(streamed(result, 'm2', 't2')).toEqual(['b'])
  })

  it('falls back to a scan when the indexed message was replaced', () => {
    const result = applyEvents(
      [assistant('m1', ['t1']), assistant('m2', [])],
      stored([
        output('t1', 'before'),
        // m1 is restarted without its tool call; the call now lives on m2.
        { type: 'message.start', data: { messageId: 'm1', role: 'assistant', content: '' } },
        {
          type: 'tool.call',
          data: { messageId: 'm2', toolCall: { id: 't1', name: 'run_command', arguments: {}, startedAt: 1 } },
        },
        output('t1', 'after'),
      ]),
      { timestampAsNumber: true },
    )
    expect(streamed(result, 'm2', 't1')).toEqual(['after'])
  })

  it('ignores output for an unknown call', () => {
    const initial = [assistant('m1', ['t1'])]
    const result = applyEvents(initial, stored([output('missing', 'x')]), { timestampAsNumber: true })
    expect(streamed(result, 'm1', 't1')).toEqual([])
  })
})
