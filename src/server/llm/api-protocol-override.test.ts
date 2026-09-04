import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLLMClient } from './client.js'

/**
 * Proves the persistent `apiProtocol` provider override (auto | responses |
 * chat-completions) is actually transmitted to resolveApiProtocol and selects
 * the real HTTP endpoint — not just the model name. A claude model (no
 * responses profile) forced to `responses` must hit /v1/responses; a gpt-5
 * model forced to `chat-completions` must hit /v1/chat/completions.
 */
async function startMock(): Promise<{
  server: Server
  port: number
  requests: Array<{ path: string; body: Record<string, unknown> }>
}> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') as Record<string, unknown> })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // chat-completions empty stream / responses terminal event
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as AddressInfo).port, requests }
}

function makeClient(
  port: number,
  model: string,
  apiProtocol?: 'auto' | 'responses' | 'chat-completions',
  backend = 'openai',
) {
  return createLLMClient({
    llm: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeout: 5000,
      idleTimeout: 5000,
      model,
      apiKey: 'test-key',
      backend,
      ...(apiProtocol ? { apiProtocol } : {}),
    },
    context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
  } as never)
}

describe('apiProtocol override wiring (real HTTP endpoint selection)', () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const s of servers) s.close()
  })

  it('forces a claude model (no responses profile) to /v1/responses', async () => {
    const mock = await startMock()
    servers.push(mock.server)
    const client = makeClient(mock.port, 'claude-opus-5', 'responses')
    expect(client.usesResponsesApi?.()).toBe(true)
    for await (const _ of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }
    expect(mock.requests[0]!.path).toBe('/v1/responses')
  })

  it('forces a gpt-5 model (responses profile) to /v1/chat/completions', async () => {
    const mock = await startMock()
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'chat-completions')
    expect(client.usesResponsesApi?.()).toBe(false)
    for await (const _ of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }
    expect(mock.requests[0]!.path).toBe('/v1/chat/completions')
    // chat-completions body shape (messages array), not the Responses input[].
    expect(mock.requests[0]!.body['messages']).toBeDefined()
    expect(mock.requests[0]!.body['input']).toBeUndefined()
  })

  it('auto derives from the model profile (gpt-5 → responses)', async () => {
    const mock = await startMock()
    servers.push(mock.server)
    const client = makeClient(mock.port, 'gpt-5.6-sol', 'auto')
    expect(client.usesResponsesApi?.()).toBe(true)
    for await (const _ of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }
    expect(mock.requests[0]!.path).toBe('/v1/responses')
  })

  // The two .122 providers point at the same wrapper URL but declare different
  // backends ("Claude Weytop (.122)" = unknown, "Codex GPT-5.6-sol" = openai).
  // The provider-level apiProtocol override must route every model of both to
  // /v1/responses, independently of the backend and of the model NAME — the
  // claude-* ids have no responses profile and match no curated rule.
  const WRAPPER_122_MODELS = [
    'gpt-5.6-sol',
    'gpt-5.5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-fable-5',
  ]

  for (const backend of ['unknown', 'openai']) {
    for (const model of WRAPPER_122_MODELS) {
      it(`.122 provider (backend=${backend}) routes ${model} to /v1/responses`, async () => {
        const mock = await startMock()
        servers.push(mock.server)
        const client = makeClient(mock.port, model, 'responses', backend)
        expect(client.usesResponsesApi?.()).toBe(true)
        for await (const _ of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // drain
        }
        expect(mock.requests[0]!.path).toBe('/v1/responses')
        // Responses body shape, not chat-completions.
        expect(mock.requests[0]!.body['input']).toBeDefined()
        expect(mock.requests[0]!.body['messages']).toBeUndefined()
      })
    }
  }

  it('the Qwen/vLLM provider (no apiProtocol) stays on /v1/chat/completions', async () => {
    const mock = await startMock()
    servers.push(mock.server)
    // A separate vLLM provider with no provider-level override.
    const client = makeClient(mock.port, 'qwen38-27b', undefined, 'vllm')
    expect(client.usesResponsesApi?.()).toBe(false)
    for await (const _ of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }
    expect(mock.requests[0]!.path).toBe('/v1/chat/completions')
    expect(mock.requests[0]!.body['messages']).toBeDefined()
    expect(mock.requests[0]!.body['input']).toBeUndefined()
  })
})
