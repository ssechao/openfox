import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'
import { getSessionRuntimeRegistry } from './runtime.js'

describe('manual compaction REST API', () => {
  let server: ServerHandle
  let base: string
  let workdir: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    workdir = join(tmpdir(), `openfox-compaction-api-${randomUUID()}`)
    await mkdir(workdir, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: ':memory:' },
      logging: { level: 'error' },
      workdir,
      globalConfigPath: join(tmpdir(), `openfox-compaction-api-${randomUUID()}.json`),
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

  async function createSession(): Promise<string> {
    const projectDir = join(workdir, randomUUID())
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `p-${randomUUID().slice(0, 8)}`, workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const { project } = (await projectResponse.json()) as { project: { id: string } }
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title: 'compaction-api' }),
    })
    expect(sessionResponse.status).toBe(201)
    const { session } = (await sessionResponse.json()) as { session: { id: string } }
    return session.id
  }

  it.fails(
    'POST /compact succeeds on an idle session',
    async () => {
      const sessionId = await createSession()
      try {
        const response = await fetch(`${base}/api/sessions/${sessionId}/compact`, { method: 'POST' })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ sessionId, status: 'compacted' })
      } finally {
        await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' })
      }
    },
    30_000,
  )

  it.fails(
    'POST /compact refuses another session during its turn',
    async () => {
      const sessionId = await createSession()
      const handle = getSessionRuntimeRegistry().get(sessionId).acquire('chat')
      server.ctx.sessionManager.setRunning(sessionId, true)
      try {
        const response = await fetch(`${base}/api/sessions/${sessionId}/compact`, { method: 'POST' })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'session_busy' })
      } finally {
        server.ctx.sessionManager.setRunning(sessionId, false)
        getSessionRuntimeRegistry().get(sessionId).release(handle)
        await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' })
      }
    },
    30_000,
  )
})
