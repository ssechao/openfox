import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
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
      globalConfigPath: join(tmpdir(), `openfox-diagnostics-test-${randomUUID()}.json`),
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

  it('does not expose the calibrated loop blocker outside the demo flag', async () => {
    const res = await fetch(`${base}/api/test/block-loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': VALID_TOKEN },
      body: JSON.stringify({ ms: 10 }),
    })
    expect(res.status).not.toBe(200)
  })
})
