import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import type { Config } from '../../shared/types.js'
import type { DiagnosticsData } from '../../shared/diagnostics.js'
import type { ServerHandle } from '../context.js'
import {
  SessionRuntimeRegistry,
  getSessionRuntimeRegistry,
  resetSessionRuntimeRegistry,
  setSessionRuntimeRegistry,
} from './runtime.js'
import { createDiagnosticsCollector } from '../diagnostics/collector.js'

describe('SessionRuntime integration', () => {
  afterEach(() => {
    resetSessionRuntimeRegistry()
  })

  it('shares one runtime per session across registry consumers', () => {
    const registry = new SessionRuntimeRegistry()
    setSessionRuntimeRegistry(registry)

    const a = getSessionRuntimeRegistry().get('sess-1')
    const b = getSessionRuntimeRegistry().get('sess-1')
    expect(a).toBe(b)

    a.acquire('chat')
    expect(b.snapshot().state).toBe('running')
  })

  it('exposes runtimes through the diagnostics collector', () => {
    const registry = new SessionRuntimeRegistry()
    const collector = createDiagnosticsCollector({
      runtimeRegistry: registry,
      intervalMs: 1_000,
      enableLoopSampler: false,
    })

    const idle = registry.get('sess-idle')
    idle.recordCommand('pause')

    const running = registry.get('sess-run')
    running.acquire('workflow')

    const data = collector.getData()
    expect(data.runtimes).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-idle', state: 'idle', lastCommand: 'pause' },
        { sessionId: 'sess-run', state: 'workflow', lastCommand: 'workflow' },
      ]),
    )
  })

  it('reports paused state only when the cooperative pause gate is paused', () => {
    let pauseState: import('../../shared/types.js').PauseState = 'none'
    const registry = new SessionRuntimeRegistry({ getPauseState: () => pauseState })
    const runtime = registry.get('sess-1')
    runtime.acquire('chat')

    expect(runtime.snapshot().state).toBe('running')

    pauseState = 'paused'
    expect(runtime.snapshot().state).toBe('paused')

    pauseState = 'none'
    expect(runtime.snapshot().state).toBe('running')
  })

  it('stays in stopping until the aborted work releases, then allows relaunch', async () => {
    const registry = new SessionRuntimeRegistry()
    const runtime = registry.get('sess-1')
    const handle = runtime.acquire('chat')

    expect(runtime.stop()).toBe(true)
    expect(handle.signal.aborted).toBe(true)
    expect(runtime.snapshot().state).toBe('stopping')
    expect(() => runtime.acquire('chat')).toThrow('Session is stopping')

    const settled = runtime.awaitSettled()
    expect(runtime.release(handle)).toBe(true)
    await settled

    expect(runtime.snapshot().state).toBe('idle')
    const next = runtime.acquire('chat')
    expect(next.generation).toBe(2)
    expect(next.controller).not.toBe(handle.controller)
  })

  it('removes a runtime so a deleted session leaves no ghost entry', () => {
    const registry = new SessionRuntimeRegistry()
    registry.get('gone').acquire('chat')
    expect(registry.list()).toHaveLength(1)

    registry.remove('gone')
    expect(registry.list()).toEqual([])
    expect(registry.peek('gone')).toBeUndefined()
  })
})

