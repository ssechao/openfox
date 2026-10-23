import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../shared/types.js'
import { DIAGNOSTICS_SERIES_NAMES, type DiagnosticsData, type RuntimeLastCommand } from '../../shared/diagnostics.js'
import type { ServerHandle } from '../context.js'
import { createDiagnosticsCollector } from './collector.js'
import { SessionRuntimeRegistry } from '../session/index.js'

const VALID_TOKEN = 'runtimes-test-token'
const LAST_COMMANDS: RuntimeLastCommand[] = ['launch', 'stop', 'pause', 'resume', 'answer', 'workflow', 'compact']

vi.mock('../auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth.js')>()),
  getAuthConfig: () => ({ strategy: 'network', encryptedPassword: 'configured' }),
  isValidToken: async (token: string) => token === VALID_TOKEN,
}))

describe('diagnostics runtimes (collector)', () => {
  it('exposes runtimes outside series, with enum lastCommand only', () => {
    const registry = new SessionRuntimeRegistry()
    const collector = createDiagnosticsCollector({
      runtimeRegistry: registry,
      intervalMs: 1_000,
      enableLoopSampler: false,
    })

    registry.get('sess-1').acquire('chat')
    const data = collector.getData()

    expect(Object.keys(data.series).sort()).toEqual([...DIAGNOSTICS_SERIES_NAMES].sort())
    expect(data.runtimes).toEqual([{ sessionId: 'sess-1', state: 'running', lastCommand: 'launch' }])
    expect(LAST_COMMANDS).toContain(data.runtimes[0]!.lastCommand)
    expect(JSON.stringify(data.runtimes)).not.toMatch(/please|prompt|bash |rm -rf/i)
  })

  it('defaults to an empty runtimes array when no registry is wired', () => {
    const collector = createDiagnosticsCollector({ intervalMs: 1_000, enableLoopSampler: false })
    expect(collector.getData().runtimes).toEqual([])
  })
})

describe('GET /api/diagnostics runtimes', () => {
  let server: ServerHandle
  let base: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: ':memory:' },
      logging: { level: 'error' },
      workdir: tmpdir(),
      globalConfigPath: join(tmpdir(), `openfox-runtimes-test-${randomUUID()}.json`),
    }
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
  }, 15_000)

  const authed = (path: string, init?: RequestInit) =>
    fetch(base + path, {
      ...init,
      headers: { 'x-session-token': VALID_TOKEN, ...(init?.headers ?? {}) },
    })

  it('returns 401 without a token and keeps étape 1 series', async () => {
    expect((await fetch(`${base}/api/diagnostics`)).status).toBe(401)
    const res = await authed('/api/diagnostics')
    expect(res.status).toBe(200)
    const data = (await res.json()) as DiagnosticsData
    expect(data.runtimes).toEqual([])
    for (const name of DIAGNOSTICS_SERIES_NAMES) {
      expect(data.series[name]).toBeDefined()
    }
    expect(data).not.toHaveProperty('series.runtimes')
  })

  it('lists a runtime after stop and drops it after DELETE', async () => {
    const projectDir = join(tmpdir(), `openfox-runtimes-${randomUUID()}`)
    await mkdir(projectDir, { recursive: true })
    const projectRes = await authed('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ name: 'runtimes', workdir: projectDir }),
    })
    expect(projectRes.status).toBe(201)
    const { project } = (await projectRes.json()) as { project: { id: string } }

    const sessionRes = await authed('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ projectId: project.id, title: 'runtimes' }),
    })
    expect(sessionRes.status).toBe(201)
    const { session } = (await sessionRes.json()) as { session: { id: string } }

    const stopRes = await authed(`/api/sessions/${session.id}/stop`, { method: 'POST' })
    expect(stopRes.status).toBe(200)

    const afterStop = (await (await authed('/api/diagnostics')).json()) as DiagnosticsData
    const snapshot = afterStop.runtimes.find((runtime) => runtime.sessionId === session.id)
    expect(snapshot).toMatchObject({ sessionId: session.id, lastCommand: 'stop' })
    expect(snapshot?.state).toBe('idle')

    const del = await authed(`/api/sessions/${session.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const afterDelete = (await (await authed('/api/diagnostics')).json()) as DiagnosticsData
    expect(afterDelete.runtimes.find((runtime) => runtime.sessionId === session.id)).toBeUndefined()
  })
})
