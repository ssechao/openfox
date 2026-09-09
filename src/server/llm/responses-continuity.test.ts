import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLLMClient } from './client.js'

/**
 * Boots an SSE server emulating the OpenAI Responses API that records every
 * request (path, headers, body) so tests can assert the REAL wire request the
 * client produces — not just resolveApiProtocol()/usesResponsesApi().
 *
 * `responses` is a queue of per-request SSE event lists; each incoming request
 * is answered with the next queued list.
 */
async function startResponsesMock(
  responses: unknown[][],
  /** Optionally reject a request outright, e.g. a ZDR org refusing `store:true`. */
  reject?: (body: Record<string, unknown>) => { status: number; json: unknown } | null,
  /** Optionally hold a request open (by index) so a race can be driven deterministically. */
  hold?: (index: number) => Promise<void>,
): Promise<{
  server: Server
  port: number
  requests: Array<{
    path: string
    headers: Record<string, string | string[] | undefined>
    body: Record<string, unknown>
  }>
}> {
  const requests: Array<{
    path: string
    headers: Record<string, string | string[] | undefined>
    body: Record<string, unknown>
  }> = []
  let index = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      requests.push({ path: req.url ?? '', headers: req.headers, body })
      const rejection = reject?.(body)
      if (rejection) {
        res.writeHead(rejection.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rejection.json))
        return
      }
      const current = index
      const events = responses[Math.min(index, responses.length - 1)] ?? []
      index += 1
      if (hold) await hold(current)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port, requests }
}

function completedEvents(id: string, extra: unknown[] = []): unknown[] {
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    ...extra,
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]
}

function failedEvents(id: string): unknown[] {
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.failed', response: { id, status: 'failed', error: { message: 'boom' } } },
  ]
}

const SYSTEM = 'You are a helpful assistant.'
const TOOLS = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: {} } }]

function makeClient(port: number, model: string, backend: string) {
  return createLLMClient({
    llm: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeout: 5000,
      idleTimeout: 5000,
      model,
      apiKey: 'test-key',
      backend,
    },
    context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
  } as never)
}

async function consume(client: ReturnType<typeof createLLMClient>, request: Record<string, unknown>): Promise<unknown> {
  let last: unknown = null
  for await (const event of client.stream(request as never)) {
    last = event
  }
  return last
}

