import { describe, it, expect } from 'vitest'
import {
  reduceHistoryForWindow,
  MIN_REDUCIBLE_TOOL_RESULT_CHARS,
  PROTECTED_TAIL_MESSAGES,
  TOOL_RESULT_KEEP_CHARS,
  TRUNCATED_TOOL_RESULT_MARKER,
} from './history-reduction.js'
import { estimateMessagesTokens } from './token-budget.js'

function tool(content: string, id = 'call-1') {
  return { role: 'tool' as const, content, source: 'history' as const, toolCallId: id }
}

function user(content: string) {
  return { role: 'user' as const, content, source: 'history' as const }
}

function assistant(content: string) {
  return { role: 'assistant' as const, content, source: 'history' as const }
}

const huge = 'x'.repeat(MIN_REDUCIBLE_TOOL_RESULT_CHARS * 10)

describe('reduceHistoryForWindow', () => {
  it('leaves a history that already fits untouched', () => {
    const messages = [user('hi'), tool(huge), assistant('done'), user('next')]
    const result = reduceHistoryForWindow(messages, estimateMessagesTokens(messages))

    expect(result.changed).toBe(false)
    expect(result.messages).toBe(messages)
  })

  it('truncates the oldest raw tool results first and keeps a readable head', () => {
    const messages = [user('hi'), tool(huge, 'call-1'), tool(huge, 'call-2'), assistant('done'), user('next')]
    const result = reduceHistoryForWindow(messages, 1_000)

    expect(result.changed).toBe(true)
    const reduced = result.messages[1]!
    expect(reduced.content.startsWith('x'.repeat(TOOL_RESULT_KEEP_CHARS))).toBe(true)
    expect(reduced.content).toContain(TRUNCATED_TOOL_RESULT_MARKER)
    expect(reduced.content.length).toBeLessThan(huge.length)
    expect(estimateMessagesTokens(result.messages)).toBeLessThan(estimateMessagesTokens(messages))
  })

  it('never rewrites user or assistant messages', () => {
    const longUser = user('u'.repeat(MIN_REDUCIBLE_TOOL_RESULT_CHARS * 10))
    const longAssistant = assistant('a'.repeat(MIN_REDUCIBLE_TOOL_RESULT_CHARS * 10))
    const messages = [longUser, longAssistant, tool(huge), assistant('done'), user('next')]
    const result = reduceHistoryForWindow(messages, 100)

    expect(result.messages[0]).toBe(longUser)
    expect(result.messages[1]).toBe(longAssistant)
  })

  it('spares the freshest turn while older results still free enough room', () => {
    const fresh = tool(huge, 'call-fresh')
    const prompt = user('summarize this conversation')
    const messages = [tool(huge, 'call-1'), tool(huge, 'call-2'), fresh, prompt]
    // Room for the protected tail plus the two truncated heads: the older
    // results alone close the gap, so the freshest one is never reached.
    const target = estimateMessagesTokens([fresh, prompt]) + 4 * TOOL_RESULT_KEEP_CHARS

    const result = reduceHistoryForWindow(messages, target)

    expect(result.changed).toBe(true)
    expect(result.messages[2]).toBe(fresh)
    expect(result.messages[0]!.content.length).toBeLessThan(huge.length)
  })

  it('truncates the newest tool result when it is the only thing left to free', () => {
    // The canonical overflow: a huge result just landed, then the compaction
    // prompt was appended — the offender sits inside the protected tail, so
    // exempting it would dead-end the very rescue this function exists for.
    const messages = [user('do the thing'), tool(huge, 'call-huge'), user('summarize this conversation')]

    const result = reduceHistoryForWindow(messages, 100)

    expect(result.changed).toBe(true)
    expect(result.messages[1]!.content).toContain(TRUNCATED_TOOL_RESULT_MARKER)
    expect(result.messages[1]!.content.length).toBeLessThan(huge.length)
    // The trailing injected prompt is never rewritten.
    expect(result.messages[2]).toBe(messages[2])
    expect(PROTECTED_TAIL_MESSAGES).toBeGreaterThan(0)
  })

  it('keeps tool results that are already small enough to be worth truncating', () => {
    const small = tool('s'.repeat(MIN_REDUCIBLE_TOOL_RESULT_CHARS - 1))
    const messages = [small, tool(huge), assistant('done'), user('next')]
    const result = reduceHistoryForWindow(messages, 100)

    expect(result.messages[0]).toBe(small)
  })

  it('is idempotent once nothing is left to reduce', () => {
    const messages = [tool(huge, 'call-1'), tool(huge, 'call-2'), assistant('done'), user('next')]
    const first = reduceHistoryForWindow(messages, 10)
    const second = reduceHistoryForWindow(first.messages, 10)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.messages).toBe(first.messages)
  })

  it('preserves message identity fields while rewriting content', () => {
    const messages = [tool(huge, 'call-42'), assistant('done'), user('next')]
    const result = reduceHistoryForWindow(messages, 10)

    expect(result.messages[0]!.role).toBe('tool')
    expect(result.messages[0]!.toolCallId).toBe('call-42')
    expect(result.messages[0]!.source).toBe('history')
  })
})
