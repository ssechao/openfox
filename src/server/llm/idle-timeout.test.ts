import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLLMClient } from './client.js'

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const CHAT_OK_SSE = [
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }),
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  JSON.stringify({ id: 'c-ok', choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
]

type Mode = 'ping-then-data' | 'silent'

async function startServer(mode: Mode): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (mode === 'silent') return
      let pings = 0
      const timer = setInterval(() => {
        pings += 1
        if (pings <= 10) {
          res.write(': ping\n\n')
          return
        }
        clearInterval(timer)
        for (const line of CHAT_OK_SSE) res.write(`data: ${line}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }, 50)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function makeClient(port: number) {
  return createLLMClient({
    llm: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeout: 10000,
      idleTimeout: 200,
      model: 'gpt-5.6-sol',
      apiKey: 'test-key',
      backend: 'openai',
      apiProtocol: 'chat-completions',
    },
    context: { maxTokens: 8192, compactionThreshold: 0.85, compactionTarget: 0.6 },
  } as never)
}

describe('LLM stream idle timeout and SSE heartbeats', () => {
  const servers: Server[] = []

  afterAll(() => {
    for (const server of servers) server.close()
  })

  it('SSE comment pings count as signs of life: a ping-kept stream survives the idle timeout', async () => {
    const { server, port } = await startServer('ping-then-data')
    servers.push(server)
    const client = makeClient(port)
    let text = ''
    const errors: string[] = []
    for await (const event of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'text_delta') text += event.content
      if (event.type === 'error') errors.push(event.error)
    }
    expect(errors).toEqual([])
    expect(text).toBe('done')
  })

  it('a truly silent stream still hits the idle timeout', async () => {
    const { server, port } = await startServer('silent')
    servers.push(server)
    const client = makeClient(port)
    const errors: string[] = []
    for await (const event of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'error') errors.push(event.error)
    }
    expect(errors.some((e) => /idle timeout/i.test(e))).toBe(true)
  })
})
