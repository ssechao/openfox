import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

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

interface WorkerRecord {
  sessionId: string
  pid?: number
}

interface SessionView {
  session: { isRunning: boolean; interruptedAt?: string | null }
}

let server: ServerHandle
let base: string
let root: string
let projectId: string
let dbPath: string

beforeAll(async () => {
  process.env['OPENFOX_MOCK_LLM'] = 'true'
  process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
  process.env['OPENFOX_SESSION_WORKER'] = 'true'
  process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES'] = '1'
  root = join(tmpdir(), `openfox-workflow-resume-lock-${randomUUID()}`)
  const projectDir = join(root, 'project')
  const workflowDir = join(projectDir, '.openfox', 'workflows')
  await mkdir(workflowDir, { recursive: true })
  await writeFile(
    join(workflowDir, 'long-effect.workflow.json'),
    JSON.stringify({
      metadata: {
        id: 'long-effect',
        name: 'Long effect',
        description: 'Keeps a real worker occupied',
        version: '1.0.0',
      },
      entryStep: 'effect',
      settings: { maxIterations: 2 },
      steps: [
        {
          id: 'effect',
          name: 'Effect',
          type: 'shell',
          phase: 'build',
          command: `printf x >> ${JSON.stringify(join(root, 'long-started'))}; sleep 30`,
          transitions: [{ when: { type: 'always' }, goto: '$done' }],
        },
      ],
    }),
  )
  dbPath = join(root, 'sessions.db')
  const config: Config = {
    mode: 'test',
    llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
    context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
    agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
    server: { port: 0, host: '127.0.0.1' },
    database: { path: dbPath },
    logging: { level: 'error' },
    workdir: root,
    globalConfigPath: join(root, 'config.json'),
  }
  const { createServerHandle } = await import('../../index.js')
  server = await createServerHandle(config)
  const { port } = await server.start(0)
  base = `http://127.0.0.1:${port}`

  const project = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'workflow-resume-lock', workdir: projectDir }),
  })
  expect(project.status).toBe(201)
  projectId = ((await project.json()) as { project: { id: string } }).project.id
}, 60_000)

afterAll(async () => {
  await server?.close()
  delete process.env['OPENFOX_MOCK_LLM']
  delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
  delete process.env['OPENFOX_SESSION_WORKER']
  delete process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES']
  await rm(root, { recursive: true, force: true })
}, 30_000)

async function createSession(title: string): Promise<string> {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, title }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { session: { id: string } }).session.id
}

async function getSession(sessionId: string): Promise<SessionView> {
  const response = await fetch(`${base}/api/sessions/${sessionId}`)
  expect(response.status).toBe(200)
  return (await response.json()) as SessionView
}

async function workers(): Promise<WorkerRecord[]> {
  const response = await fetch(`${base}/api/test/worker`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { activeWorkers: WorkerRecord[] }).activeWorkers
}

async function waitFor<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function connectWebSocket(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function waitForWs(
  ws: WebSocket,
  id: string,
): Promise<{ id?: string; type?: string; payload?: { admission?: string; code?: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${id}`)), 10_000)
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as {
        id?: string
        type?: string
        payload?: { admission?: string; code?: string }
      }
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}

async function launchWorkflow(ws: WebSocket, sessionId: string, id: string): Promise<void> {
  const response = waitForWs(ws, id)
  ws.send(
    JSON.stringify({
      id,
      type: 'runner.launch',
      payload: { sessionId, workflowId: 'long-effect', scope: 'project' },
    }),
  )
  await expect(response).resolves.toMatchObject({ type: 'ack' })
}

it('restores a deferred failed resume before releasing its admitted successor', async () => {
  const interruptedId = await createSession('interrupted')
  const blockerId = await createSession('blocker')
  const ws = await connectWebSocket()
  const successorResponses: Array<{ type?: string; payload?: { admission?: string; code?: string } }> = []

  try {
    await launchWorkflow(ws, interruptedId, 'launch-interrupted')
    const interruptedWorker = await waitFor(
      async () => (await workers()).find((worker) => worker.sessionId === interruptedId) ?? null,
      'interrupted workflow worker',
    )
    await waitFor(
      async () => ((await readFile(join(root, 'long-started'), 'utf-8').catch(() => '')).length >= 1 ? true : null),
      'interrupted workflow effect',
    )
    process.kill(interruptedWorker.pid!, 'SIGKILL')
    await waitFor(async () => ((await getSession(interruptedId)).session.interruptedAt ? true : null), 'interruption')

    await launchWorkflow(ws, blockerId, 'launch-blocker')
    const blockerWorker = await waitFor(
      async () => (await workers()).find((worker) => worker.sessionId === blockerId) ?? null,
      'blocker worker',
    )
    await waitFor(
      async () => ((await readFile(join(root, 'long-started'), 'utf-8').catch(() => '')).length >= 2 ? true : null),
      'blocker workflow effect',
    )

    const waitingResume = await fetch(`${base}/api/sessions/${interruptedId}/resume-interruption`, {
      method: 'POST',
    })
    expect(waitingResume.status).toBe(200)
    await expect(waitingResume.json()).resolves.toMatchObject({ admission: 'waiting' })
    expect((await getSession(interruptedId)).session.interruptedAt ?? null).toBeNull()

    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        id?: string
        type?: string
        payload?: { admission?: string; code?: string }
      }
      if (message.id === 'admitted-successor') successorResponses.push(message)
    })
    const successorAck = waitForWs(ws, 'admitted-successor')
    ws.send(
      JSON.stringify({
        id: 'admitted-successor',
        type: 'context.compact',
        payload: { sessionId: interruptedId },
      }),
    )
    await expect(successorAck).resolves.toMatchObject({ type: 'ack', payload: { admission: 'waiting' } })

    const { exited: lockExit } = await holdDatabaseLock(dbPath, 22_500)
    process.kill(blockerWorker.pid!, 'SIGKILL')
    await waitFor(
      async () => {
        const active = await workers()
        return !active.some((worker) => worker.sessionId === blockerId || worker.sessionId === interruptedId)
          ? true
          : null
      },
      'failed deferred resume',
      8_000,
    )
    expect((await getSession(interruptedId)).session.interruptedAt ?? null).toBeNull()
    expect(successorResponses).toHaveLength(1)

    expect(await lockExit).toBe(0)
    await waitFor(
      async () => ((await getSession(interruptedId)).session.interruptedAt ? true : null),
      'restored interruption after retry',
      10_000,
    )
    expect((await workers()).some((worker) => worker.sessionId === interruptedId)).toBe(false)
    expect(successorResponses).toHaveLength(1)

    const retry = await fetch(`${base}/api/sessions/${interruptedId}/resume-interruption`, { method: 'POST' })
    expect(retry.status).toBe(200)
  } finally {
    ws.close()
  }
}, 60_000)
