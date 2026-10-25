import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeRequestInvariantHashes, computeResponsesRequestInvariantHashes } from './request-invariant.js'
import type { ResponsesRequestBody } from './responses-native.js'
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

  it('logs DIAG-INV digests from raw Responses fields without normalization', () => {
    const body: ResponsesRequestBody = {
      model: 'gpt-6-astra',
      instructions: 'stable instructions',
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
      text: { format: { type: 'text' } },
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'first request' }],
    }
    const sha8 = (value: string | undefined) =>
      createHash('sha256')
        .update(value ?? '')
        .digest('hex')
        .slice(0, 8)

    expect(computeResponsesRequestInvariantHashes(body)).toMatchObject({
      d_instr: sha8(body.instructions),
      d_tools: sha8(JSON.stringify(body.tools)),
      d_text: sha8(JSON.stringify(body['text'])),
      d_model: sha8(body.model),
      d_reasoning: sha8(JSON.stringify(body.reasoning)),
      d_first: sha8(JSON.stringify(body.input[0])),
    })

    const reordered: ResponsesRequestBody = {
      ...body,
      tools: [{ name: 'read_file', type: 'function', parameters: { properties: {}, type: 'object' } }],
    }
    const first = computeResponsesRequestInvariantHashes(body)
    const second = computeResponsesRequestInvariantHashes(reordered)
    expect(second.invariantHash).toBe(first.invariantHash)
    expect(second.d_tools).not.toBe(first.d_tools)
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
