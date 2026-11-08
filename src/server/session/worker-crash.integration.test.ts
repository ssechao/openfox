/**
 * Étape 6a, critère 2 — détection du plantage et reprise.
 *
 * Runs ONLY on .122 (scripts/test-remote.sh / pre-commit hook): kill -9 and
 * process management are forbidden on the Mac.
 *
 * A session runs in its worker (OPENFOX_MOCK_LLM); kill -9 on the worker
 * process must be detected by the gateway via the exit handler (no timeout),
 * the session must be marked interrupted, each open tool call closed with one
 * synthetic outcomeUnknown result, and the turn continued without replaying
 * the tool or asking the user. Other sessions must keep working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
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

const betterSqlite3 = createRequire(import.meta.url).resolve('better-sqlite3')

async function holdDatabaseLock(path: string, holdMs: number): Promise<{ exited: Promise<number | null> }> {
  const source = [
    `const Database = require(${JSON.stringify(betterSqlite3)})`,
    `const db = new Database(${JSON.stringify(path)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `process.stdout.write('locked\\n')`,
    `setTimeout(() => { db.exec('COMMIT'); db.close() }, ${holdMs})`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  await new Promise((resolve) => child.stdout.once('data', resolve))
  return { exited }
}

interface SessionView {
  session: { id: string; isRunning: boolean; interruptedAt?: string | null }
  messages: Array<{
    role: string
    content?: string
    toolCalls?: Array<{
      result?: {
        success: boolean
        outcomeUnknown?: boolean
        error?: string
        metadata?: Record<string, unknown>
      }
    }>
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

  function hasUnknownOutcome(view: SessionView): boolean {
    return view.messages.some((message) => message.toolCalls?.some((call) => call.result?.outcomeUnknown === true))
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

  it('detects kill -9, records one unknown outcome, and continues without asking', async () => {
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

    const settled = await waitFor(
      async () => {
        const view = await getSessionView(sessionA)
        return hasUnknownOutcome(view) && view.pendingToolReconciliations.length === 0 ? view : null
      },
      10_000,
      'synthetic unknown tool result',
    )
    expect(Date.now() - killedAt).toBeLessThan(10_000)
    expect(settled.pendingToolReconciliations).toEqual([])
    expect(await readFile(effectPath, 'utf-8')).toBe('x')

    const introspection = await waitFor(async () => (await getWorkerIntrospection()).lastCrash, 5_000, 'crash report')
    expect(introspection?.sessionId).toBe(sessionA)
    expect(introspection?.signal).toBe('SIGKILL')

    const refused = await fetch(`${base}/api/sessions/${sessionB}/resume-interruption`, { method: 'POST' })
    expect(refused.status).toBe(409)

    const recovered = await waitFor(
      async () => {
        const view = await getSessionView(sessionA)
        return !view.session.interruptedAt && !view.session.isRunning && hasUnknownOutcome(view) ? view : null
      },
      30_000,
      'automatic continuation',
    )
    expect(recovered.pendingToolReconciliations).toEqual([])
    expect(
      recovered.messages.flatMap((message) => message.toolCalls ?? []).filter((call) => call.result?.outcomeUnknown),
    ).toHaveLength(1)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')

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
  }, 120_000)

  it('releases the slot before a lock longer than the recovery deadline and persists interruption afterward', async () => {
    await waitFor(
      async () => ((await getWorkerIntrospection()).active === null ? true : null),
      40_000,
      'previous worker to settle',
    )
    await setWorkerMode(true)
    const sessionId = await createSession('persistent-lock-crash')
    const effectPath = join(workdir, 'persistent-lock-effect.txt')
    await sendMessage(sessionId, `Run the exact command: printf x >> ${JSON.stringify(effectPath)}; sleep 30`)
    const active = await waitFor(() => getActiveWorker(sessionId), 20_000, 'locked crash worker')
    await waitFor(
      async () => ((await readFile(effectPath, 'utf-8').catch(() => '')) === 'x' ? true : null),
      20_000,
      'locked crash side effect',
    )

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const queuedResponses: Array<{ type?: string; payload?: { admission?: string; code?: string } }> = []
    const queuedAck = new Promise<{ type?: string; payload?: { admission?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for queued compact admission')), 5_000)
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as {
          id?: string
          type?: string
          payload?: { admission?: string; code?: string }
        }
        if (message.id !== 'queued-before-crash') return
        queuedResponses.push(message)
        if (message.type === 'ack') {
          clearTimeout(timer)
          resolve(message)
        }
      })
    })
    ws.send(
      JSON.stringify({
        id: 'queued-before-crash',
        type: 'context.compact',
        payload: { sessionId },
      }),
    )
    await expect(queuedAck).resolves.toMatchObject({ type: 'ack', payload: { admission: 'waiting' } })

    const { exited } = await holdDatabaseLock(config.database.path, 12_500)
    let lockReleased = false
    void exited.then(() => {
      lockReleased = true
    })
    process.kill(active.pid!, 'SIGKILL')

    await waitFor(
      async () => ((await getWorkerIntrospection()).activeWorkers.length === 0 ? true : null),
      5_000,
      'worker slot release while database remains locked',
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(lockReleased).toBe(false)
    expect(queuedResponses).toHaveLength(1)
    expect(queuedResponses[0]).toMatchObject({ type: 'ack', payload: { admission: 'waiting' } })
    expect((await getWorkerIntrospection()).activeWorkers).toEqual([])
    const crash = await waitFor(async () => (await getWorkerIntrospection()).lastCrash, 5_000, 'early crash report')
    expect(crash.sessionId).toBe(sessionId)
    expect((await getSessionView(sessionId)).session.interruptedAt ?? null).toBeNull()

    expect(await exited).toBe(0)
    await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return hasUnknownOutcome(view) &&
          view.pendingToolReconciliations.length === 0 &&
          !view.session.interruptedAt &&
          !view.session.isRunning
          ? true
          : null
      },
      30_000,
      'automatic continuation after deferred interruption',
    )
    expect(queuedResponses).toHaveLength(1)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')
    ws.close()
  }, 60_000)

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

    const recovered = await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return hasUnknownOutcome(view) &&
          view.pendingToolReconciliations.length === 0 &&
          !view.session.interruptedAt &&
          !view.session.isRunning
          ? view
          : null
      },
      30_000,
      'forced Stop stays stopped',
    )
    expect(
      recovered.messages.some((message) => (message.content ?? '').includes('Continue your previous response')),
    ).toBe(false)
    expect(
      recovered.messages.flatMap((message) => message.toolCalls ?? []).filter((call) => call.result?.outcomeUnknown),
    ).toHaveLength(1)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')
  }, 120_000)

  it('syncs interruptedAt over the real WebSocket and clears it when continuation is queued', async () => {
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

    const crashSync = await waitFor(
      async () => interruptedMessages.find((m) => m.interruptedAt !== null) ?? null,
      10_000,
      'session.interrupted over WS',
    )
    expect(crashSync.interruptedAt).toBeTruthy()

    const clearSync = await waitFor(
      async () => interruptedMessages.find((m) => m.interruptedAt === null) ?? null,
      5_000,
      'session.interrupted (null) over WS',
    )
    expect(clearSync.interruptedAt).toBeNull()

    ws.close()
  }, 120_000)

  it('settles an open tool call across gateway shutdown without replaying it', async () => {
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

    const recovered = await waitFor(
      async () => {
        const view = await getSessionView(sessionId)
        return !view.session.isRunning && !view.session.interruptedAt && hasUnknownOutcome(view) ? view : null
      },
      30_000,
      'shutdown-interrupted session to resume',
    )
    const refused = await fetch(`${base}/api/sessions/${sessionId}/resume-interruption`, { method: 'POST' })
    expect(refused.status).toBe(409)
    expect(recovered.pendingToolReconciliations).toEqual([])
    expect(
      recovered.messages.flatMap((message) => message.toolCalls ?? []).filter((call) => call.result?.outcomeUnknown),
    ).toHaveLength(1)
    expect(await readFile(effectPath, 'utf-8')).toBe('x')
  }, 120_000)
})
