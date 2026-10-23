/**
 * Étape 6a, critère 2 — détection du plantage et reprise.
 *
 * Runs ONLY on .122 (scripts/test-remote.sh / pre-commit hook): kill -9 and
 * process management are forbidden on the Mac.
 *
 * A session runs in its worker (OPENFOX_MOCK_LLM); kill -9 on the worker
 * process must be detected by the gateway via the exit handler (no timeout),
 * the session must be marked interrupted (persisted, API-visible) with an
 * explicit resume proposal, nothing may be replayed automatically, and other
 * sessions must keep working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

interface WorkerIntrospection {
  active: { sessionId: string; token: { workerId: string; generation: number }; pid: number | undefined } | null
  lastCrash: {
    sessionId: string
    generation: number
    pid: number
    signal: NodeJS.Signals | null
    killedChildren: number[]
  } | null
}

interface SessionView {
  session: { id: string; isRunning: boolean; interruptedAt?: string | null }
  messages: Array<{ role: string; content?: string }>
}

describe('session worker crash', () => {
  let server: ServerHandle
  let base: string
  let workdir: string
  let dbDir: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    workdir = join(tmpdir(), `openfox-worker-crash-${randomUUID()}`)
    dbDir = join(tmpdir(), `openfox-worker-crash-db-${randomUUID()}`)
    await mkdir(workdir, { recursive: true })
    await mkdir(dbDir, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(dbDir, 'sessions.db') },
      logging: { level: 'error' },
      workdir,
      globalConfigPath: join(tmpdir(), `openfox-worker-crash-${randomUUID()}.json`),
    }
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
    await rm(dbDir, { recursive: true, force: true }).catch(() => {})
  }, 20_000)

  async function createSession(title: string): Promise<string> {
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
      body: JSON.stringify({ projectId: project.id, title }),
    })
    expect(sessionRes.status).toBe(201)
    const { session } = (await sessionRes.json()) as { session: { id: string } }
    return session.id
  }

  async function setWorkerMode(enabled: boolean): Promise<void> {
    const res = await fetch(`${base}/api/settings/agent.sessionWorkerMode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: enabled ? 'true' : 'false' }),
    })
    expect(res.status).toBe(200)
  }

  async function sendMessage(sessionId: string, content: string): Promise<void> {
    const res = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(200)
  }

  async function getSessionView(sessionId: string): Promise<SessionView> {
    const res = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    return (await res.json()) as SessionView
  }

  async function getWorkerIntrospection(): Promise<WorkerIntrospection> {
    const res = await fetch(`${base}/api/test/worker`)
    expect(res.status).toBe(200)
    return (await res.json()) as WorkerIntrospection
  }

  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('detects kill -9, marks the session interrupted, and resumes only explicitly', async () => {
    await setWorkerMode(true)
    const sessionA = await createSession('crash-victim')
    const sessionB = await createSession('witness')

    // The turn runs in a worker, busy inside a long shell command.
    await sendMessage(sessionA, 'Run the exact command: sleep 30')
    const active = await waitFor(async () => (await getWorkerIntrospection()).active, 20_000, 'worker to be launched')
    expect(active?.sessionId).toBe(sessionA)
    expect(active?.token.generation).toBe(1)
    expect(active?.pid).toBeGreaterThan(0)

    // Crash the worker. Detection must come from the exit handler, fast.
    const killedAt = Date.now()
    process.kill(active!.pid!, 'SIGKILL')

    const interrupted = await waitFor(
      async () => {
        const view = await getSessionView(sessionA)
        return view.session.interruptedAt && !view.session.isRunning ? view : null
      },
      10_000,
      'session to be marked interrupted',
    )
    expect(Date.now() - killedAt).toBeLessThan(10_000)
    const detected = interrupted!

    // « interrompue — reprendre »: persisted marker + system resume proposal.
    expect(detected.session.interruptedAt).toBeTruthy()
    expect(
      detected.messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && /interromp|interrupted/i.test(m.content),
      ),
    ).toBe(true)

    // Crash report available for the cleanup proof (criterion 3 reads it too).
    const introspection = await waitFor(async () => (await getWorkerIntrospection()).lastCrash, 5_000, 'crash report')
    expect(introspection?.sessionId).toBe(sessionA)
    expect(introspection?.signal).toBe('SIGKILL')

    // No blind replay: the session must not restart by itself.
    await new Promise((resolve) => setTimeout(resolve, 700))
    const stillDown = await getSessionView(sessionA)
    expect(stillDown.session.isRunning).toBe(false)
    expect(stillDown.session.interruptedAt).toBeTruthy()
    expect(stillDown.messages.length).toBe(detected.messages.length)

    // The resume gate refuses sessions that were never interrupted.
    const refused = await fetch(`${base}/api/sessions/${sessionB}/resume-interruption`, { method: 'POST' })
    expect(refused.status).toBe(409)

    // The gateway and other sessions are unaffected (witness, in-process).
    await setWorkerMode(false)
    await sendMessage(sessionB, 'Hello')
    const witnessDone = await waitFor(
      async () => {
        const view = await getSessionView(sessionB)
        return !view.session.isRunning && view.messages.some((m) => m.role === 'assistant') ? view : null
      },
      20_000,
      'witness session to answer',
    )
    expect(witnessDone.messages.some((m) => m.role === 'assistant')).toBe(true)

    // Explicit resume: the continuation turn runs (in a fresh worker), the
    // interrupted marker clears, and the session completes.
    await setWorkerMode(true)
    const resumed = await fetch(`${base}/api/sessions/${sessionA}/resume-interruption`, { method: 'POST' })
    expect(resumed.status).toBe(200)

    const recovered = await waitFor(
      async () => {
        const view = await getSessionView(sessionA)
        return !view.session.interruptedAt &&
          !view.session.isRunning &&
          view.messages.some((m) => m.role === 'assistant')
          ? view
          : null
      },
      30_000,
      'resumed session to complete',
    )
    expect(recovered.session.interruptedAt).toBeNull()
    expect(recovered.messages.some((m) => m.role === 'assistant')).toBe(true)
  }, 120_000)

  it('syncs interruptedAt over the real WebSocket on crash and clears it on resume', async () => {
    await setWorkerMode(true)
    await waitFor(
      async () => ((await getWorkerIntrospection()).active === null ? true : null),
      40_000,
      'previous worker to settle',
    )
    const sessionId = await createSession('ws-interrupt')

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const interruptedMessages: Array<{ interruptedAt: string | null }> = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as {
        type?: string
        sessionId?: string
        payload?: { interruptedAt?: string | null }
      }
      if (msg.type === 'session.interrupted' && msg.sessionId === sessionId) {
        interruptedMessages.push({ interruptedAt: msg.payload?.interruptedAt ?? null })
      }
    })
    ws.send(JSON.stringify({ id: 'load', type: 'session.load', payload: { sessionId } }))
    // The ack proves the server set this client's active session, so the
    // crash broadcast below is routed to it.
    const loadAcked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for session.load ack')), 5_000)
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(String(raw)) as { id?: string; type?: string }
        if (msg.id === 'load' && msg.type === 'ack') {
          clearTimeout(timer)
          ws.off('message', onMessage)
          resolve()
        }
      }
      ws.on('message', onMessage)
    })

    await sendMessage(sessionId, 'Run the exact command: sleep 30')
    await loadAcked
    const active = await waitFor(async () => (await getWorkerIntrospection()).active, 40_000, 'worker to be launched')
    expect(active?.sessionId).toBe(sessionId)
    process.kill(active!.pid!, 'SIGKILL')

    const crashed = await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return view.session.interruptedAt && !view.session.isRunning ? view : null
      },
      10_000,
      'session to be marked interrupted',
    )
    const interruptedAt = crashed!.session.interruptedAt!

    const crashSync = await waitFor(
      async () => interruptedMessages.find((m) => m.interruptedAt !== null) ?? null,
      5_000,
      'session.interrupted over WS',
    )
    expect(crashSync.interruptedAt).toBe(interruptedAt)

    const resumed = await fetch(`${base}/api/sessions/${sessionId}/resume-interruption`, { method: 'POST' })
    expect(resumed.status).toBe(200)

    const clearSync = await waitFor(
      async () => interruptedMessages.find((m) => m.interruptedAt === null) ?? null,
      5_000,
      'session.interrupted (null) over WS',
    )
    expect(clearSync.interruptedAt).toBeNull()

    ws.close()
  }, 120_000)
})
