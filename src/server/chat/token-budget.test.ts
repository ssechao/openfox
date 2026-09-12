import { describe, it, expect } from 'vitest'
import {
  effectiveContextTokens,
  estimatePromptTokensForSafety,
  estimateMessagesTokens,
  isContextLengthError,
  isNonRetryableLLMError,
  CHARS_PER_TOKEN,
  TOOL_MESSAGE_OVERHEAD_TOKENS,
} from './token-budget.js'

describe('estimateMessagesTokens', () => {
  it('returns 0 for no tool messages', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })

  it('estimates content tokens plus per-message overhead', () => {
    const content = 'a'.repeat(CHARS_PER_TOKEN * 10)
    expect(estimateMessagesTokens([{ content }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 10)
  })

  it('rounds partial token buckets up per message', () => {
    expect(estimateMessagesTokens([{ content: 'abc' }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 1)
    expect(estimateMessagesTokens([{ content: 'abcde' }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 2)
  })

  it('sums estimates across multiple tool messages', () => {
    const a = 'a'.repeat(CHARS_PER_TOKEN * 5)
    const b = 'b'.repeat(CHARS_PER_TOKEN * 7)
    expect(estimateMessagesTokens([{ content: a }, { content: b }])).toBe(2 * TOOL_MESSAGE_OVERHEAD_TOKENS + 12)
  })
})

describe('estimatePromptTokensForSafety', () => {
  it('uses a UTF-8 byte upper bound for high-token-density content', () => {
    const systemPrompt = '系统😀'
    const messages = [{ role: 'user', content: '漢字🙂'.repeat(10) }]
    const tools = [{ type: 'function', name: '工具' }]
    const serialized = systemPrompt + JSON.stringify(messages) + JSON.stringify(tools)

    expect(estimatePromptTokensForSafety(systemPrompt, messages, tools)).toBe(Buffer.byteLength(serialized, 'utf8'))
  })
})

describe('effectiveContextTokens', () => {
  const never = () => {
    throw new Error('estimator must not run when a measurement exists')
  }

  it('adds the unmeasured delta to the last provider measurement', () => {
    expect(effectiveContextTokens({ currentTokens: 100_000, currentTokensKnown: true }, 100_016, never)).toBe(200_016)
  })

  it('treats a missing currentTokensKnown flag as measured', () => {
    expect(effectiveContextTokens({ currentTokens: 4_000 }, 500, never)).toBe(4_500)
  })

  it('returns the measurement untouched when nothing was appended since', () => {
    expect(effectiveContextTokens({ currentTokens: 4_000, currentTokensKnown: true }, 0, never)).toBe(4_000)
  })

  it('falls back to the assembled-request estimate when usage is unknown', () => {
    expect(effectiveContextTokens({ currentTokens: 0, currentTokensKnown: false }, 9_999, () => 44_000)).toBe(44_000)
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

  it('detects the Anthropic input + max_tokens overflow framing', () => {
    expect(
      isContextLengthError(
        'HTTP 400: input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000, decrease input length or `max_tokens` and try again',
      ),
    ).toBe(true)
  })

  it('detects the llama.cpp/ollama context size overflow framing', () => {
    expect(
      isContextLengthError('the request exceeds the available context size, try increasing the context size'),
    ).toBe(true)
  })

  it('detects the input token count overflow framing', () => {
    expect(
      isContextLengthError(
        'HTTP 400: The input token count (210000) exceeds the maximum number of tokens allowed (200000)',
      ),
    ).toBe(true)
  })

  it('does not match generic token errors without context framing', () => {
    expect(isContextLengthError('too many tokens')).toBe(false)
    expect(isContextLengthError('maximum output tokens exceeded')).toBe(false)
  })

  it('requires an overflow qualifier for phrases that also appear in unrelated errors', () => {
    // Matching these bare would force a compaction — an extra LLM call plus a
    // history rewrite — for a failure compaction cannot fix.
    expect(isContextLengthError('HTTP 400: invalid input length for field "prompt"')).toBe(false)
    expect(isContextLengthError('failed to load model: context size 4096 requires more VRAM')).toBe(false)
    expect(isContextLengthError('context size set to 8192')).toBe(false)
  })

  it('returns false for unrelated errors and empty input', () => {
    expect(isContextLengthError('Connection refused')).toBe(false)
    expect(isContextLengthError('HTTP 500: internal server error')).toBe(false)
    expect(isContextLengthError(undefined)).toBe(false)
    expect(isContextLengthError('')).toBe(false)
  })
})

describe('isNonRetryableLLMError', () => {
  it('classifies no_actionable_output as deterministic while preserving transient retries', () => {
    expect(isNonRetryableLLMError('no_actionable_output: The backend returned no answer or tool call.')).toBe(true)
    expect(isNonRetryableLLMError('HTTP 503: backend unavailable')).toBe(false)
    expect(isNonRetryableLLMError('HTTP 429: rate limited')).toBe(false)
  })
})
