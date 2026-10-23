import { describe, it, expect } from 'vitest'
import {
  estimateConversationTokens,
  estimateToolResultTokens,
  isContextLengthError,
  isInputOverflowError,
  CHARS_PER_TOKEN,
  TOOL_MESSAGE_OVERHEAD_TOKENS,
} from './token-budget.js'

describe('estimateConversationTokens', () => {
  it('counts content plus per-message overhead', () => {
    const content = 'a'.repeat(CHARS_PER_TOKEN * 10)
    expect(estimateConversationTokens([{ content }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 10)
  })

  it('counts thinking and tool-call payloads, not just content', () => {
    const args = { path: 'x'.repeat(CHARS_PER_TOKEN * 50) }
    const withToolCall = estimateConversationTokens([
      {
        content: '',
        thinkingContent: 't'.repeat(CHARS_PER_TOKEN * 30),
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: args }],
      },
      { content: 'r'.repeat(CHARS_PER_TOKEN * 20), toolCallId: 'call-1' },
    ])
    const contentOnly = estimateToolResultTokens([{ content: '' }, { content: 'r'.repeat(CHARS_PER_TOKEN * 20) }])
    expect(withToolCall).toBeGreaterThan(contentOnly + 30 + 50)
  })
})

describe('isInputOverflowError', () => {
  it('detects the wrapper cold_replay_context_exceeded refusal', () => {
    expect(
      isInputOverflowError(
        'HTTP 409: {"error":{"message":"The client transcript exceeds this model context window (input_tokens=291082, max_context_tokens=262144).","code":"cold_replay_context_exceeded"}}',
      ),
    ).toBe(true)
  })

  it('detects prompt-too-long framing', () => {
    expect(isInputOverflowError('Prompt is too long (12345 tokens > 8192 tokens)')).toBe(true)
  })

  it('leaves output-budget context-length errors to the maxTokens retry path', () => {
    expect(
      isInputOverflowError(
        "HTTP 400: This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).",
      ),
    ).toBe(false)
    expect(isInputOverflowError(undefined)).toBe(false)
  })
})

describe('estimateToolResultTokens', () => {
  it('returns 0 for no tool messages', () => {
    expect(estimateToolResultTokens([])).toBe(0)
  })

  it('estimates content tokens plus per-message overhead', () => {
    const content = 'a'.repeat(CHARS_PER_TOKEN * 10)
    expect(estimateToolResultTokens([{ content }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 10)
  })

  it('rounds partial token buckets up per message', () => {
    expect(estimateToolResultTokens([{ content: 'abc' }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 1)
    expect(estimateToolResultTokens([{ content: 'abcde' }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 2)
  })

  it('sums estimates across multiple tool messages', () => {
    const a = 'a'.repeat(CHARS_PER_TOKEN * 5)
    const b = 'b'.repeat(CHARS_PER_TOKEN * 7)
    expect(estimateToolResultTokens([{ content: a }, { content: b }])).toBe(2 * TOOL_MESSAGE_OVERHEAD_TOKENS + 12)
  })
})

describe('isContextLengthError', () => {
  it('detects OpenAI-style maximum context length errors', () => {
    expect(
      isContextLengthError(
        "HTTP 400: This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).",
      ),
    ).toBe(true)
  })

  it('detects context window and context_length markers', () => {
    expect(isContextLengthError('context window exceeded')).toBe(true)
    expect(isContextLengthError('context_length is too long')).toBe(true)
  })

  it('detects prompt-too-long framing', () => {
    expect(isContextLengthError('Prompt is too long (12345 tokens > 8192 tokens)')).toBe(true)
  })

  it('does not match generic token errors without context framing', () => {
    expect(isContextLengthError('too many tokens')).toBe(false)
    expect(isContextLengthError('maximum output tokens exceeded')).toBe(false)
  })

  it('returns false for unrelated errors and empty input', () => {
    expect(isContextLengthError('Connection refused')).toBe(false)
    expect(isContextLengthError('HTTP 500: internal server error')).toBe(false)
    expect(isContextLengthError(undefined)).toBe(false)
    expect(isContextLengthError('')).toBe(false)
  })
})
