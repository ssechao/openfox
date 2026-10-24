import { randomUUID } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'
import { linkAbortSignal } from './abort-link.js'

const here = dirname(fileURLToPath(import.meta.url))

interface SessionView {
  session: { isRunning: boolean }
  messages: unknown[]
  pendingQuestions: Array<{ callId: string }>
}

interface WsMessage {
  id?: string
  type?: string
  payload?: { code?: string }
}

describe('gateway IPC integration', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let projectDir: string
  let projectId: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-gateway-ipc-${randomUUID()}`)
    projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const workflowDir = join(projectDir, '.openfox', 'workflows')
    await mkdir(workflowDir, { recursive: true })
    await writeFile(
      join(workflowDir, 'slow-effect.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'slow-effect',
          name: 'Slow effect',
          description: 'Writes a marker after a delay',
          version: '1.0.0',
        },
        entryStep: 'effect',
        settings: { maxIterations: 2 },
        steps: [
          {
            id: 'effect',
            name: 'Effect',
            type: 'shell',
            phase: 'build',
            command: `printf started > ${JSON.stringify(join(root, 'workflow-started'))}; sleep 2; printf late > ${JSON.stringify(join(root, 'late-effect'))}`,
            transitions: [{ when: { type: 'always' }, goto: '$done' }],
          },
        ],
      }),
    )
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
      mcpServers: {
        'test-server': {
          transport: 'stdio',
          command: 'npx',
          args: ['tsx', join(here, '..', '..', '..', '..', 'e2e', 'mock-mcp-server.ts')],
        },
      },
    }
    const { createServerHandle } = await import('../../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gateway-ipc', workdir: projectDir }),
    })
    expect(response.status).toBe(201)
    projectId = ((await response.json()) as { project: { id: string } }).project.id
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 20_000)

  async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
    const deadline = Date.now() + 30_000
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function createSession(title: string): Promise<string> {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { session: { id: string } }).session.id
  }

  async function getSession(sessionId: string): Promise<SessionView> {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionView
  }

  async function sendMessage(sessionId: string, content: string): Promise<void> {
    const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(response.status).toBe(200)
  }

  async function connectWebSocket(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return ws
  }

  function waitForWs(ws: WebSocket, predicate: (message: WsMessage) => boolean): Promise<WsMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMessage)
        reject(new Error('timed out waiting for WebSocket response'))
      }, 10_000)
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

  it('propagates an abort received before workflow runtime acquisition', () => {
    const source = new AbortController()
    const target = new AbortController()
    source.abort()

    linkAbortSignal(source.signal, () => target.abort())

    expect(target.signal.aborted).toBe(true)
  })

  it('executes gateway-owned MCP through a real external worker', async () => {
    await waitFor(async () => {
      const response = await fetch(`${base}/api/mcp/servers`)
      const body = (await response.json()) as { servers: Array<{ name: string; status: string }> }
      return body.servers.some((item) => item.name === 'test-server' && item.status === 'connected') ? true : null
    }, 'gateway MCP server')

    const sessionId = await createSession('gateway-mcp')
    await sendMessage(sessionId, 'Call the MCP tool test-server_greet')

    const messages = await waitFor(async () => {
      const view = await getSession(sessionId)
      const serialized = JSON.stringify(view.messages)
      return !view.session.isRunning && serialized.includes('WorkerCleanupProbe') ? serialized : null
    }, 'MCP turn completion')

    expect(messages).toContain('test-server_greet')
    expect(messages).not.toMatch(/Unknown tool|tool.*not.*found/i)
  }, 60_000)

  it('routes a WebSocket answer through the gateway broker to an external worker', async () => {
    const sessionId = await createSession('gateway-answer')
    const ws = await connectWebSocket()
    try {
      const loadResponse = waitForWs(ws, (message) => message.id === 'load')
      ws.send(JSON.stringify({ id: 'load', type: 'session.load', payload: { sessionId } }))
      await expect(loadResponse).resolves.toMatchObject({ type: 'ack' })

      await sendMessage(sessionId, 'ask the user a question')
      const callId = await waitFor(async () => {
        const view = await getSession(sessionId)
        return view.pendingQuestions[0]?.callId ?? null
      }, 'worker question')
      const workerPid = await waitFor(async () => {
        const response = await fetch(`${base}/api/test/worker`)
        const body = (await response.json()) as { activeWorkers: Array<{ sessionId: string; pid?: number }> }
        return body.activeWorkers.find((worker) => worker.sessionId === sessionId)?.pid ?? null
      }, 'external worker PID')
      expect(workerPid).not.toBe(process.pid)

      const answerResponse = waitForWs(ws, (message) => message.id === 'answer')
      ws.send(JSON.stringify({ id: 'answer', type: 'ask.answer', payload: { callId, answer: 'Continue' } }))
      await expect(answerResponse).resolves.toMatchObject({ type: 'ack' })

      const finished = await waitFor(async () => {
        const view = await getSession(sessionId)
        return !view.session.isRunning && view.pendingQuestions.length === 0 ? view : null
      }, 'answered turn completion')
      expect(JSON.stringify(finished.messages)).toContain('Continue')

      const lateResponse = waitForWs(ws, (message) => message.id === 'late')
      ws.send(JSON.stringify({ id: 'late', type: 'ask.answer', payload: { callId, answer: 'Late' } }))
      await expect(lateResponse).resolves.toMatchObject({ type: 'error', payload: { code: 'NOT_FOUND' } })
    } finally {
      ws.close()
    }
  }, 60_000)

  it('aborts a workflow even when Stop reaches the worker before runtime acquisition', async () => {
    const sessionId = await createSession('workflow-stop')
    const ws = await connectWebSocket()
    try {
      const loadResponse = waitForWs(ws, (message) => message.id === 'load-stop')
      ws.send(JSON.stringify({ id: 'load-stop', type: 'session.load', payload: { sessionId } }))
      await expect(loadResponse).resolves.toMatchObject({ type: 'ack' })

      const launchResponse = waitForWs(ws, (message) => message.id === 'launch-stop')
      ws.send(
        JSON.stringify({
          id: 'launch-stop',
          type: 'runner.launch',
          payload: { sessionId, workflowId: 'slow-effect', scope: 'project' },
        }),
      )
      await expect(launchResponse).resolves.toMatchObject({ type: 'ack' })

      await waitFor(async () => {
        const response = await fetch(`${base}/api/test/worker`)
        const body = (await response.json()) as { activeWorkers: Array<{ sessionId: string }> }
        return body.activeWorkers.some((worker) => worker.sessionId === sessionId) ? true : null
      }, 'workflow worker allocation')
      await waitFor(
        async () =>
          access(join(root, 'workflow-started'))
            .then(() => true)
            .catch(() => null),
        'workflow start',
      )

      const stop = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
      expect(stop.status).toBe(200)
      await waitFor(async () => {
        const view = await getSession(sessionId)
        return !view.session.isRunning ? true : null
      }, 'workflow stop')
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      await expect(access(join(root, 'late-effect'))).rejects.toThrow()
    } finally {
      ws.close()
    }
  }, 60_000)
})
