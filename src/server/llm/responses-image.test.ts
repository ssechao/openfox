import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLLMClient } from './client.js'
import { buildResponsesRequest } from './responses-native.js'
import type { ChatCompletionCreateParamsStreaming } from './openai-types.js'

/**
 * The Responses API rejects the Chat-Completions `image_url` content part with:
 *   HTTP 400 invalid_request_error  "Unsupported message content type: image_url"
 * It requires `input_image` with a plain-string `image_url`. This suite proves
 * the Responses adapter converts content parts (text→input_text,
 * image_url→input_image) on every path (first call, previous_response_id delta,
 * streaming, non-streaming) and that the Chat-Completions path is untouched.
 */

const IMG = 'data:image/png;base64,QUJD' // tiny placeholder, never logged

/** Boot a mock /v1/responses server that REJECTS any request whose input still
 *  carries a Chat-Completions `image_url` content part (reproducing the real
 *  HTTP 400), and accepts `input_image`. Records every request body. */
async function startResponsesImageMock(): Promise<{
  server: Server
  port: number
  requests: Array<{ path: string; body: Record<string, unknown> }>
  responses: Array<{ status: number; body: string }>
}> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const responses: Array<{ status: number; body: string }> = []

  const hasImageUrlPart = (body: Record<string, unknown>): boolean => {
    const input = body['input']
    if (!Array.isArray(input)) return false
    for (const item of input) {
      const content = (item as { content?: unknown })?.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if ((part as { type?: string })?.type === 'image_url') return true
      }
    }
    return false
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      requests.push({ path: req.url ?? '', body })
      if (hasImageUrlPart(body)) {
        // Reproduce the real provider error exactly.
        responses.push({ status: 400, body: '' })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unsupported message content type: image_url' } }))
        return
      }
      responses.push({ status: 200, body: '' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response_id: 'resp_img',
          response: {
            id: 'resp_img',
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n\n`,
      )
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as AddressInfo).port, requests, responses }
}

function makeResponsesClient(port: number) {
  return createLLMClient({
    llm: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeout: 5000,
      idleTimeout: 5000,
      model: 'gpt-5.6-sol',
      apiKey: 'test-key',
      backend: 'openai',
    },
    context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
  } as never)
}

const imageAttachment = {
  id: 'att-1',
  filename: 'shot.png',
  mimeType: 'image/png',
  size: 3,
  data: IMG,
}

describe('Responses API image content-part conversion (reproduces the HTTP 400)', () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const s of servers) s.close()
  })

  it('a user message with an image no longer triggers the 400 (input_image is sent, not image_url)', async () => {
    const mock = await startResponsesImageMock()
    servers.push(mock.server)
    const client = makeResponsesClient(mock.port)
    expect(client.usesResponsesApi?.()).toBe(true)

    const events: Array<Record<string, unknown>> = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'what is in this image?', attachments: [imageAttachment] }],
    })) {
      events.push(event as Record<string, unknown>)
    }

    // The request must have been accepted (200), not rejected with the 400.
    expect(mock.responses[0]!.status).toBe(200)
    expect(mock.requests).toHaveLength(1)
    const input = mock.requests[0]!.body['input'] as Array<Record<string, unknown>>
    // No Chat-Completions image_url part survives in the wire payload.
    const serialized = JSON.stringify(mock.requests[0]!.body)
    expect(serialized).not.toContain('"type":"image_url"')
    // The image is present as an input_image with the data URL preserved.
    expect(serialized).toContain('"type":"input_image"')
    expect(serialized).toContain(IMG)
    // The text block is converted to input_text and ordering (text, then image) is kept.
    expect(input).toHaveLength(1)
    const content = (input[0] as { content: Array<Record<string, unknown>> }).content
    expect(content).toEqual([
      { type: 'input_text', text: 'what is in this image?' },
      { type: 'input_image', image_url: IMG },
    ])
    // The stream completed successfully (a done event, not an error).
    expect(events.some((e) => e['type'] === 'done')).toBe(true)
    expect(events.some((e) => e['type'] === 'error')).toBe(false)
  })

  it('a continuation (previous_response_id) converts an image in deltaMessages too', () => {
    const params = {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'ignored on continuation' }],
      stream: true,
    } as unknown as ChatCompletionCreateParamsStreaming
    const body = buildResponsesRequest(params, {
      store: true,
      previousResponseId: 'resp_prev',
      deltaMessages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'and this one?' },
            { type: 'image_url', image_url: { url: IMG } },
          ],
        },
      ],
    })
    expect(body.previous_response_id).toBe('resp_prev')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('"type":"image_url"')
    expect(serialized).toContain('"type":"input_image"')
    const content = (body.input[0] as { content: Array<Record<string, unknown>> }).content
    expect(content).toEqual([
      { type: 'input_text', text: 'and this one?' },
      { type: 'input_image', image_url: IMG },
    ])
  })
})
