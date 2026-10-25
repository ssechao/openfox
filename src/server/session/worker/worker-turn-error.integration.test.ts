import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

interface WsMessage {
  id?: string
  type?: string
  sessionId?: string
  payload?: { error?: string }
}

describe('worker turn error relay', () => {
  let gateway: ServerHandle
  let llm: Server
  let base: string
  let root: string
  let projectId: string
  let llmHits = 0
  let previousMockLlm: string | undefined

  beforeAll(async () => {
    previousMockLlm = process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_MOCK_LLM']
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'

    llm = createServer((request, response) => {
      llmHits += 1
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'worker-error-model' }] }))
        return
      }
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'native_context_unavailable', type: 'invalid_request_error' } }))
    })
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve))
    const llmPort = (llm.address() as AddressInfo).port

    root = join(tmpdir(), `openfox-worker-error-${randomUUID()}`)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: {
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        model: 'worker-error-model',
        backend: 'openai',
        timeout: 30_000,
        idleTimeout: 30_000,
      },
      context: { maxTokens: 100_000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120_000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(root, 'sessions.db') },
      logging: { level: 'error' },
      workdir: root,
      globalConfigPath: join(root, 'config.json'),
    }
    const { createServerHandle } = await import('../../index.js')
    gateway = await createServerHandle(config)
    const { port } = await gateway.start(0)
    base = `http://127.0.0.1:${port}`

    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-error', workdir: projectDir }),
    })
    expect(response.status).toBe(201)
    projectId = ((await response.json()) as { project: { id: string } }).project.id
  }, 120_000)

  afterAll(async () => {
    await gateway?.close()
    await new Promise<void>((resolve) => llm?.close(() => resolve()))
    if (previousMockLlm === undefined) delete process.env['OPENFOX_MOCK_LLM']
    else process.env['OPENFOX_MOCK_LLM'] = previousMockLlm
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 20_000)

  it('logs an HTTP 400 in the gateway and exposes chat.error over WebSocket', async () => {
    const createResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'worker-error' }),
    })
    expect(createResponse.status).toBe(201)
    const sessionId = ((await createResponse.json()) as { session: { id: string } }).session.id
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    const received: WsMessage[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw)) as WsMessage))

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const loaded = waitForWs(ws, (message) => message.id === 'load-worker-error')
      ws.send(JSON.stringify({ id: 'load-worker-error', type: 'session.load', payload: { sessionId } }))
      await loaded

      const chatError = waitForWs(
        ws,
        (message) =>
          message.sessionId === sessionId &&
          message.type === 'chat.error' &&
          message.payload?.error?.includes('native_context_unavailable') === true,
      )
      const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'trigger the wrapper error' }),
      })
      expect(response.status).toBe(200)

      const relayed = await chatError.catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; hits=${llmHits}; messages=${JSON.stringify(received)}`,
        )
      })
      expect(relayed).toMatchObject({
        type: 'chat.error',
        sessionId,
        payload: { error: expect.stringContaining('native_context_unavailable') },
      })
      expect(errorLog.mock.calls.flat().join(' ')).toContain('native_context_unavailable')
    } finally {
      errorLog.mockRestore()
      ws.close()
    }
  }, 120_000)
})

function waitForWs(ws: WebSocket, predicate: (message: WsMessage) => boolean): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('timed out waiting for WebSocket response'))
    }, 60_000)
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as WsMessage
      if (!predicate(message)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}
