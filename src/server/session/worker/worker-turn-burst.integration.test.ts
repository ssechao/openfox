import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

interface WsMessage {
  id?: string
  type?: string
  sessionId?: string
  payload?: {
    error?: string
    recoverable?: boolean
    message?: { id?: string; role?: string; content?: string; isSystemGenerated?: boolean }
    messageId?: string
    reason?: string
    isRunning?: boolean
  }
}

interface SessionView {
  session: { isRunning: boolean }
  messages: Array<{ id?: string; role?: string; content?: string; isSystemGenerated?: boolean; messageKind?: string }>
}

function isSubsequence(sequence: string[], subsequence: string[]): boolean {
  let cursor = 0
  for (const item of sequence) {
    if (item === subsequence[cursor]) cursor += 1
    if (cursor === subsequence.length) return true
  }
  return subsequence.length === 0
}

describe('worker end-of-turn error burst relay', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let projectId: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-burst-${randomUUID()}`)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'burst',
        backend: 'unknown',
        timeout: 300_000,
        idleTimeout: 300_000,
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
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'burst', workdir: projectDir }),
    })
    expect(response.status).toBe(201)
    projectId = ((await response.json()) as { project: { id: string } }).project.id

    // Force the end-of-turn error path: the mock streams "I understand…" for a
    // generic prompt; that text matches the retry pattern, and after the single
    // allowed retry the agent loop appends chat.error + chat.done and throws,
    // which drives the orchestrator's generic catch (chat.error + message.start
    // + chat.done) and the final running.changed.
    const patternResponse = await fetch(`${base}/api/settings/agent.retryPatterns`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        value: JSON.stringify({
          patterns: [{ field: 'content', pattern: 'I understand', action: 'retry', active: true }],
          maxRetriesPerTurn: 1,
        }),
      }),
    })
    expect(patternResponse.status).toBe(200)
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 20_000)

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

  async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
    const deadline = Date.now() + 30_000
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('relays the whole end-of-turn error burst in order before the worker finishes, matching REST', async () => {
    const sessionId = await createSession('burst-error')
    const ws = await connectWebSocket()
    const received: WsMessage[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw)) as WsMessage))
    try {
      const ack = waitForWs(ws, (message) => message.id === 'load-burst')
      ws.send(JSON.stringify({ id: 'load-burst', type: 'session.load', payload: { sessionId } }))
      await expect(ack).resolves.toMatchObject({ type: 'ack' })

      const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'zzzz unrelated request' }),
      })
      expect(response.status).toBe(200)

      const workerPid = await waitFor(async () => {
        const workers = await fetch(`${base}/api/test/worker`)
        const body = (await workers.json()) as { activeWorkers: Array<{ sessionId: string; pid?: number }> }
        return body.activeWorkers.find((worker) => worker.sessionId === sessionId)?.pid ?? null
      }, 'external worker PID')
      expect(workerPid).not.toBe(process.pid)

      const burst = ['chat.error', 'chat.message', 'chat.done', 'session.running']
      const typesFor = () => received.filter((message) => message.sessionId === sessionId).map((m) => m.type ?? '')

      // Wait for the whole burst over the socket rather than for REST
      // settlement: the relayed events can reach the client a few ms after the
      // gateway marks the session idle, and a loaded host widens that gap.
      await waitFor(async () => (isSubsequence(typesFor(), burst) ? true : null), 'ordered end-of-turn burst')

      await waitFor(
        async () => ((await getSession(sessionId)).session.isRunning ? null : true),
        'worker turn settlement',
      )

      const sessionMessages = received.filter((message) => message.sessionId === sessionId)
      const types = sessionMessages.map((message) => message.type ?? '')

      // The complete end-of-turn burst must survive teardown: the generic catch
      // error, its correction message.start, chat.done and the final
      // running.changed, in that order.
      expect(isSubsequence(types, burst)).toBe(true)

      const burstErrors = sessionMessages.filter((message) => message.type === 'chat.error')
      expect(burstErrors.map((message) => message.payload?.error)).toContain('Auto-retry limit exceeded')

      const lastErrorIndex = sessionMessages.map((message) => message.type).lastIndexOf('chat.error')
      const correction = sessionMessages
        .slice(lastErrorIndex + 1)
        .find((message) => message.type === 'chat.message' && message.payload?.message?.isSystemGenerated === true)
      expect(correction?.payload?.message?.content).toContain('Auto-retry limit exceeded')
      const correctionId = correction?.payload?.message?.id

      const view = await getSession(sessionId)
      expect(view.session.isRunning).toBe(false)
      expect(view.messages.some((message) => message.id === correctionId)).toBe(true)
      expect(JSON.stringify(view.messages)).toContain('Auto-retry limit exceeded')
    } finally {
      ws.close()
    }
  }, 60_000)
})
