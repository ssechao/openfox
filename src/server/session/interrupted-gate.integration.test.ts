import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

interface SessionView {
  session: { interruptedAt?: string | null }
  pendingToolReconciliations: Array<{ toolCallId: string }>
  queueState: unknown[]
}

describe('interrupted session gate', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let config: Config

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'false'
    root = join(tmpdir(), `openfox-shutdown-interruption-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    config = {
      mode: 'test',
      llm: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'shutdown-interruption',
        backend: 'unknown',
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
    await startServer()
  }, 120_000)

  afterAll(async () => {
    await server?.close().catch(() => {})
    const { closeDatabase } = await import('../db/index.js')
    closeDatabase()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  async function startServer(): Promise<void> {
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
  }

  async function createSession(title: string): Promise<string> {
    const projectDir = join(root, title)
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: title, workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title }),
    })
    expect(sessionResponse.status).toBe(201)
    return ((await sessionResponse.json()) as { session: { id: string } }).session.id
  }

  async function getSession(sessionId: string): Promise<SessionView> {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionView
  }

  async function interruptSession(sessionId: string): Promise<void> {
    const { markSessionInterrupted } = await import('./worker/crash.js')
    const { getDatabase } = await import('../db/index.js')
    markSessionInterrupted(getDatabase(), sessionId, new Date().toISOString())
  }

  it('refuses a message to an interrupted session with 409 SESSION_INTERRUPTED and queues nothing', async () => {
    const sessionId = await createSession('interrupted-message')
    await interruptSession(sessionId)

    const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(response.status).toBe(409)
    expect((await response.json()) as { code?: string }).toMatchObject({ code: 'SESSION_INTERRUPTED' })

    const view = await getSession(sessionId)
    expect(view.session.interruptedAt).toBeTruthy()
    expect(view.queueState).toHaveLength(0)
  })

  it('refuses runner.launch on an interrupted session with SESSION_INTERRUPTED', async () => {
    const sessionId = await createSession('interrupted-runner')
    await interruptSession(sessionId)
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      const reply = new Promise<{ id?: string; type?: string; payload?: { code?: string } }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for runner.launch response')), 10_000)
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as {
            id?: string
            type?: string
            payload?: { code?: string }
          }
          if (message.id !== 'launch-1') return
          clearTimeout(timeout)
          resolve(message)
        })
      })

      socket.send(
        JSON.stringify({
          id: 'launch-1',
          type: 'runner.launch',
          payload: { sessionId, workflowId: 'default', content: 'go' },
        }),
      )

      const message = await reply
      expect(message.type).toBe('error')
      expect(message.payload?.code).toBe('SESSION_INTERRUPTED')
      expect((await getSession(sessionId)).session.interruptedAt).toBeTruthy()
      const { getSessionRuntimeRegistry } = await import('./runtime.js')
      expect(getSessionRuntimeRegistry().countActive()).toBe(0)
    } finally {
      socket.close()
    }
  })

  it('refuses resume-interruption while the session runtime is busy and keeps the marker', async () => {
    const sessionId = await createSession('interrupted-resume')
    await interruptSession(sessionId)
    const { getSessionRuntimeRegistry } = await import('./runtime.js')
    getSessionRuntimeRegistry().get(sessionId).acquire('workflow')

    const response = await fetch(`${base}/api/sessions/${sessionId}/resume-interruption`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect((await response.json()) as { code?: string }).toMatchObject({ code: 'SESSION_ALREADY_RUNNING' })
    expect((await getSession(sessionId)).session.interruptedAt).toBeTruthy()
  })
})
