import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

interface WorkerIntrospection {
  active: { sessionId: string } | null
}

interface SessionView {
  session: { isRunning: boolean }
  messages: Array<{ id: string; role: string; content?: string }>
}

describe('session worker stop relay', () => {
  let server: ServerHandle
  let base: string
  let workdir: string
  let dbDir: string
  let requestStopSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    workdir = join(tmpdir(), `openfox-worker-stop-${randomUUID()}`)
    dbDir = join(tmpdir(), `openfox-worker-stop-db-${randomUUID()}`)
    await mkdir(workdir, { recursive: true })
    await mkdir(dbDir, { recursive: true })
    const { SessionWorkerManager } = await import('./manager.js')
    requestStopSpy = vi.spyOn(SessionWorkerManager.prototype, 'requestStop')
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(dbDir, 'sessions.db') },
      logging: { level: 'error' },
      workdir,
      globalConfigPath: join(tmpdir(), `openfox-worker-stop-${randomUUID()}.json`),
    }
    const { createServerHandle } = await import('../../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    requestStopSpy?.mockRestore()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
    await rm(dbDir, { recursive: true, force: true }).catch(() => {})
  }, 20_000)

  async function createSession(): Promise<string> {
    const projectDir = join(workdir, randomUUID())
    await mkdir(projectDir, { recursive: true })
    const projectRes = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `p-${randomUUID().slice(0, 8)}`, workdir: projectDir }),
    })
    expect(projectRes.status).toBe(201)
    const { project } = (await projectRes.json()) as { project: { id: string } }
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title: 'stop-victim' }),
    })
    expect(sessionRes.status).toBe(201)
    const { session } = (await sessionRes.json()) as { session: { id: string } }
    return session.id
  }

  async function getSessionView(sessionId: string): Promise<SessionView> {
    const res = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    return (await res.json()) as SessionView
  }

  async function waitForActiveWorker(sessionId: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (Date.now() <= deadline) {
      const res = await fetch(`${base}/api/test/worker`)
      expect(res.status).toBe(200)
      const worker = (await res.json()) as WorkerIntrospection
      if (worker.active?.sessionId === sessionId) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('timed out waiting for worker to be launched')
  }

  it('relays Stop to the manager while a worker turn is active', async () => {
    const settingRes = await fetch(`${base}/api/settings/agent.sessionWorkerMode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'true' }),
    })
    expect(settingRes.status).toBe(200)

    const sessionId = await createSession()
    const messageRes = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Run the exact command: sleep 30' }),
    })
    expect(messageRes.status).toBe(200)
    await waitForActiveWorker(sessionId)

    const stopRes = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
    expect(stopRes.status).toBe(200)
    expect(requestStopSpy).toHaveBeenCalledWith(sessionId)

    const stopped = await getSessionView(sessionId)
    expect(stopped.session.isRunning).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect((await getSessionView(sessionId)).messages).toEqual(stopped.messages)
  }, 30_000)
})
