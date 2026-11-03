import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

describe('worker event routing', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let projectId: string
  let sessionId: string
  let closed = false

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-worker-event-routing-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(root, 'sessions.db') },
      logging: { level: 'error' },
      workdir: root,
      globalConfigPath: join(root, 'config.json'),
      mcpServers: {},
    }
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-event-routing', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const { project } = (await projectResponse.json()) as { project: { id: string } }
    projectId = project.id
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'worker-event-routing' }),
    })
    expect(sessionResponse.status).toBe(201)
    const body = (await sessionResponse.json()) as { session: { id: string } }
    sessionId = body.session.id
  }, 60_000)

  afterAll(async () => {
    if (!closed) await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 20_000)

  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error('timed out waiting for worker background process')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function send(content: string, targetSessionId = sessionId): Promise<void> {
    const response = await fetch(`${base}/api/sessions/${targetSessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(response.status).toBe(200)
    await waitFor(async () => {
      const current = await fetch(`${base}/api/sessions/${targetSessionId}`)
      const body = (await current.json()) as { session: { isRunning: boolean } }
      return body.session.isRunning ? null : true
    }, 30_000)
  }

  async function getLastBackgroundCall(
    targetSessionId = sessionId,
  ): Promise<{ result?: { success: boolean; output?: string; error?: string } } | undefined> {
    const response = await fetch(`${base}/api/sessions/${targetSessionId}`)
    const body = (await response.json()) as {
      messages: Array<{
        toolCalls?: Array<{ name: string; result?: { success: boolean; output?: string; error?: string } }>
      }>
    }
    return body.messages
      .flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.name === 'background_process')
      .at(-1)
  }

  async function startBackground(
    content: 'BG-IPC-START' | 'BG-IPC-TIMEOUT',
    targetSessionId = sessionId,
  ): Promise<{
    processId: string
    pid: number
  }> {
    await send(content, targetSessionId)
    const call = await getLastBackgroundCall(targetSessionId)
    expect(call?.result?.success).toBe(true)
    expect(call?.result?.output).toBeDefined()
    return JSON.parse(call!.result!.output!) as { processId: string; pid: number }
  }

  type WsMessage = { id?: string; type?: string; sessionId?: string; payload?: { isRunning?: boolean } }

  async function createSession(title: string): Promise<string> {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { session: { id: string } }).session.id
  }

  async function connect(): Promise<{ ws: WebSocket; received: WsMessage[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    const received: WsMessage[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw)) as WsMessage))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return { ws, received }
  }

  async function load(ws: WebSocket, received: WsMessage[], id: string, targetSessionId: string): Promise<void> {
    ws.send(JSON.stringify({ id, type: 'session.load', payload: { sessionId: targetSessionId } }))
    await waitFor(
      async () => (received.some((message) => message.id === id && message.type === 'ack') ? true : null),
      10_000,
    )
  }

  function seen(received: WsMessage[], targetSessionId: string, type: string): boolean {
    return received.some((message) => message.sessionId === targetSessionId && message.type === type)
  }

  it('relays the end of a worker turn to a connection that loaded another session since', async () => {
    const a = await createSession('worker-turn-a')
    const b = await createSession('worker-turn-b')
    const { ws, received } = await connect()
    try {
      await load(ws, received, 'load-a', a)
      await load(ws, received, 'load-b', b)
      await send('hello', a)
      await waitFor(async () => (seen(received, a, 'chat.done') ? true : null), 5_000)
      await waitFor(
        async () =>
          received.some(
            (message) =>
              message.sessionId === a && message.type === 'session.running' && message.payload?.isRunning === false,
          )
            ? true
            : null,
        5_000,
      )
    } finally {
      ws.close()
    }
  }, 60_000)

  it('still relays a worker turn to the session loaded last', async () => {
    const a = await createSession('last-loaded-a')
    const b = await createSession('last-loaded-b')
    const { ws, received } = await connect()
    try {
      await load(ws, received, 'load-a', a)
      await load(ws, received, 'load-b', b)
      await send('hello', b)
      await waitFor(async () => (seen(received, b, 'chat.done') ? true : null), 5_000)
    } finally {
      ws.close()
    }
  }, 60_000)

  it('does not relay the stream of a session the connection never loaded', async () => {
    const a = await createSession('never-loaded-a')
    const b = await createSession('never-loaded-b')
    const { ws, received } = await connect()
    try {
      await load(ws, received, 'load-b', b)
      await send('hello', a)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(
        received.filter(
          (message) => message.sessionId === a && (message.type === 'chat.delta' || message.type === 'chat.done'),
        ),
      ).toEqual([])
    } finally {
      ws.close()
    }
  }, 60_000)

  it('relays background process events of a session loaded before another', async () => {
    const a = await createSession('background-a')
    const b = await createSession('background-b')
    const { ws, received } = await connect()
    try {
      await load(ws, received, 'load-a', a)
      const started = await startBackground('BG-IPC-START', a)
      await load(ws, received, 'load-b', b)
      await send(`BG-IPC-STOP ${started.processId}`, a)
      await waitFor(async () => (seen(received, a, 'backgroundProcess.removed') ? true : null), 5_000)
    } finally {
      ws.close()
    }
  }, 60_000)
})