describe('Responses API conversation continuity (real HTTP requests)', () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const s of servers) s.close()
  })

  it('first turn: /v1/responses, store:true, no previous_response_id; second turn: previous_response_id + delta only', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')
    expect(client.usesResponsesApi?.()).toBe(true)

    // Turn 1
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-1',
    })

    // Turn 2
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-1',
    })

    expect(mock.requests).toHaveLength(2)
    const r1 = mock.requests[0]!
    const r2 = mock.requests[1]!

    // Turn 1: /v1/responses, store:true, no previous_response_id, full history.
    expect(r1.path).toBe('/v1/responses')
    expect(r1.body['store']).toBe(true)
    expect(r1.body['previous_response_id']).toBeUndefined()
    expect(r1.body['input']).toEqual([{ role: 'user', content: 'first' }])
    expect(r1.body['instructions']).toBe(SYSTEM)

    // Turn 2: /v1/responses, store:true, previous_response_id:resp_1, delta only.
    expect(r2.path).toBe('/v1/responses')
    expect(r2.body['store']).toBe(true)
    expect(r2.body['previous_response_id']).toBe('resp_1')
    // Delta = the new suffix beyond what the server already stored
    // (user 'first' + assistant 'A1'), i.e. only the new user message.
    expect(r2.body['input']).toEqual([{ role: 'user', content: 'second' }])
    // previous_response_id carries the conversation STATE, not the instructions:
    // the Responses API applies only the instructions sent with each request, so
    // the active system prompt and tools are resent every turn — while `input`
    // stays the delta (asserted above), i.e. no history replay.
    expect(r2.body['instructions']).toBe(SYSTEM)
    expect(r2.body['tools']).toBeDefined()
    expect((r2.body['tools'] as Array<{ name: string }>).map((t) => t.name)).toEqual(['read_file'])
    // previous_response_id is never combined with `conversation`.
    expect(r2.body['conversation']).toBeUndefined()
  })

  it('a failed response does NOT advance the response id (chain reset, next request re-primes)', async () => {
    const mock = await startResponsesMock([
      completedEvents('resp_1'),
      failedEvents('resp_failed'),
      completedEvents('resp_3'),
    ])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-f',
    })
    // Second request: chain valid (resp_1) → previous_response_id:resp_1.
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-f',
    })
    // Third request: the previous response FAILED, so the chain must have been
    // reset → this is a first request again (no previous_response_id).
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'third' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-f',
    })

    expect(mock.requests).toHaveLength(3)
    const r1 = mock.requests[0]!
    const r2 = mock.requests[1]!
    const r3 = mock.requests[2]!
    expect(r1.body['previous_response_id']).toBeUndefined()
    expect(r2.body['previous_response_id']).toBe('resp_1')
    // After the failed response, the chain is invalidated: r3 re-primes.
    expect(r3.body['previous_response_id']).toBeUndefined()
    expect(r3.body['store']).toBe(true)
  })

  it('tool-call cycle: tool output continues the same chain and preserves call_id', async () => {
    const mock = await startResponsesMock([
      completedEvents('resp_1', [
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read_file', arguments: '' },
        },
        { type: 'response.function_call_arguments.delta', delta: '{"path":"a.ts"}' },
      ]),
      completedEvents('resp_2'),
    ])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    // Turn 1 → model returns a tool call.
    const first = (await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'read a.ts' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-t',
    })) as { response: { toolCalls: Array<{ id: string; name: string }> } }
    expect(first.response.toolCalls[0]?.id).toBe('call-1')
    expect(first.response.toolCalls[0]?.name).toBe('read_file')

    // Turn 2: tool result → continues the same chain with the same call_id.
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'read a.ts' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
        },
        { role: 'tool', content: 'file contents', toolCallId: 'call-1' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-t',
    })

    expect(mock.requests).toHaveLength(2)
    const r1 = mock.requests[0]!
    const r2 = mock.requests[1]!
    expect(r1.body['previous_response_id']).toBeUndefined()
    expect(r2.body['previous_response_id']).toBe('resp_1')
    // The tool output is the delta and preserves the exact call_id.
    expect(r2.body['input']).toEqual([{ type: 'function_call_output', call_id: 'call-1', output: 'file contents' }])
  })

  it('changing the system prompt invalidates the chain (next request re-primes)', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-p',
    })
    // Same history but a DIFFERENT system prompt → chain invalidated.
    await consume(client, {
      messages: [
        { role: 'system', content: 'A different system prompt.' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-p',
    })

    expect(mock.requests).toHaveLength(2)
    const r1 = mock.requests[0]!
    const r2 = mock.requests[1]!
    expect(r1.body['previous_response_id']).toBeUndefined()
    expect(r2.body['previous_response_id']).toBeUndefined()
    expect(r2.body['store']).toBe(true)
  })

  it('changing the model invalidates the chain (next request re-primes)', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-m',
    })
    // Same client + session + history but a DIFFERENT model → the fingerprint
    // (which includes the model) no longer matches, so the chain is invalidated
    // and the next request re-primes as a first request.
    client.setModel('gpt-5.5')
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-m',
    })

    expect(mock.requests).toHaveLength(2)
    const r1 = mock.requests[0]!
    const r2 = mock.requests[1]!
    expect(r1.body['previous_response_id']).toBeUndefined()
    expect(r2.body['previous_response_id']).toBeUndefined()
    expect(r2.body['store']).toBe(true)
    expect(r2.body['model']).toBe('gpt-5.5')
  })

  it('A→B→A: returning to the first model does NOT resurrect its old chain', async () => {
    const mock = await startResponsesMock([
      completedEvents('resp_A'),
      completedEvents('resp_B'),
      completedEvents('resp_A2'),
    ])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    // Turn 1 on model A → server stores resp_A.
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-aba',
    })
    // Turn 2 on model B → chain invalidated, re-primes, stores resp_B.
    client.setModel('gpt-5.5')
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-aba',
    })
    // Turn 3 back on model A. The single Map entry now belongs to B, so its
    // fingerprint cannot match A: resp_A must NOT come back.
    client.setModel('gpt-5.6-sol')
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'third' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-aba',
    })

    expect(mock.requests).toHaveLength(3)
    const r3 = mock.requests[2]!
    expect(r3.body['previous_response_id']).not.toBe('resp_A')
    expect(r3.body['previous_response_id']).toBeUndefined()
    expect(r3.body['store']).toBe(true)
    expect(r3.body['model']).toBe('gpt-5.6-sol')
  })

  it('Responses(resp_A) → a real Chat Completions turn → Responses: resp_A is not resurrected', async () => {
    const mock = await startResponsesMock([
      completedEvents('resp_A'),
      // The middle turn is answered on the chat-completions path (empty stream).
      [],
      completedEvents('resp_C'),
    ])
    servers.push(mock.server)
    // Same model throughout: only the effective PROTOCOL changes, so this
    // isolates protocol invalidation from model invalidation.
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')
    expect(client.usesResponsesApi?.()).toBe(true)

    // Turn 1 — Responses, stores resp_A.
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-rcr',
    })

    // Turn 2 — a REAL Chat Completions turn on the same chain key. This path
    // never touches previous_response_id, so without an explicit invalidation
    // the stale Responses entry would survive it untouched.
    client.setBackend('vllm')
    expect(client.usesResponsesApi?.()).toBe(false)
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-rcr',
    })

    // Turn 3 — back to Responses, same model and same system prompt, so the
    // fingerprint is byte-identical to turn 1's. resp_A must still not return:
    // the conversation advanced where the Responses server could not see it.
    client.setBackend('openai')
    expect(client.usesResponsesApi?.()).toBe(true)
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'third' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-rcr',
    })

    expect(mock.requests).toHaveLength(3)
    const [r1, r2, r3] = mock.requests as [
      (typeof mock.requests)[0],
      (typeof mock.requests)[0],
      (typeof mock.requests)[0],
    ]
    expect(r1.path).toBe('/v1/responses')
    expect(r2.path).toBe('/v1/chat/completions')
    expect(r3.path).toBe('/v1/responses')
    // The decisive assertion: no resurrection of resp_A.
    expect(r3.body['previous_response_id']).not.toBe('resp_A')
    expect(r3.body['previous_response_id']).toBeUndefined()
    // It re-primes as a first request carrying the current state.
    expect(r3.body['store']).toBe(true)
    expect(r3.body['instructions']).toBe(SYSTEM)
    expect(r3.body['input']).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'third' },
    ])
  })

  it('does not reuse the chain when earlier history was edited in place', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-edit',
    })

    // The user edited the first message and resent. The count still grows, so a
    // count-only guard would happily continue from resp_1 and the server would
    // keep the pre-edit turn — the edit would be silently ignored.
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first EDITED' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-edit',
    })

    const r2 = mock.requests[1]!
    expect(r2.body['previous_response_id']).toBeUndefined()
    expect(r2.body['store']).toBe(true)
    // Re-primes with the corrected history.
    expect(r2.body['input']).toEqual([
      { role: 'user', content: 'first EDITED' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'second' },
    ])
  })

  it('does not reuse the chain for a same-length edit after the first 32 characters', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')
    const prefix = 'a'.repeat(40)

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${prefix}X` },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-same-length-edit',
    })

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${prefix}Y` },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-same-length-edit',
    })

    expect(mock.requests[1]!.body['previous_response_id']).toBeUndefined()
  })

  it('does not reuse the chain when tool arguments change in place', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'alpha.ts' } }],
        },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-tool-edit',
    })

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'bravo.ts' } }],
        },
        { role: 'tool', content: 'result', toolCallId: 'call-1' },
        { role: 'user', content: 'continue' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-tool-edit',
    })

    expect(mock.requests[1]!.body['previous_response_id']).toBeUndefined()
  })

  it('keeps continuity when only new messages are appended', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    const turn1 = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'first' },
    ]
    await consume(client, { messages: turn1, tools: TOOLS, responsesChainKey: 'session-append' })
    await consume(client, {
      messages: [...turn1, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'second' }],
      tools: TOOLS,
      responsesChainKey: 'session-append',
    })

    // The prefix digest is unchanged, so the chain is still valid.
    expect(mock.requests[1]!.body['previous_response_id']).toBe('resp_1')
    expect(mock.requests[1]!.body['input']).toEqual([{ role: 'user', content: 'second' }])
  })

  it('falls back to full history without store when the provider refuses retention (ZDR)', async () => {
    const mock = await startResponsesMock([completedEvents('resp_2')], (body) =>
      body['store'] === true
        ? { status: 400, json: { error: { message: 'store is not supported with zero data retention' } } }
        : null,
    )
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'first' },
    ]
    // First attempt is rejected; the client must disable chaining rather than
    // keep re-sending store:true and hard-failing every turn.
    await consume(client, { messages, tools: TOOLS, responsesChainKey: 'session-zdr' })
    await consume(client, { messages, tools: TOOLS, responsesChainKey: 'session-zdr' })

    expect(mock.requests).toHaveLength(2)
    expect(mock.requests[0]!.body['store']).toBe(true)
    // The retry no longer asks for server-side retention and sends the history.
    expect(mock.requests[1]!.body['store']).toBe(false)
    expect(mock.requests[1]!.body['previous_response_id']).toBeUndefined()
    expect(mock.requests[1]!.body['input']).toEqual([{ role: 'user', content: 'first' }])
  })

  it('resetResponsesChain (compaction) really drops the chain', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-compact',
    })

    // Compaction rewrites the context, so the stored conversation no longer
    // matches the local history. agent-loop calls this with the RAW key.
    client.resetResponsesChain?.('session-compact')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'compacted summary' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-compact',
    })

    expect(mock.requests).toHaveLength(2)
    const r2 = mock.requests[1]!
    expect(r2.body['previous_response_id']).toBeUndefined()
    expect(r2.body['store']).toBe(true)
  })

  it('Qwen/vLLM keeps calling /v1/chat/completions (no chain fields, full history)', async () => {
    const mock = await startResponsesMock([
      // vLLM speaks chat/completions; the mock just records and returns an empty
      // SSE stream (no terminal event needed for the request-capture assertion).
      [],
    ])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'qwen38-27b', 'vllm')
    expect(client.usesResponsesApi?.()).toBe(false)

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'hi' },
      ],
      responsesChainKey: 'session-v',
    })

    expect(mock.requests).toHaveLength(1)
    const r1 = mock.requests[0]!
    expect(r1.path).toBe('/v1/chat/completions')
    // Chat-completions body shape, not the Responses API.
    expect(r1.body['messages']).toBeDefined()
    expect(r1.body['store']).toBeUndefined()
    expect(r1.body['previous_response_id']).toBeUndefined()
  })

  it('sends no proprietary session/affinity headers (protocol-only headers)', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'hi' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-h',
    })
    const headers = mock.requests[0]!.headers
    const keys = Object.keys(headers)
    expect(keys).not.toContain('x-session-id')
    expect(keys).not.toContain('x-session-affinity')
    expect(keys).not.toContain('x-weytop-conversation-id')
    // Only the standard protocol headers are present.
    expect(keys).toContain('content-type')
    expect(keys).toContain('authorization')
  })

  it('re-primes when the reasoning effort changes mid-conversation', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1'), completedEvents('resp_2')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      reasoningEffort: 'low',
      responsesChainKey: 'session-effort',
    })
    // Same model, prompt and tools, but a different reasoning effort: the stored
    // response was produced under other request settings, so continuing from it
    // would silently carry the old effort into the new turn.
    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      reasoningEffort: 'high',
      responsesChainKey: 'session-effort',
    })

    expect(mock.requests).toHaveLength(2)
    expect(mock.requests[1]!.body['previous_response_id']).toBeUndefined()
    expect(mock.requests[1]!.body['store']).toBe(true)
  })

  it('does not let a late response revive a chain reset while it was in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const mock = await startResponsesMock(
      [completedEvents('resp_1'), completedEvents('resp_2')],
      undefined,
      async (i) => {
        if (i === 0) await gate
      },
    )
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    const inFlight = consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-race',
    })
    // Compaction (or any explicit invalidation) lands while the turn is running.
    await new Promise((resolve) => setTimeout(resolve, 20))
    client.resetResponsesChain?.('session-race')
    release!()
    await inFlight

    await consume(client, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'second' },
      ],
      tools: TOOLS,
      responsesChainKey: 'session-race',
    })

    expect(mock.requests).toHaveLength(2)
    // resp_1 was invalidated before it landed — it must not be continued from.
    expect(mock.requests[1]!.body['previous_response_id']).toBeUndefined()
  })

  it('bounds the number of retained chains', async () => {
    const mock = await startResponsesMock([completedEvents('resp_1')])
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'openai')

    const turn = (key: string, extra: Array<Record<string, unknown>> = []) =>
      consume(client, {
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'first' }, ...extra],
        tools: TOOLS,
        responsesChainKey: key,
      })

    await turn('session-evicted')
    for (let i = 0; i < 300; i += 1) await turn(`session-filler-${i}`)

    const before = mock.requests.length
    // Same prompt/tools and a grown history, so this chain WOULD be continued —
    // unless the cap evicted it. Proves the map cannot grow without bound.
    await turn('session-evicted', [
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'second' },
    ])
    expect(mock.requests[before]!.body['previous_response_id']).toBeUndefined()
  })
})
