import { randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'
import { closeDatabase } from '../../db/index.js'

interface SessionView {
  session: { isRunning: boolean }
  messages: Array<{
    toolCalls?: Array<{
      name?: string
      arguments?: Record<string, unknown>
      result?: { success?: boolean; error?: string }
    }>
  }>
  queuedMessages?: unknown[]
  pendingToolReconciliations?: unknown[]
}

function sendEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

describe('worker preflight provider settlement', () => {
  let gateway: ServerHandle
  let llm: Server
  let base: string
  let root: string
  let projectDir: string
  let projectId: string
  let scenario: 'settle' | 'error' | 'abort' = 'settle'
  let scenarioResponseCount = 0
  let nativeTurnActive = false
  let providerStreamOpen = false

  beforeAll(async () => {
    delete process.env['OPENFOX_MOCK_LLM']
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'

    llm = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'gpt-5.6-luna' }] }))
        return
      }

      request.resume()
      request.on('end', () => {
        scenarioResponseCount += 1
        response.writeHead(200, { 'content-type': 'text/event-stream' })

        if (scenarioResponseCount === 1) {
          nativeTurnActive = true
          providerStreamOpen = true
          let terminalSent = false
          sendEvent(response, { type: 'response.created', response_id: 'resp-preflight' })
          sendEvent(response, {
            type: 'response.output_item.added',
            response_id: 'resp-preflight',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc-preflight',
              call_id: 'call-preflight',
              name: 'edit_file',
              arguments: '',
            },
          })
          sendEvent(response, {
            type: 'response.function_call_arguments.delta',
            response_id: 'resp-preflight',
            output_index: 0,
            delta: '{"path":"target.txt","old_string":"before","new_string":"after"}',
          })
          const terminal = setTimeout(
            () => {
              if (response.destroyed) return
              if (scenario === 'error') {
                terminalSent = true
                nativeTurnActive = false
                sendEvent(response, { type: 'error', message: 'HTTP 400: drain failed' })
                response.end()
                return
              }
              terminalSent = true
              nativeTurnActive = false
              sendEvent(response, {
                type: 'response.completed',
                response_id: 'resp-preflight',
                response: {
                  id: 'resp-preflight',
                  status: 'completed',
                  output: [],
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                },
              })
              response.end()
            },
            scenario === 'abort' ? 10_000 : 250,
          )
          response.once('close', () => {
            providerStreamOpen = false
            if (terminalSent) return
            clearTimeout(terminal)
          })
          return
        }

        if (nativeTurnActive) return

        sendEvent(response, { type: 'response.created', response_id: 'resp-final' })
        sendEvent(response, { type: 'response.output_text.delta', response_id: 'resp-final', delta: 'done' })
        sendEvent(response, {
          type: 'response.completed',
          response_id: 'resp-final',
          response: {
            id: 'resp-final',
            status: 'completed',
            output: [],
            usage: { input_tokens: 15, output_tokens: 1, total_tokens: 16 },
          },
        })
        response.end()
      })
    })
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve))
    const llmPort = (llm.address() as AddressInfo).port

    root = join(tmpdir(), `openfox-preflight-worker-${randomUUID()}`)
    projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'target.txt'), 'before')
    const config: Config = {
      mode: 'test',
      llm: {
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        model: 'gpt-5.6-luna',
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

    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'preflight-worker', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
  }, 60_000)

  afterAll(async () => {
    llm?.closeAllConnections()
    await gateway?.close()
    await new Promise<void>((resolve) => llm?.close(() => resolve()))
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  async function getSession(sessionId: string): Promise<SessionView> {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionView
  }

  async function waitFor<T>(probe: () => Promise<T | null>, label: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  function setScenario(next: typeof scenario): void {
    scenario = next
    scenarioResponseCount = 0
    nativeTurnActive = false
    providerStreamOpen = false
  }

  async function createSessionAndSend(content: string): Promise<string> {
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: `preflight-worker-${scenario}` }),
    })
    expect(sessionResponse.status).toBe(201)
    const sessionId = ((await sessionResponse.json()) as { session: { id: string } }).session.id

    const messageResponse = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(messageResponse.status).toBe(200)
    return sessionId
  }

  async function waitUntilIdle(sessionId: string): Promise<SessionView> {
    return waitFor(
      async () => {
        const view = await getSession(sessionId)
        return view.session.isRunning ? null : view
      },
      'worker settlement',
      5_000,
    )
  }

  it('settles the worker after a preflight-rejected tool result', async () => {
    setScenario('settle')
    const sessionId = await createSessionAndSend('edit target.txt')

    const rejected = await waitFor(
      async () => {
        const view = await getSession(sessionId)
        const toolCall = view.messages
          .flatMap((message) => message.toolCalls ?? [])
          .find((call) => call.name === 'edit_file' && call.result?.success === false)
        return toolCall ? view : null
      },
      'preflight tool.result success=false',
      10_000,
    )

    const rejectedCall = rejected.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.name === 'edit_file' && call.result?.success === false)
    expect(rejectedCall?.arguments).toEqual({ path: 'target.txt' })
    expect(await readFile(join(projectDir, 'target.txt'), 'utf8')).toBe('before')
    expect(rejected.queuedMessages ?? []).toHaveLength(0)
    expect(rejected.pendingToolReconciliations ?? []).toHaveLength(0)

    let settled = rejected
    const deadline = Date.now() + 2_000
    while (settled.session.isRunning && Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      settled = await getSession(sessionId)
    }
    expect(
      {
        isRunning: settled.session.isRunning,
        queuedMessages: settled.queuedMessages ?? [],
        pendingToolReconciliations: settled.pendingToolReconciliations ?? [],
      },
      'tool.result success=false persisted, but the worker did not settle',
    ).toEqual({
      isRunning: false,
      queuedMessages: [],
      pendingToolReconciliations: [],
    })
  }, 30_000)

  it('settles the worker when the provider stream errors during drain', async () => {
    setScenario('error')
    const sessionId = await createSessionAndSend('edit target.txt and handle a drain error')

    await waitFor(async () => (providerStreamOpen ? true : null), 'provider drain start', 5_000)
    const settled = await waitUntilIdle(sessionId)

    expect(scenarioResponseCount).toBe(1)
    expect(providerStreamOpen).toBe(false)
    expect(settled.queuedMessages ?? []).toHaveLength(0)
    expect(settled.pendingToolReconciliations ?? []).toHaveLength(0)
  }, 30_000)

  it('settles the worker when the user stops during drain', async () => {
    setScenario('abort')
    const sessionId = await createSessionAndSend('edit target.txt and wait during drain')

    await waitFor(async () => (providerStreamOpen ? true : null), 'provider drain start', 5_000)
    expect((await getSession(sessionId)).session.isRunning).toBe(true)

    const stop = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)

    const settled = await waitUntilIdle(sessionId)
    await waitFor(async () => (!providerStreamOpen ? true : null), 'provider stream close', 5_000)
    expect(settled.queuedMessages ?? []).toHaveLength(0)
    expect(settled.pendingToolReconciliations ?? []).toHaveLength(0)
  }, 30_000)
})
