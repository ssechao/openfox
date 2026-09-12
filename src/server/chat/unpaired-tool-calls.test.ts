import { describe, it, expect } from 'vitest'
import type { RequestContextMessage } from './request-context.js'
import { INTERRUPTED_TOOL_RESULT, settleUnpairedToolCalls } from './unpaired-tool-calls.js'

const user = (content: string): RequestContextMessage => ({ role: 'user', content, source: 'history' })
const assistant = (toolCalls: Array<{ id: string; name: string }>): RequestContextMessage => ({
  role: 'assistant',
  content: '',
  source: 'history',
  toolCalls: toolCalls.map((c) => ({ ...c, arguments: {} })),
})
const toolResult = (toolCallId: string, content = 'ok'): RequestContextMessage => ({
  role: 'tool',
  content,
  source: 'history',
  toolCallId,
})

describe('settleUnpairedToolCalls', () => {
  it('leaves a fully paired history untouched', () => {
    const messages = [user('go'), assistant([{ id: 'a', name: 'read_file' }]), toolResult('a'), user('next')]
    const result = settleUnpairedToolCalls(messages)
    expect(result.settled).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it('settles a tool call left unanswered before the next user message', () => {
    const messages = [assistant([{ id: 'a', name: 'edit_file' }]), user('continue where you left off')]
    const result = settleUnpairedToolCalls(messages)

    expect(result.settled).toBe(1)
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'a', content: INTERRUPTED_TOOL_RESULT })
    // The synthetic result must sit between the call and the user turn, or the
    // history still ends a tool call with a user message.
    expect(result.messages[2]).toMatchObject({ role: 'user' })
  })

  it('settles only the missing calls of a partially answered batch', () => {
    const messages = [
      assistant([
        { id: 'a', name: 'read_file' },
        { id: 'b', name: 'run_command' },
      ]),
      toolResult('a'),
      user('go on'),
    ]
    const result = settleUnpairedToolCalls(messages)

    expect(result.settled).toBe(1)
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['a', 'b'])
    expect(result.messages[3]).toMatchObject({ role: 'user' })
  })

  it('keeps existing results ahead of the synthetic ones', () => {
    const messages = [
      assistant([
        { id: 'a', name: 'r' },
        { id: 'b', name: 'r' },
      ]),
      toolResult('a', 'real output'),
    ]
    const result = settleUnpairedToolCalls(messages)

    expect(result.messages[1]).toMatchObject({ toolCallId: 'a', content: 'real output' })
    expect(result.messages[2]).toMatchObject({ toolCallId: 'b', content: INTERRUPTED_TOOL_RESULT })
  })

  it('settles an unanswered trailing tool call even with nothing after it', () => {
    const result = settleUnpairedToolCalls([assistant([{ id: 'a', name: 'r' }])])
    expect(result.settled).toBe(1)
    expect(result.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'a' })
  })

  it('handles several interrupted assistant turns independently', () => {
    const messages = [
      assistant([{ id: 'a', name: 'r' }]),
      user('retry'),
      assistant([{ id: 'b', name: 'r' }]),
      toolResult('b'),
    ]
    const result = settleUnpairedToolCalls(messages)

    expect(result.settled).toBe(1)
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant', 'tool'])
  })

  it('is idempotent', () => {
    const once = settleUnpairedToolCalls([assistant([{ id: 'a', name: 'r' }]), user('continue')])
    const twice = settleUnpairedToolCalls(once.messages)
    expect(twice.settled).toBe(0)
    expect(twice.messages).toBe(once.messages)
  })

  it('ignores assistant messages that carry no tool calls', () => {
    const messages = [assistant([]), { role: 'assistant' as const, content: 'plain', source: 'history' as const }]
    expect(settleUnpairedToolCalls(messages).messages).toBe(messages)
  })
})
