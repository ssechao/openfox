import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLLMClient } from './client.js'

/**
 * Finding B (remediation plan): tool-call argument integrity across the
 * streaming boundary.
 *
 * These tests boot a real HTTP server and emit raw SSE bytes in small
 * TCP-sized chunks, so line framing (`readResponseLines`) and incremental
 * UTF-8 decoding are exercised for real. A large tool call must reach the
 * caller byte-for-byte; a damaged or truncated stream must fail loudly
 * instead of silently dropping a delta.
 */

const rustBlock = (i: number): string =>
  [
    `// Bloc ${i} — accents éàù, lambda λ, check ✓, crab 🦀`,
    `impl Widget${i} {`,
    `    fn borrow(&self) -> &str { "he said \\"hi\\" & bye" }`,
    `    fn mutate(&mut self, path: &str) {`,
    `        let win = "C:\\\\tmp\\\\file${i}.txt";`,
    `        let re = "\\\\d+&\\\\w+";`,
    `        if self.ready && self.dirty { println!("{} {} {}", win, re, path); }`,
    `    }`,
    `}`,
    '',
  ].join('\n')

/** A >15 KiB write_file argument payload: newlines, escaped quotes, backslashes, Unicode, Rust refs, ampersands. */
function buildLargeArguments(): { args: Record<string, unknown>; json: string } {
  let content = ''
  for (let i = 0; content.length < 16 * 1024; i += 1) content += rustBlock(i)
  const args = { path: 'src/widget.rs', content }
  return { args, json: JSON.stringify(args) }
}

function chunkString(value: string, size: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size))
  return parts
}

function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const OPEN_FRAME = frame({
  id: 'resp-1',
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '' } }],
      },
    },
  ],
})

const argsFrame = (delta: string): string =>
  frame({
    id: 'resp-1',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: delta } }] } }],
  })

const FINISH_FRAME = frame({
  id: 'resp-1',
  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
})

const DONE_FRAME = 'data: [DONE]\n\n'

/** Serves `body` as an SSE response, written in small byte-sized chunks. */
async function startChatMock(body: string, chunkBytes = 64): Promise<{ server: Server; port: number }> {
  const payload = Buffer.from(body, 'utf8')
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let i = 0; i < payload.length; i += chunkBytes) res.write(payload.subarray(i, i + chunkBytes))
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

type StreamEvent = Record<string, unknown>

describe('streaming tool-call argument integrity', () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const server of servers) server.close()
  })

  async function collect(body: string): Promise<StreamEvent[]> {
    const mock = await startChatMock(body)
    servers.push(mock.server)
    const client = createLLMClient({
      llm: {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        timeout: 10_000,
        idleTimeout: 10_000,
        model: 'qwen3-32b',
        apiKey: 'test-key',
        backend: 'vllm',
      },
      context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
    } as never)

    const events: StreamEvent[] = []
    for await (const event of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event as StreamEvent)
    }
    return events
  }

  const accumulatedDeltas = (events: StreamEvent[]): string =>
    events
      .filter((e) => e['type'] === 'tool_call_delta' && typeof e['arguments'] === 'string')
      .map((e) => e['arguments'] as string)
      .join('')

  const doneResponse = (
    events: StreamEvent[],
  ): {
    toolCalls?: Array<{
      id: string
      name: string
      arguments: Record<string, unknown>
      parseError?: string
      rawArguments?: string
    }>
    finishReason: string
  } => (events.find((e) => e['type'] === 'done')?.['response'] ?? { finishReason: 'missing' }) as never

  it('preserves a >15 KiB tool-call argument split across many deltas byte-for-byte', async () => {
    const { args, json } = buildLargeArguments()
    expect(json.length).toBeGreaterThan(15 * 1024)

    const deltas = chunkString(json, 89)
    expect(deltas.length).toBeGreaterThan(150)

    const events = await collect([OPEN_FRAME, ...deltas.map(argsFrame), FINISH_FRAME, DONE_FRAME].join(''))

    expect(accumulatedDeltas(events)).toBe(json)

    const response = doneResponse(events)
    expect(events.filter((e) => e['type'] === 'done')).toHaveLength(1)
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls![0]!.name).toBe('write_file')
    expect(response.toolCalls![0]!.parseError).toBeUndefined()
    expect(response.toolCalls![0]!.arguments).toEqual(args)
    expect(response.finishReason).toBe('tool_calls')
  })

  it('does not drop the last SSE event when the body ends without a trailing newline', async () => {
    const { args, json } = buildLargeArguments()
    const deltas = chunkString(json, 89)
    const last = deltas.pop()!

    // The final frame carries the closing delta and is not newline-terminated.
    const body = [OPEN_FRAME, ...deltas.map(argsFrame), FINISH_FRAME].join('') + argsFrame(last).trimEnd()

    const events = await collect(body)

    expect(accumulatedDeltas(events)).toBe(json)
    const response = doneResponse(events)
    expect(response.toolCalls![0]!.parseError).toBeUndefined()
    expect(response.toolCalls![0]!.arguments).toEqual(args)
  })

  it('fails loudly instead of silently dropping an unparsable SSE data line', async () => {
    const { json } = buildLargeArguments()
    const deltas = chunkString(json, 89)
    const damaged = `data: {"id":"resp-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"trunc\n\n`

    const body = [
      OPEN_FRAME,
      ...deltas.slice(0, 20).map(argsFrame),
      damaged,
      ...deltas.slice(20).map(argsFrame),
      FINISH_FRAME,
      DONE_FRAME,
    ].join('')

    const events = await collect(body)

    const error = events.find((e) => e['type'] === 'error')
    expect(error).toBeDefined()
    expect(String(error!['error'])).toMatch(/stream/i)
    // A corrupted stream must never be reported as a completed turn.
    expect(events.some((e) => e['type'] === 'done')).toBe(false)
  })

  it('reports truncated tool arguments as an explicit parse error without repairing the JSON', async () => {
    const partial = '{"path":"src/widget.rs","content":"fn main() { let s = &mut'
    const body = [OPEN_FRAME, ...chunkString(partial, 7).map(argsFrame), FINISH_FRAME, DONE_FRAME].join('')

    const events = await collect(body)

    const response = doneResponse(events)
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls![0]!.parseError).toBeTruthy()
    // No guessing: the raw bytes are kept verbatim and no arguments are invented.
    expect(response.toolCalls![0]!.rawArguments).toBe(partial)
    expect(response.toolCalls![0]!.arguments).toEqual({})
  })

  it('reports EOF after partial thinking as a failure, not a completed response', async () => {
    const events = await collect(
      frame({
        id: 'resp-1',
        choices: [{ index: 0, delta: { reasoning_content: 'partial thought' } }],
      }),
    )
    expect(events.some((event) => event['type'] === 'thinking_delta')).toBe(true)
    expect(events.some((event) => event['type'] === 'done')).toBe(false)
    expect(events.find((event) => event['type'] === 'error')?.['error']).toMatch(/terminal/i)
  })
})
