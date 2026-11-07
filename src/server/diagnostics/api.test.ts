import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../shared/types.js'
import { DIAGNOSTICS_SERIES_NAMES, type DiagnosticsData } from '../../shared/diagnostics.js'
import type { ServerHandle } from '../context.js'

const VALID_TOKEN = 'diagnostics-test-token'

vi.mock('../auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth.js')>()),
  getAuthConfig: () => ({ strategy: 'network', encryptedPassword: 'configured' }),
  isValidToken: async (token: string) => token === VALID_TOKEN,
}))

describe('/api/diagnostics', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let projectId: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES'] = '1'
    root = join(tmpdir(), `openfox-diagnostics-test-${randomUUID()}`)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
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
    }
    const { createServerHandle } = await import('../index.js')
    try {
      server = await createServerHandle(config)
    } finally {
      delete process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES']
    }
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ name: 'diagnostics-worker', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 15_000)

  const authed = (path: string) => fetch(base + path, { headers: { 'x-session-token': VALID_TOKEN } })

  it('requires authentication, unlike /api/health', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/diagnostics`)).status).toBe(401)
    const wrong = await fetch(`${base}/api/diagnostics`, { headers: { 'x-session-token': 'nope' } })
    expect(wrong.status).toBe(401)
  })

  it('returns every series with unit, window, sample count and value', async () => {
    await fetch(`${base}/api/health`)
    const res = await authed('/api/diagnostics')
    expect(res.status).toBe(200)
    const data = (await res.json()) as DiagnosticsData

    expect(data).toMatchObject({ intervalMs: 1000, windowMs: 10_000, historyMs: 60_000 })
    expect(data.history).toHaveLength(60)
    for (const name of DIAGNOSTICS_SERIES_NAMES) {
      const series = data.series[name]
      expect(series, name).toBeDefined()
      expect(['ms', 'bytes', 'count']).toContain(series.unit)
      expect(series.window.endMs - series.window.startMs).toBeGreaterThanOrEqual(10_000)
      expect(series.window.endMs - series.window.startMs).toBeLessThan(11_000)
      expect(typeof series.samples).toBe('number')
      expect(series.value === null || typeof series.value === 'number').toBe(true)
    }
    expect(data.series.healthLatencyP99.samples).toBeGreaterThanOrEqual(1)
    expect(data.series.rss.value).toBeGreaterThan(0)
    expect(data.series.runningSessions.value).toBe(0)
  })

  it('exposes worker identity and raw series, then retains the detected exit reason', async () => {
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ projectId, title: 'diagnostics-worker' }),
    })
    expect(sessionResponse.status).toBe(201)
    const sessionId = ((await sessionResponse.json()) as { session: { id: string } }).session.id

    const launchResponse = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ content: 'Ask the user a question before continuing.' }),
    })
    expect(launchResponse.status).toBe(200)

    const deadline = Date.now() + 20_000
    let worker: NonNullable<DiagnosticsData['workerProcesses']>[number] | undefined
    while (Date.now() < deadline) {
      const data = (await (await authed('/api/diagnostics')).json()) as DiagnosticsData
      worker = data.workerProcesses?.find((candidate) => candidate.sessionId === sessionId)
      if (worker?.freshness === 'fresh') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(worker).toMatchObject({ sessionId, generation: 1, freshness: 'fresh' })
    expect(worker?.workerId).toEqual(expect.any(String))
    expect(worker?.series.rss.value).toBeGreaterThan(0)
    expect(worker?.series.eventLoopDelayP99).toBeDefined()

    const stopResponse = await fetch(`${base}/api/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'x-session-token': VALID_TOKEN },
    })
    expect(stopResponse.status).toBe(200)

    let stale: NonNullable<DiagnosticsData['staleSeries']>[number] | undefined
    while (Date.now() < deadline) {
      const data = (await (await authed('/api/diagnostics')).json()) as DiagnosticsData
      stale = data.staleSeries?.find(
        (candidate) => candidate.workerId === worker?.workerId && candidate.generation === worker?.generation,
      )
      if (stale) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(stale).toMatchObject({ reason: 'exit' })
  }, 30_000)

  it('exposes worker pool capacity, active sessions and waiting sessions', async () => {
    const headers = { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN }
    const createSession = async (title: string) => {
      const response = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectId, title }),
      })
      expect(response.status).toBe(201)
      return ((await response.json()) as { session: { id: string } }).session.id
    }
    const sessionA = await createSession('pool-active')
    const sessionB = await createSession('pool-waiting')
    const sendMessage = async (sessionId: string) => {
      const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'Ask the user a question before continuing.' }),
      })
      expect(response.status).toBe(200)
    }
    await sendMessage(sessionA)
    await sendMessage(sessionB)

    type WorkerPoolDiagnostics = {
      maxConcurrent: number
      activeSessions: string[]
      waitingSessions: string[]
      closed: boolean
    }
    const readPool = async () =>
      (
        (await (await authed('/api/diagnostics')).json()) as DiagnosticsData & {
          workerPool?: WorkerPoolDiagnostics
        }
      ).workerPool

    const waiting = await readPool()
    expect(waiting, 'workerPool').toBeDefined()
    const deadline = Date.now() + 20_000
    let pool = waiting
    while (pool && Date.now() < deadline) {
      if (
        pool.maxConcurrent === 1 &&
        pool.closed === false &&
        pool.activeSessions.includes(sessionA) &&
        pool.waitingSessions.includes(sessionB) &&
        !pool.activeSessions.includes(sessionB)
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      pool = await readPool()
    }
    expect(pool).toEqual({
      maxConcurrent: 1,
      activeSessions: [sessionA],
      waitingSessions: [sessionB],
      closed: false,
    })

    const stopResponse = await fetch(`${base}/api/sessions/${sessionA}/stop`, {
      method: 'POST',
      headers: { 'x-session-token': VALID_TOKEN },
    })
    expect(stopResponse.status).toBe(200)

    let promoted = pool
    while (Date.now() < deadline) {
      promoted = await readPool()
      if (
        promoted?.activeSessions.includes(sessionB) &&
        !promoted.waitingSessions.includes(sessionB) &&
        !promoted.activeSessions.includes(sessionA)
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(promoted).toEqual({
      maxConcurrent: 1,
      activeSessions: [sessionB],
      waitingSessions: [],
      closed: false,
    })
  }, 30_000)

  it('does not expose the calibrated loop blocker outside the demo flag', async () => {
    const res = await fetch(`${base}/api/test/block-loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ ms: 10 }),
    })
    expect(res.status).not.toBe(200)
  })
})
