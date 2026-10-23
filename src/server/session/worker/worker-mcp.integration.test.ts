import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('worker MCP IPC', () => {
  let server: ServerHandle
  let base: string
  let root: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-worker-mcp-${randomUUID()}`)
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
  }, 60_000)

  afterAll(async () => {
    await server?.close()
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
      if (Date.now() > deadline) throw new Error('timed out waiting for worker MCP result')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('executes a shared gateway MCP tool from an external worker', async () => {
    await waitFor(async () => {
      const response = await fetch(`${base}/api/mcp/servers`)
      const body = (await response.json()) as { servers: Array<{ name: string; status: string }> }
      return body.servers.some((item) => item.name === 'test-server' && item.status === 'connected') ? true : null
    }, 30_000)

    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-mcp', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const { project } = (await projectResponse.json()) as { project: { id: string } }
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title: 'worker-mcp' }),
    })
    expect(sessionResponse.status).toBe(201)
    const { session } = (await sessionResponse.json()) as { session: { id: string } }

    const messageResponse = await fetch(`${base}/api/sessions/${session.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Call the MCP tool test-server_greet' }),
    })
    expect(messageResponse.status).toBe(200)

    const messages = await waitFor(async () => {
      const response = await fetch(`${base}/api/sessions/${session.id}`)
      const body = (await response.json()) as { session: { isRunning: boolean }; messages: unknown[] }
      const serialized = JSON.stringify(body.messages)
      return !body.session.isRunning && serialized.includes('WorkerCleanupProbe') ? serialized : null
    }, 30_000)

    expect(messages).toContain('test-server_greet')
    expect(messages).not.toMatch(/Unknown tool|tool.*not.*found/i)
  }, 60_000)
})
