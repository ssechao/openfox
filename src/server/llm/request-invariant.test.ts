import { describe, expect, it } from 'vitest'
import { computeRequestInvariantHashes } from './request-invariant.js'
import type { ChatCompletionCreateParamsBase, ChatCompletionMessageParam, ChatCompletionTool } from './openai-types.js'

describe('LLM request invariant hashes', () => {
  const systemMessage: ChatCompletionMessageParam = { role: 'system', content: 'stable instructions' }
  const firstUserMessage: ChatCompletionMessageParam = { role: 'user', content: 'first request' }
  const firstAnswerMessage: ChatCompletionMessageParam = { role: 'assistant', content: 'first answer' }
  const baseTool: ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  }
  const base: ChatCompletionCreateParamsBase = {
    model: 'gpt-6-astra',
    messages: [systemMessage, firstUserMessage, firstAnswerMessage],
    tools: [baseTool],
    reasoning_effort: 'high',
  }

  it('stays stable when only later conversation items are appended', () => {
    const first = computeRequestInvariantHashes(base, 'responses')
    const second = computeRequestInvariantHashes(
      {
        ...base,
        messages: [...base.messages, { role: 'user' as const, content: 'second request' }],
      },
      'responses',
    )

    expect(second).toEqual(first)
  })

  it('separates invariant drift from first-item drift', () => {
    const reference = computeRequestInvariantHashes(base, 'responses')
    const modelChanged = computeRequestInvariantHashes({ ...base, model: 'gpt-5.6-sol' }, 'responses')
    const reasoningChanged = computeRequestInvariantHashes({ ...base, reasoning_effort: 'medium' }, 'responses')
    const toolChanged = computeRequestInvariantHashes(
      {
        ...base,
        tools: [
          {
            ...baseTool,
            function: { ...baseTool.function, description: 'Read one file' },
          },
        ],
      },
      'responses',
    )
    const firstItemChanged = computeRequestInvariantHashes(
      {
        ...base,
        messages: [systemMessage, { role: 'user', content: 'different first request' }, firstAnswerMessage],
      },
      'responses',
    )

    expect(modelChanged.invariantHash).not.toBe(reference.invariantHash)
    expect(reasoningChanged.invariantHash).not.toBe(reference.invariantHash)
    expect(toolChanged.invariantHash).not.toBe(reference.invariantHash)
    expect(firstItemChanged.invariantHash).toBe(reference.invariantHash)
    expect(firstItemChanged.firstItemHash).not.toBe(reference.firstItemHash)
  })
})
