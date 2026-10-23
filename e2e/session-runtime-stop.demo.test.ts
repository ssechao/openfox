/**
 * Étape 5 demo C3: Stop in three phases against a real process tree.
 *
 * Isolated instance (health-server-child, HOME/XDG/OPENFOX_DB_PATH under tmpdir).
 * Official timings: Docker .122, monotonic clock, several trials, max reported.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiagnosticsData } from '../src/shared/diagnostics.js'
import { freePort, isolatedEnv, killProcessTree, openFiles, productionFiles, track } from './utils/isolated-env.js'
import { createProject, createSession, sendMessage, stopSessionChat } from './utils/rest-client.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10800
const ACK_BUDGET_MS = 100
const TREE_GONE_BUDGET_MS = 1_000
const TRIALS = 3

const TREE_SCRIPT = [
  '#!/usr/bin/env bash',
  'set -e',
  "node -e '" +
    'const {spawn}=require("child_process");' +
    'const fs=require("fs");' +
    'process.title="of-stop-demo-child";' +
    'process.on("SIGTERM",()=>{});' +
    'const g=spawn(process.execPath,["-e","process.title=\\"of-stop-demo-grandchild\\";process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});' +
    'fs.writeFileSync("pids",[process.ppid,process.pid,g.pid].join(" "));' +
    'setInterval(()=>{},1000);' +
    "' &",
  'wait',
  '',
].join('\n')

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

async function startInstance(): Promise<Instance> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-runtime-stop-')))
  await mkdir(join(root, 'home'), { recursive: true })
  const dbPath = join(root, 'sessions.db')
  const port = await freePort(MIN_PORT)
  const logs: string[] = []
  const child = track(
    fork(join(REPO_ROOT, 'e2e/utils/health-server-child.ts'), [], {
      cwd: REPO_ROOT,
      env: isolatedEnv(root, {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_GLOBAL_CONFIG_PATH: join(root, 'config.json'),
        OPENFOX_HOST: '127.0.0.1',
        OPENFOX_PORT: String(port),
        OPENFOX_LLM_URL: 'http://127.0.0.1:9/v1',
        OPENFOX_MOCK_LLM: 'true',
      }),
      execArgv: ['--import', 'tsx/esm'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    }),
    'server',
    logs,
  )
  const listening = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Server did not start:\n${logs.join('')}`)), 120_000)
    child.on('message', (message) => {
      const value = (message as { port?: number } | null)?.port
      if (typeof value === 'number') {
        clearTimeout(timer)
        done(value)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`Server exited (${code}) before listening:\n${logs.join('')}`))
    })
  })
  return { url: `http://127.0.0.1:${listening}`, port: listening, root, dbPath, child, logs }
}

async function stopInstance(instance: Instance): Promise<void> {
  if (instance.child.exitCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        killProcessTree(instance.child)
        done()
      }, 15_000)
      instance.child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      try {
        instance.child.send('close')
      } catch {
        killProcessTree(instance.child)
      }
    })
  }
  await rm(instance.root, { recursive: true, force: true })
}

async function diagnostics(base: string): Promise<DiagnosticsData> {
  const res = await fetch(`${base}/api/diagnostics`)
  if (!res.ok) throw new Error(`GET diagnostics failed: ${res.status}`)
  return (await res.json()) as DiagnosticsData
}

async function waitForRunning(base: string, sessionId: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${base}/api/sessions/${sessionId}`)
    if (!res.ok) throw new Error(`GET session failed: ${res.status}`)
    const { session } = (await res.json()) as { session: { isRunning: boolean } }
    if (session.isRunning) return
    if (Date.now() > deadline) throw new Error('Session did not start running in time')
    await sleep(20)
  }
}

async function postMessage(base: string, sessionId: string, content: string): Promise<Response> {
  return fetch(`${base}/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

async function waitForIdle(base: string, sessionId: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const data = await diagnostics(base)
    const runtime = data.runtimes.find((item) => item.sessionId === sessionId)
    if (!runtime || runtime.state === 'idle') return
    if (Date.now() > deadline) throw new Error(`Session did not become idle (state=${runtime.state})`)
    await sleep(20)
  }
}

async function readTreePids(pidsPath: string): Promise<{ parent: number; child: number; grandchild: number }> {
  const deadline = Date.now() + 8_000
  for (;;) {
    try {
      const text = await readFile(pidsPath, 'utf-8')
      const pids = text
        .trim()
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((n) => !Number.isNaN(n) && n > 0)
      if (pids.length === 3 && pids.every(isAlive)) {
        return { parent: pids[0]!, child: pids[1]!, grandchild: pids[2]! }
      }
    } catch {
      // File not written yet.
    }
    if (Date.now() > deadline) throw new Error('Tree PID file did not appear in time')
    await sleep(20)
  }
}

async function waitForTreeGone(
  pids: number[],
  started: number,
  budgetMs: number,
): Promise<{ goneMs: number; survivors: number[] }> {
  const deadline = started + budgetMs
  for (;;) {
    const survivors = pids.filter(isAlive)
    const goneMs = performance.now() - started
    if (survivors.length === 0) return { goneMs, survivors: [] }
    if (performance.now() > deadline) return { goneMs, survivors }
    await sleep(20)
  }
}

describe('session runtime stop demo', () => {
  let instance: Instance
  let sessionId: string
  let projectDir: string

  beforeAll(async () => {
    instance = await startInstance()
    if (instance.child.pid) {
      const leaked = productionFiles(await openFiles(instance.child.pid))
      expect(leaked).toEqual([])
    }
    projectDir = join(instance.root, 'project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'tree.sh'), TREE_SCRIPT, { mode: 0o755 })
    const project = await createProject(instance.url, { name: 'runtime-stop-demo', workdir: projectDir })
    const session = await createSession(instance.url, { projectId: project.id, title: 'Stop demo' })
    sessionId = session.id
  }, 180_000)

  afterAll(async () => {
    if (instance) await stopInstance(instance)
  }, 30_000)

  it('stops a SIGTERM-ignoring tree in three phases without killing an independent process', async () => {
    await sendMessage(instance.url, sessionId, 'RUNTIME-STOP-DEMO-BG')
    await waitForRunning(instance.url, sessionId)
    const bgDeadline = Date.now() + 8_000
    let survivorPid: number | null = null
    while (Date.now() < bgDeadline) {
      const res = await fetch(`${instance.url}/api/sessions/${sessionId}/background-processes`)
      const body = (await res.json()) as { processes?: Array<{ pid?: number | null; status?: string }> }
      const running = body.processes?.find((proc) => proc.status === 'running' && proc.pid)
      if (running?.pid) {
        survivorPid = running.pid
        break
      }
      await sleep(40)
    }
    expect(survivorPid).toBeTruthy()
    expect(isAlive(survivorPid!)).toBe(true)
    await waitForIdle(instance.url, sessionId)

    const ackSamples: number[] = []
    const treeSamples: number[] = []
    let lastPids = { parent: 0, child: 0, grandchild: 0 }
    let sawStopping = false
    let sawDeniedLaunch = false

    for (let trial = 0; trial < TRIALS; trial++) {
      await writeFile(join(projectDir, 'pids'), '')
      await sendMessage(instance.url, sessionId, 'RUNTIME-STOP-DEMO-TREE')
      await waitForRunning(instance.url, sessionId)
      const tree = await readTreePids(join(projectDir, 'pids'))
      lastPids = tree
      expect(tree.parent).toBeGreaterThan(0)
      expect(tree.child).toBeGreaterThan(0)
      expect(tree.grandchild).toBeGreaterThan(0)
      expect(tree.parent).not.toBe(tree.child)
      expect(tree.child).not.toBe(tree.grandchild)

      const started = performance.now()
      const stopResult = await stopSessionChat(instance.url, sessionId)
      const ackMs = performance.now() - started
      expect(stopResult.success).toBe(true)
      ackSamples.push(ackMs)

      const denied = await postMessage(instance.url, sessionId, 'too-soon')
      if (denied.status === 409) sawDeniedLaunch = true

      const sessionAfter = (await (await fetch(`${instance.url}/api/sessions/${sessionId}`)).json()) as {
        session: { isRunning: boolean }
      }
      if (sessionAfter.session.isRunning) {
        await stopSessionChat(instance.url, sessionId)
      } else {
        expect(sessionAfter.session.isRunning).toBe(false)
      }

      const settleDeadline = Date.now() + 5_000
      while (Date.now() < settleDeadline) {
        const data = await diagnostics(instance.url)
        const runtime = data.runtimes.find((item) => item.sessionId === sessionId)
        const state = runtime?.state
        if (state === 'running' && denied.status === 200) {
          await stopSessionChat(instance.url, sessionId)
        } else {
          expect(state).not.toBe('running')
        }
        if (state === 'stopping') sawStopping = true
        if (state === 'idle' || state === undefined) break
        await sleep(10)
      }

      const { goneMs, survivors } = await waitForTreeGone(
        [tree.parent, tree.child, tree.grandchild],
        started,
        TREE_GONE_BUDGET_MS,
      )
      expect(survivors).toEqual([])
      treeSamples.push(goneMs)
      expect(isAlive(survivorPid!)).toBe(true)

      await waitForIdle(instance.url, sessionId)
    }

    expect(sawStopping).toBe(true)
    expect(sawDeniedLaunch).toBe(true)

    const maxAckMs = Math.max(...ackSamples)
    const maxTreeGoneMs = Math.max(...treeSamples)
    expect(maxAckMs).toBeLessThan(ACK_BUDGET_MS)
    expect(maxTreeGoneMs).toBeLessThanOrEqual(TREE_GONE_BUDGET_MS)
    expect(isAlive(survivorPid!)).toBe(true)

    const reportPath = process.env['STOP_RUNTIME_DEMO_REPORT']
    if (reportPath) {
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            trials: TRIALS,
            ackMs: ackSamples,
            maxAckMs,
            treeGoneMs: treeSamples,
            maxTreeGoneMs,
            pids: { ...lastPids, survivor: survivorPid },
          },
          null,
          2,
        ),
      )
    }
  }, 120_000)
})
