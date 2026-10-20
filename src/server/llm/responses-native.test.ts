import { describe, expect, it } from 'vitest'
import {
  buildResponsesRequest,
  parseResponsesEvent,
  parseResponsesResponse,
  type ResponsesRequestBody,
} from './responses-native.js'
import { LLMError } from '../utils/errors.js'
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from './openai-types.js'

function streamParams(
  overrides: Partial<ChatCompletionCreateParamsStreaming> = {},
): ChatCompletionCreateParamsStreaming {
  return {
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    ...overrides,
  }
}

describe('buildResponsesRequest', () => {
  it('maps instructions, input and sampling params', () => {
    const params = streamParams({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.7,
      max_tokens: 2048,
      top_p: 0.9,
    })
    const body = buildResponsesRequest(params)
    expect(body.model).toBe('gpt-5.6-luna')
    expect(body.instructions).toBe('You are helpful.')
    expect(body.input).toEqual([{ role: 'user', content: 'hello' }])
    expect(body.max_output_tokens).toBe(2048)
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
  })

  it('maps max_completion_tokens to max_output_tokens (openai backend sends the modern param)', () => {
    const body = buildResponsesRequest(
      streamParams({ max_completion_tokens: 4096 } as unknown as ChatCompletionCreateParamsStreaming),
    )
    expect(body.max_output_tokens).toBe(4096)
  })

  it('never forwards sampling params (GPT-5.x models reject temperature and top_p)', () => {
    const body = buildResponsesRequest(streamParams({ temperature: 0.7, top_p: 0.9 }))
    expect(body['temperature']).toBeUndefined()
    expect(body['top_p']).toBeUndefined()
    expect(Object.keys(body)).not.toContain('temperature')
    expect(Object.keys(body)).not.toContain('top_p')
  })

  it('converts tool definitions to the flat Responses format', () => {
    const params = streamParams({
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
        },
      ],
    })
    const body = buildResponsesRequest(params)
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
    ])
  })

  it('converts assistant tool_calls history to function_call input items', () => {
    const params = streamParams({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          ],
        },
        { role: 'tool', content: 'file contents', tool_call_id: 'call-1' },
      ],
    })
    const body = buildResponsesRequest(params)
    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
    ])
  })

  it('maps reasoning_effort to the reasoning field', () => {
    expect(buildResponsesRequest(streamParams({ reasoning_effort: 'high' }))['reasoning']).toEqual({ effort: 'high' })
    expect(buildResponsesRequest(streamParams({ reasoning_effort: 'none' }))['reasoning']).toBeUndefined()
  })

  it('does not emit chat-only fields', () => {
    const body: ResponsesRequestBody = buildResponsesRequest(
      streamParams({ stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: true } }),
    )
    const keys = Object.keys(body)
    expect(keys).not.toContain('messages')
    expect(keys).not.toContain('max_tokens')
    expect(keys).not.toContain('stream_options')
    expect(keys).not.toContain('chat_template_kwargs')
    expect(keys).not.toContain('reasoning_effort')
  })

  it('converts chat image parts to Responses input_image in message content', () => {
    const body = buildResponsesRequest(
      streamParams({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look at this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      }),
    )
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
    ])
    expect(JSON.stringify(body.input)).not.toContain('"image_url":{')
  })

  it('accepts an image_url string and preserves an explicit detail', () => {
    const body = buildResponsesRequest(
      streamParams({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: 'data:image/jpeg;base64,BBBB', detail: 'high' },
            ] as unknown as ChatCompletionMessageParam['content'],
          },
        ],
      }),
    )
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB', detail: 'high' }],
      },
    ])
  })

  it('reads a detail nested inside image_url', () => {
    const body = buildResponsesRequest(
      streamParams({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,DDDD', detail: 'low' } },
            ] as unknown as ChatCompletionMessageParam['content'],
          },
        ],
      }),
    )
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,DDDD', detail: 'low' }],
      },
    ])
  })

  it('maps assistant array content to output_text', () => {
    const body = buildResponsesRequest(
      streamParams({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }] }),
    )
    expect(body.input).toEqual([{ role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }])
  })

  it('passes unknown content part types through unchanged', () => {
    const body = buildResponsesRequest(
      streamParams({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
            ] as unknown as ChatCompletionMessageParam['content'],
          },
        ],
      }),
    )
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] },
    ])
  })

  it('leaves function_call_output content untouched (chat image parts preserved)', () => {
    const body = buildResponsesRequest(
      streamParams({
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call-1',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }],
          } as unknown as ChatCompletionMessageParam,
        ],
      }),
    )
    expect(body.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }],
      },
    ])
  })
})

describe('parseResponsesResponse', () => {
  it('maps output items to message content and tool calls', () => {
    const response = parseResponsesResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer' }] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call-1',
          name: 'glob',
          arguments: '{"pattern":"*.ts"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })
    expect(response).toEqual({
      id: 'resp_1',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'Final answer',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.ts"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  })

  it('extracts reasoning summary text as reasoning_content', () => {
    const response = parseResponsesResponse({
      id: 'resp_2',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Thinking about it' }],
        },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Answer' }],
        },
      ],
    })
    expect(response.choices[0]?.message['reasoning_content']).toBe('Thinking about it')
    expect(response.choices[0]?.finish_reason).toBe('stop')
  })

  it('maps incomplete status to the length finish reason', () => {
    const response = parseResponsesResponse({
      id: 'resp_3',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    })
    expect(response.choices[0]?.finish_reason).toBe('length')
  })

  it('maps failed status to the content_filter finish reason', () => {
    const response = parseResponsesResponse({ id: 'resp_4', status: 'failed', output: [] })
    expect(response.choices[0]?.finish_reason).toBe('content_filter')
  })
})

describe('parseResponsesEvent terminal errors', () => {
  it('raises response.failed as an LLM error carrying the provider message', () => {
    expect(() =>
      parseResponsesEvent({
        type: 'response.failed',
        response: { id: 'resp_5', status: 'failed', output: [], error: { message: 'Codex Responses backend failed.' } },
      }),
    ).toThrow(new LLMError('Codex Responses backend failed.'))
  })

  it('raises response.failed without a provider message as a generic LLM error', () => {
    expect(() => parseResponsesEvent({ type: 'response.failed', response: { status: 'failed' } })).toThrow(
      new LLMError('Responses API request failed'),
    )
  })

  it('raises a stream error event as an LLM error', () => {
    expect(() => parseResponsesEvent({ type: 'error', message: 'quota exhausted' })).toThrow(
      new LLMError('quota exhausted'),
    )
  })

  it('still maps response.completed to a final chunk', () => {
    const chunk = parseResponsesEvent({ type: 'response.completed', response: { status: 'completed' } })
    expect(chunk).not.toBeNull()
    expect(typeof chunk === 'object' && chunk?.choices[0]?.finish_reason).toBe('stop')
  })
})