describe('SessionRuntime REST / WS routes', () => {
  let server: ServerHandle
  let base: string
  let wsUrl: string
  let workdir: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    workdir = join(tmpdir(), `openfox-runtime-int-${randomUUID()}`)
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
      globalConfigPath: join(tmpdir(), `openfox-runtime-int-${randomUUID()}.json`),
    }
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
    wsUrl = `ws://127.0.0.1:${port}/ws`
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
  }, 15_000)

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
      body: JSON.stringify({ projectId: project.id, title: 'runtime-int' }),
    })
    expect(sessionRes.status).toBe(201)
    const { session } = (await sessionRes.json()) as { session: { id: string } }
    return session.id
  }

  async function diagnostics(): Promise<DiagnosticsData> {
    const res = await fetch(`${base}/api/diagnostics`)
    expect(res.status).toBe(200)
    return (await res.json()) as DiagnosticsData
  }

  async function waitForRuntime(
    sessionId: string,
    predicate: (state: string | undefined) => boolean,
    timeoutMs = 8_000,
  ): Promise<DiagnosticsData['runtimes'][number] | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const data = await diagnostics()
      const runtime = data.runtimes.find((item) => item.sessionId === sessionId)
      if (predicate(runtime?.state)) return runtime
      if (Date.now() > deadline) return runtime
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('queues POST /message during a turn, records lastCommand, and 409s a launch while stopping', async () => {
    const sessionId = await createSession()
    const hold = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'RUNTIME-HOLD-TURN' }),
    })
    expect(hold.status).toBe(200)

    const running = await waitForRuntime(sessionId, (state) => state === 'running')
    expect(running?.lastCommand).toBe('launch')

    const queued = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'queued-follow-up' }),
    })
    expect(queued.status).toBe(200)
    const queuedBody = (await queued.json()) as { queueState?: unknown[] }
    expect(queuedBody.queueState?.length).toBeGreaterThan(0)

    const pause = await fetch(`${base}/api/sessions/${sessionId}/pause`, { method: 'POST' })
    expect(pause.status).toBe(200)
    expect((await diagnostics()).runtimes.find((item) => item.sessionId === sessionId)?.lastCommand).toBe('pause')

    const stop = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    const stopping = await waitForRuntime(sessionId, (state) => state === 'stopping' || state === 'idle')
    expect(['stopping', 'idle']).toContain(stopping?.state)
    expect(stopping?.lastCommand).toBe('stop')

    if (stopping?.state === 'stopping') {
      const denied = await fetch(`${base}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'too-soon' }),
      })
      expect(denied.status).toBe(409)
    }

    await waitForRuntime(sessionId, (state) => state === 'idle', 10_000)
    const del = await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await diagnostics()).runtimes.find((item) => item.sessionId === sessionId)).toBeUndefined()
  }, 30_000)

  it('cancels a pending ask on Stop and records answer lastCommand', async () => {
    const sessionId = await createSession()
    const asked = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ask the user a question' }),
    })
    expect(asked.status).toBe(200)

    const deadline = Date.now() + 8_000
    let callId: string | undefined
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/api/sessions/${sessionId}`)
      const body = (await res.json()) as { pendingQuestions?: Array<{ callId: string }> }
      callId = body.pendingQuestions?.[0]?.callId
      if (callId) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(callId).toBeTruthy()

    const stop = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    const after = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as {
      pendingQuestions?: unknown[]
    }
    expect(after.pendingQuestions ?? []).toEqual([])
  }, 20_000)

  it('acquires compaction and workflow through the shared runtime', async () => {
    const sessionId = await createSession()
    await fetch(`${base}/api/sessions/${sessionId}/criteria`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ criteria: [{ id: 'c1', description: 'Do the work', status: 'pending' }] }),
    })

    const ws = new WebSocket(wsUrl)
    await once(ws, 'open')
    const messages: Array<{ type?: string; id?: string; payload?: unknown }> = []
    ws.on('message', (raw) => {
      messages.push(JSON.parse(String(raw)) as { type?: string; id?: string; payload?: unknown })
    })
    const waitFor = async (predicate: (msg: (typeof messages)[number]) => boolean, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = messages.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error('timed out waiting for ws message')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    ws.send(JSON.stringify({ id: 'load', type: 'session.load', payload: { sessionId } }))
    await waitFor((msg) => msg.id === 'load' || msg.type === 'session.state')

    ws.send(JSON.stringify({ id: 'compact', type: 'context.compact', payload: { sessionId } }))
    const compactAck = await waitFor((msg) => msg.id === 'compact')
    expect(compactAck.type).toBe('ack')
    const compacting = await waitForRuntime(
      sessionId,
      (state) => state === 'compacting' || state === 'idle' || state === 'running',
    )
    expect(['compacting', 'idle', 'running']).toContain(compacting?.state)
    if (compacting?.lastCommand === 'compact' || compacting?.state === 'compacting') {
      expect(['compact', 'stop', 'launch']).toContain(compacting?.lastCommand)
    }
    await waitForRuntime(sessionId, (state) => state === 'idle', 10_000)

    ws.send(JSON.stringify({ id: 'launch', type: 'runner.launch', payload: { sessionId } }))
    const launchAck = await waitFor((msg) => msg.id === 'launch')
    expect(['ack', 'error']).toContain(launchAck.type)
    if (launchAck.type === 'ack') {
      const workflow = await waitForRuntime(sessionId, (state) => state === 'workflow' || state === 'running')
      expect(['workflow', 'running']).toContain(workflow?.state)
      ws.send(JSON.stringify({ id: 'exit', type: 'workflow.exit', payload: { sessionId } }))
      await waitFor((msg) => msg.id === 'exit')
    }

    ws.close()
    await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' })
  }, 30_000)
})
