import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

describe('worker background processes', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let sessionId: string
  let closed = false

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-worker-background-${randomUUID()}`)
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
      mcpServers: {},
    }
    const { createServerHandle } = await import('../../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-background', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const { project } = (await projectResponse.json()) as { project: { id: string } }
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title: 'worker-background' }),
    })
    expect(sessionResponse.status).toBe(201)
    const body = (await sessionResponse.json()) as { session: { id: string } }
    sessionId = body.session.id
  }, 60_000)

  afterAll(async () => {
    if (!closed) await server?.close()
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
      if (Date.now() > deadline) throw new Error('timed out waiting for worker background process')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function send(content: string): Promise<void> {
    const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(response.status).toBe(200)
    await waitFor(async () => {
      const current = await fetch(`${base}/api/sessions/${sessionId}`)
      const body = (await current.json()) as { session: { isRunning: boolean } }
      return body.session.isRunning ? null : true
    }, 30_000)
  }

  async function getProcesses(): Promise<Array<{ id: string; pid: number | null; status: string }>> {
    const response = await fetch(`${base}/api/sessions/${sessionId}/background-processes`)
    const body = (await response.json()) as {
      processes: Array<{ id: string; pid: number | null; status: string }>
    }
    return body.processes
  }

  async function getLastBackgroundCall(): Promise<
    { result?: { success: boolean; output?: string; error?: string } } | undefined
  > {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    const body = (await response.json()) as {
      messages: Array<{
        toolCalls?: Array<{ name: string; result?: { success: boolean; output?: string; error?: string } }>
      }>
    }
    return body.messages
      .flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.name === 'background_process')
      .at(-1)
  }

  async function startBackground(content: 'BG-IPC-START' | 'BG-IPC-TIMEOUT'): Promise<{
    processId: string
    pid: number
  }> {
    await send(content)
    const call = await getLastBackgroundCall()
    expect(call?.result?.success).toBe(true)
    expect(call?.result?.output).toBeDefined()
    return JSON.parse(call!.result!.output!) as { processId: string; pid: number }
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('keeps a background process listed and readable after its worker exited', async () => {
    const started = await startBackground('BG-IPC-START')
    const processes = await getProcesses()
    expect(processes).toHaveLength(1)
    const background = processes[0]!
    expect(background.id).toBe(started.processId)
    expect(background.status).toBe('running')
    expect(background.pid).toBe(started.pid)
    expect(isAlive(started.pid)).toBe(true)

    const call = await waitFor(async () => {
      await send(`BG-IPC-LOGS ${started.processId}`)
      const latest = await getLastBackgroundCall()
      return latest?.result?.success === true && latest.result.output?.includes('bg-ready') ? latest : null
    }, 10_000)
    expect(call.result?.success).toBe(true)
    expect(call.result?.output).toContain('bg-ready')
  }, 60_000)

  it('stops a background process started by an earlier worker', async () => {
    const existing = (await getProcesses())[0]
    const started =
      existing?.pid !== null && existing?.pid !== undefined
        ? { processId: existing.id, pid: existing.pid }
        : await startBackground('BG-IPC-START')
    await send(`BG-IPC-STOP ${started.processId}`)
    const call = await getLastBackgroundCall()
    expect(call?.result?.success).toBe(true)
    await waitFor(async () => (isAlive(started.pid) ? null : true), 5_000)
    expect(await getProcesses()).toEqual([])
  }, 60_000)

  it('enforces the timeout of a background process after its worker exited', async () => {
    const started = await startBackground('BG-IPC-TIMEOUT')
    await waitFor(async () => (isAlive(started.pid) ? null : true), 10_000)
    expect(await getProcesses()).toEqual([])
  }, 60_000)

  it('kills running background processes when the gateway closes', async () => {
    const started = await startBackground('BG-IPC-START')
    await server.close()
    closed = true
    await waitFor(async () => (isAlive(started.pid) ? null : true), 10_000)
  }, 60_000)
})
