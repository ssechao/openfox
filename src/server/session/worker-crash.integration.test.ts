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
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

interface WorkerRecord {
  sessionId: string
  token: { workerId: string; generation: number }
  pid: number | undefined
}

interface WorkerIntrospection {
  active: WorkerRecord | null
  activeWorkers: WorkerRecord[]
  lastCrash: {
    sessionId: string
    generation: number
    pid: number
    signal: NodeJS.Signals | null
    killedChildren: number[]
    inventory: { capturedAt: number; worker?: { pid: number; startedAt: string; pgid: number } }
    orphanCheck?: { checkedAt: number; clean: boolean; errors: string[] }
  } | null
}

interface SessionView {
  session: { id: string; isRunning: boolean; interruptedAt?: string | null }
  messages: Array<{
    role: string
    content?: string
    toolCalls?: Array<{ result?: { success: boolean; error?: string; metadata?: Record<string, unknown> } }>
  }>
  pendingToolReconciliations: Array<{ toolCallId: string; name: string }>
}

describe('session worker crash', () => {
  let server: ServerHandle
  let base: string
  let workdir: string
  let dbDir: string
  let config: Config

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    workdir = join(tmpdir(), `openfox-worker-crash-${randomUUID()}`)
    dbDir = join(tmpdir(), `openfox-worker-crash-db-${randomUUID()}`)
    await mkdir(workdir, { recursive: true })
    await mkdir(dbDir, { recursive: true })
    config = {
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
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
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

  async function getActiveWorker(sessionId: string): Promise<WorkerRecord | null> {
    const { activeWorkers } = await getWorkerIntrospection()
    return activeWorkers.find((worker) => worker.sessionId === sessionId) ?? null
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

    const effectPath = join(workdir, 'crash-effect.txt')
    await sendMessage(sessionA, `Run the exact command: printf x >> ${JSON.stringify(effectPath)}; sleep 30`)
    const active = await waitFor(() => getActiveWorker(sessionA), 20_000, 'worker to be launched')
    expect(active?.sessionId).toBe(sessionA)
    expect(active?.token.generation).toBe(1)
    expect(active?.pid).toBeGreaterThan(0)
    await waitFor(
      async () => ((await readFile(effectPath, 'utf-8').catch(() => '')) === 'x' ? true : null),
      20_000,
      'tool side effect',
    )

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
    expect(detected.pendingToolReconciliations).toHaveLength(1)
    expect(detected.pendingToolReconciliations[0]?.name).toBe('run_command')
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
    expect(recovered.pendingToolReconciliations).toHaveLength(1)
    expect(
      recovered.messages.some((message) =>
        message.toolCalls?.some(
          (call) => call.result?.success === false && call.result.metadata?.['reconciliationRequired'] === true,
        ),
      ),
    ).toBe(true)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')

    const reconciled = await fetch(`${base}/api/sessions/${sessionA}/reconcile-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallIds: [recovered.pendingToolReconciliations[0]!.toolCallId] }),
    })
    expect(reconciled.status).toBe(200)
    expect((await getSessionView(sessionA)).pendingToolReconciliations).toEqual([])
  }, 120_000)

  it('treats a forced Stop as interrupted and refuses to replay an unresolved shell effect', async () => {
    await waitFor(
      async () => ((await getWorkerIntrospection()).active === null ? true : null),
      40_000,
      'previous worker to settle',
    )
    await setWorkerMode(true)
    const sessionId = await createSession('forced-stop-reconciliation')
    const effectPath = join(workdir, 'forced-stop-effect.txt')
    await sendMessage(sessionId, `Run the exact command: printf x >> ${JSON.stringify(effectPath)}; sleep 30`)
    const active = await waitFor(() => getActiveWorker(sessionId), 20_000, 'worker to start')
    await waitFor(
      async () => ((await readFile(effectPath, 'utf-8').catch(() => '')) === 'x' ? true : null),
      20_000,
      'forced Stop tool side effect',
    )

    process.kill(active.pid!, 'SIGSTOP')
    const stopStartedAt = Date.now()
    const stopped = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
    const stopAcknowledgedAt = Date.now()
    expect(stopped.status).toBe(200)

    const interrupted = await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return view.session.interruptedAt && !view.session.isRunning ? view : null
      },
      10_000,
      'forced Stop interruption',
    )
    expect(interrupted.pendingToolReconciliations).toHaveLength(1)
    expect(interrupted.pendingToolReconciliations[0]?.name).toBe('run_command')
    const report = await waitFor(
      async () => {
        const current = (await getWorkerIntrospection()).lastCrash
        return current?.sessionId === sessionId && current.orphanCheck ? current : null
      },
      10_000,
      'forced Stop inventory proof',
    )
    expect(report.inventory.worker).toMatchObject({
      pid: active.pid,
      startedAt: expect.any(String),
      pgid: expect.any(Number),
    })
    expect(report.inventory.capturedAt).toBeGreaterThanOrEqual(stopStartedAt)
    expect(report.inventory.capturedAt).toBeLessThanOrEqual(stopAcknowledgedAt)
    expect(report.orphanCheck?.checkedAt).toBeGreaterThanOrEqual(report.inventory.capturedAt + 2_000)
    expect(report.orphanCheck?.checkedAt).toBeLessThanOrEqual(report.inventory.capturedAt + 2_500)
    expect(report.orphanCheck).toMatchObject({ clean: true, errors: [] })

    const resumed = await fetch(`${base}/api/sessions/${sessionId}/resume-interruption`, { method: 'POST' })
    expect(resumed.status).toBe(200)
    const recovered = await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return !view.session.interruptedAt && !view.session.isRunning ? view : null
      },
      30_000,
      'forced Stop resume',
    )
    expect(recovered.pendingToolReconciliations).toHaveLength(1)
    expect(
      recovered.messages.some((message) =>
        message.toolCalls?.some(
          (call) => call.result?.success === false && call.result.metadata?.['reconciliationRequired'] === true,
        ),
      ),
    ).toBe(true)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')
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
    const active = await waitFor(() => getActiveWorker(sessionId), 40_000, 'worker to be launched')
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

  it('preserves the reconciliation guard across gateway shutdown and restart', async () => {
    await waitFor(
      async () => ((await getWorkerIntrospection()).active === null ? true : null),
      40_000,
      'previous worker to settle',
    )
    await setWorkerMode(true)
    const sessionId = await createSession('shutdown-reconciliation')
    const effectPath = join(workdir, 'shutdown-effect.txt')
    await sendMessage(sessionId, `Run the exact command: printf x >> ${JSON.stringify(effectPath)}; sleep 30`)
    const active = await waitFor(() => getActiveWorker(sessionId), 20_000, 'worker to start')
    expect(active?.sessionId).toBe(sessionId)
    await waitFor(
      async () => ((await readFile(effectPath, 'utf-8').catch(() => '')) === 'x' ? true : null),
      20_000,
      'shutdown tool side effect',
    )

    await server.close()
    const { closeDatabase } = await import('../db/index.js')
    closeDatabase()
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const interrupted = await getSessionView(sessionId)
    expect(interrupted.session.interruptedAt).toBeTruthy()
    expect(interrupted.pendingToolReconciliations).toHaveLength(1)

    const resumed = await fetch(`${base}/api/sessions/${sessionId}/resume-interruption`, { method: 'POST' })
    expect(resumed.status).toBe(200)
    const recovered = await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return !view.session.isRunning && !view.session.interruptedAt ? view : null
      },
      30_000,
      'shutdown-interrupted session to resume',
    )
    expect(recovered.pendingToolReconciliations).toHaveLength(1)
    expect(
      recovered.messages.some((message) =>
        message.toolCalls?.some(
          (call) => call.result?.success === false && call.result.metadata?.['reconciliationRequired'] === true,
        ),
      ),
    ).toBe(true)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')
  }, 120_000)
})
