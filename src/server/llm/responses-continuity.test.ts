import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLLMClient } from './client.js'
import type { LLMCompletionRequest, LLMMessage, LLMToolDefinition } from './types.js'

const tools: LLMToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
]
const system: LLMMessage = { role: 'system', content: 'Keep the instructions and tools.' }
const user = (content: string): LLMMessage => ({ role: 'user', content })
const assistant = (content: string): LLMMessage => ({ role: 'assistant', content })
const history = [system, user('first')]
const nextHistory = [...history, assistant('answer-1'), user('second')]
const image = { id: 'image', filename: 'image.png', mimeType: 'image/png', size: 3, data: 'data:image/png;base64,QUJD' }

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function boot(
  overrides: Record<string, unknown> = {},
  outputs?: Array<Record<string, unknown>[]>,
  statuses: string[] = [],
  rejectRetention = false,
) {
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: string[] }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ path: req.url!, body, headers: Object.keys(req.headers) })
      if (rejectRetention && body['store'] === true) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'store is not supported with zero data retention' } }))
        return
      }
      const n = requests.length
      const output = outputs?.[n - 1] ?? [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer-${n}` }] },
      ]
      const response = {
        id: `resp_${n}`,
        status: statuses[n - 1] ?? 'completed',
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
      if (body['stream']) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const events: Record<string, unknown>[] = req.url?.endsWith('/chat/completions')
          ? [{ id: `chat_${n}`, choices: [{ delta: { content: `answer-${n}` }, finish_reason: 'stop' }] }]
          : [
              { type: 'response.created', response: { id: response.id, status: 'in_progress' } },
              ...output.flatMap<Record<string, unknown>>((item, output_index) =>
                item['type'] === 'function_call'
                  ? [
                      { type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } },
                      { type: 'response.function_call_arguments.delta', output_index, delta: item['arguments'] },
                    ]
                  : item['type'] === 'message'
                    ? [
                        {
                          type: 'response.output_text.delta',
                          delta: (item['content'] as Array<{ text: string }>).map((c) => c.text).join(''),
                        },
                      ]
                    : [],
              ),
              { type: `response.${response.status}`, response },
            ]
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(
            req.url?.endsWith('/chat/completions')
              ? {
                  id: `chat_${n}`,
                  choices: [{ message: { content: `answer-${n}` }, finish_reason: 'stop' }],
                }
              : response,
          ),
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const client = createLLMClient({
    llm: {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      model: 'gpt-5.6-sol',
      backend: 'openai',
      apiKey: 'fixture-key',
      timeout: 5000,
      idleTimeout: 5000,
      ...overrides,
    },
    context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
  } as never)
  const request = async (messages = history, key: string | undefined = 'session', stream = true) => {
    const params = {
      messages,
      tools,
      ...(key ? { responsesChainKey: key } : {}),
      modelSettings: { supportsVision: true },
    } as LLMCompletionRequest
    if (!stream) return client.complete(params)
    let last
    for await (const event of client.stream(params)) last = event
    expect(last?.type).toBe('done')
    return last?.type === 'done' ? last.response : undefined
  }
  return { client, requests, request }
}

describe('fork Responses continuity on the wire', () => {
  it.each([true, false])('keeps instructions/tools with delta-only input (stream=%s)', async (stream) => {
    const { request, requests } = await boot()
    await request(history, 'session', stream)
    await request(nextHistory, 'session', stream)
    expect(requests[0]!.body['store']).toBe(true)
    expect(requests[1]!.body['previous_response_id']).toBe('resp_1')
    expect(requests[1]!.body['input']).toEqual([{ role: 'user', content: 'second' }])
    expect(requests[1]!.body['instructions']).toBe(system.content)
    expect(requests[1]!.body['tools']).toEqual(requests[0]!.body['tools'])
    expect(Object.keys(requests[1]!.body).sort()).toEqual(
      [
        'input',
        'instructions',
        'max_output_tokens',
        'model',
        'previous_response_id',
        'store',
        'stream',
        'tools',
      ].sort(),
    )
    expect(requests[1]!.headers.some((name) => /session|affinity|conversation/.test(name))).toBe(false)
  })

  it.each([
    { model: 'custom-alias', backend: 'unknown', apiProtocol: 'responses', endpoint: '/v1/responses' },
    { model: 'gpt-5.6-sol', backend: 'openai', apiProtocol: 'chat-completions', endpoint: '/v1/chat/completions' },
    { model: 'gpt-5.6-sol', backend: 'openai', apiProtocol: 'auto', endpoint: '/v1/responses' },
    { model: 'qwen3-32b', backend: 'vllm', endpoint: '/v1/chat/completions' },
  ])('routes $model via $endpoint with provider override $apiProtocol', async ({ endpoint, ...overrides }) => {
    const { request, requests } = await boot(overrides)
    await request()
    await request(nextHistory)
    expect(requests.map((r) => r.path)).toEqual([endpoint, endpoint])
    if (endpoint.endsWith('/chat/completions')) {
      expect(requests[1]!.body['messages']).toEqual(nextHistory)
      expect(requests[1]!.body['previous_response_id']).toBeUndefined()
      expect(requests[1]!.body['store']).toBeUndefined()
    }
  })

  it('does not resurrect the original chain on model A -> B -> A, even without a B request', async () => {
    const { client, request, requests } = await boot()
    await request()
    client.setModel('gpt-5.5')
    client.setModel('gpt-5.6-sol')
    await request(nextHistory)
    expect(requests[1]!.body['store']).toBe(true)
    expect(requests[1]!.body['previous_response_id']).toBeUndefined()
    expect(requests[1]!.body['input']).toHaveLength(3)
  })

  it('does not resurrect a Responses chain after a real Chat Completions turn', async () => {
    const { client, request, requests } = await boot()
    await request()
    client.setBackend('vllm')
    await request(nextHistory)
    client.setBackend('openai')
    await request([...nextHistory, assistant('answer-2'), user('third')])
    expect(requests.map((r) => r.path)).toEqual(['/v1/responses', '/v1/chat/completions', '/v1/responses'])
    expect(requests[2]!.body['previous_response_id']).toBeUndefined()
    expect(requests[2]!.body['input']).toHaveLength(5)
  })

  it('resets the same history explicitly after compaction and keeps sessions independent', async () => {
    const { client, request, requests } = await boot()
    await request(history, 'A')
    await request(history, 'B')
    client.resetResponsesChain?.('A')
    await request(nextHistory, 'A')
    await request([...history, assistant('answer-2'), user('B delta')], 'B')
    expect(requests[2]!.body['previous_response_id']).toBeUndefined()
    expect(requests[3]!.body['previous_response_id']).toBe('resp_2')
  })

  it('keeps tool identities through a parallel call/result cycle', async () => {
    const calls = [
      { type: 'function_call', id: 'fc_a', call_id: 'a', name: 'read_file', arguments: '{ "path": "a.ts" }' },
      { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'glob', arguments: '{"pattern":"*.ts"}' },
    ]
    const { request, requests } = await boot({}, [calls])
    const first = await request()
    await request([
      ...history,
      { role: 'assistant', content: '', toolCalls: first!.toolCalls! },
      { role: 'tool', toolCallId: 'a', content: 'file A' },
      { role: 'tool', toolCallId: 'b', content: 'a.ts, b.ts' },
    ])
    expect(requests[1]!.body['previous_response_id']).toBe('resp_1')
    expect(requests[1]!.body['input']).toEqual([
      { type: 'function_call_output', call_id: 'a', output: 'file A' },
      { type: 'function_call_output', call_id: 'b', output: 'a.ts, b.ts' },
    ])
  })

  it.each([true, false])(
    'converts images in the initial and delta input without changing bytes (stream=%s)',
    async (stream) => {
      const { request, requests } = await boot()
      const first = [system, { ...user('first'), attachments: [image] }]
      await request(first, 'images', stream)
      await request([...first, assistant('answer-1'), { ...user('second'), attachments: [image] }], 'images', stream)
      const converted = (text: string) => [
        { type: 'input_text', text },
        { type: 'input_image', image_url: image.data },
      ]
      expect(requests[0]!.body['input']).toEqual([{ role: 'user', content: converted('first') }])
      expect(requests[1]!.body['previous_response_id']).toBe('resp_1')
      expect(requests[1]!.body['input']).toEqual([{ role: 'user', content: converted('second') }])
    },
  )

  it('resets when instructions, tools, or already-sent input change', async () => {
    for (const change of ['instructions', 'tools', 'history', 'output']) {
      const { client, request, requests } = await boot()
      await request()
      const messages = structuredClone(nextHistory)
      if (change === 'instructions') messages[0]!.content += 'new'
      if (change === 'history') messages[1]!.content += 'edited'
      if (change === 'output') messages[2]!.content += 'edited'
      await client.complete({ messages, tools: change === 'tools' ? [] : tools, responsesChainKey: 'session' } as never)
      expect(requests[1]!.body['previous_response_id']).toBeUndefined()
      expect(requests[1]!.body['input']).toHaveLength(3)
    }
  })

  it('never continues from failed or incomplete responses, and stays stateless without a key', async () => {
    for (const status of ['failed', 'cancelled', 'incomplete']) {
      const { client, request, requests } = await boot({}, undefined, [status])
      for await (const _event of client.stream({ messages: history, responsesChainKey: 'session' } as never)) {
        /* drain */
      }
      await request(nextHistory)
      expect(requests[1]!.body['previous_response_id']).toBeUndefined()
    }
    const { request, requests } = await boot()
    await request(history, '')
    expect(requests[0]!.body['store']).toBe(false)
  })

  it.each(['reset', 'abort'])('does not advance a request invalidated in flight by %s', async (action) => {
    const { client, request, requests } = await boot()
    const controller = new AbortController()
    for await (const event of client.stream({
      messages: history,
      tools,
      responsesChainKey: 'session',
      signal: controller.signal,
    })) {
      if (event.type === 'text_delta') {
        if (action === 'reset') client.resetResponsesChain?.('session')
        else controller.abort()
      }
    }
    await request(nextHistory)
    expect(requests[1]!.body['previous_response_id']).toBeUndefined()
    expect(requests[1]!.body['input']).toHaveLength(3)
  })

  it('falls back to stateless full history on the next attempt after retention is refused', async () => {
    const { client, request, requests } = await boot({}, undefined, [], true)
    let last
    for await (const event of client.stream({ messages: history, tools, responsesChainKey: 'session' })) last = event
    expect(last?.type).toBe('error')
    await request()
    expect(requests[0]!.body['store']).toBe(true)
    expect(requests[1]!.body['store']).toBe(false)
    expect(requests[1]!.body['previous_response_id']).toBeUndefined()
    expect(requests[1]!.body['input']).toEqual([{ role: 'user', content: 'first' }])
  })
})
