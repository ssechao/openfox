/**
 * Étape 3 demo: create then delete a large workspace on an isolated instance
 * while /sante, /api/diagnostics and /api/health stay responsive. A dedicated
 * 20 ms timer in the server reports the loop delay of three disjoint phases
 * (create, delete, then an idle reference of the same total length under the
 * same probe load). The ≤ 100 ms overhead assertion is enforced on Linux.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir, uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiagnosticsData } from '../src/shared/diagnostics.js'
import { freePort, isolatedEnv, killProcessTree, openFiles, productionFiles, track } from './utils/isolated-env.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10630
const FILE_COUNT = 5_000
const ENFORCE_LOOP_MAX = process.platform === 'linux'
const LOOP_MAX_MS = 100
const HEALTH_TIMEOUT_MS = ENFORCE_LOOP_MAX ? 2_000 : 10_000

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

function git(cwd: string, args: string[]): void {
  const env = { ...process.env }
  delete env['GIT_DIR']
  delete env['GIT_INDEX_FILE']
  delete env['GIT_WORK_TREE']
  delete env['GIT_PREFIX']
  execFileSync('git', args, { cwd, env, stdio: 'ignore' })
}

async function startInstance(): Promise<Instance> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-etape3-demo-')))
  await mkdir(join(root, 'home'), { recursive: true })
  await mkdir(join(root, 'workspaces'), { recursive: true })
  const dbPath = join(root, 'sessions.db')
  const configPath = join(root, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: [],
      activeProviderId: null,
    }),
    'utf-8',
  )
  const port = await freePort(MIN_PORT)
  const logs: string[] = []
  const child = track(
    fork(join(REPO_ROOT, 'e2e/utils/health-server-child.ts'), [], {
      cwd: REPO_ROOT,
      env: isolatedEnv(root, {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_GLOBAL_CONFIG_PATH: configPath,
        OPENFOX_HOST: '127.0.0.1',
        OPENFOX_PORT: String(port),
        OPENFOX_LLM_URL: 'http://127.0.0.1:9/v1',
        OPENFOX_HEALTH_DEMO_MODE: 'development',
        OPENFOX_DEMO_LOOP_PROBE: '1',
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
  const response = await fetch(`${base}/api/diagnostics`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`/api/diagnostics: ${response.status}`)
  return (await response.json()) as DiagnosticsData
}

async function json(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(180_000) })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

describe('workspace non-blocking demo (isolated instance)', () => {
  let instance: Instance

  beforeAll(async () => {
    instance = await startInstance()
  }, 300_000)

  afterAll(async () => {
    if (instance) await stopInstance(instance)
  }, 30_000)

  it('runs on its temporary database and never opens the production paths', async () => {
    expect(instance.port).toBeGreaterThanOrEqual(MIN_PORT)
    await diagnostics(instance.url)
    const serverFiles = await openFiles(instance.child.pid!)
    expect(serverFiles).toContain(instance.dbPath)
    expect(productionFiles(serverFiles)).toEqual([])
    expect(productionFiles(await openFiles(process.pid))).toEqual([])
  }, 300_000)

  it('creates then deletes a large workspace while loop delay stays under the Linux threshold', async () => {
    const projectDir = join(instance.root, 'project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'README.md'), 'etape3\n')
    git(projectDir, ['init', '--initial-branch=main'])
    git(projectDir, ['config', 'user.email', 'test@example.com'])
    git(projectDir, ['config', 'user.name', 'Test'])
    git(projectDir, ['add', '-A'])
    git(projectDir, ['commit', '-m', 'init'])

    const created = await json(instance.url, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'etape3-ws', workdir: projectDir }),
    })
    expect(created.status).toBe(201)
    const projectId = created.body.project.id as string

    const setup = [
      `${process.execPath} -e ${JSON.stringify(
        `const fs=require('fs');const p=require('path');fs.mkdirSync('bulk',{recursive:true});for(let i=0;i<${FILE_COUNT};i++)fs.writeFileSync(p.join('bulk','f'+i),'x');`,
      )}`,
      'sleep 1',
    ]
    const cfg = await json(instance.url, `/api/workspace/config?workdir=${encodeURIComponent(projectDir)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setup, rootDir: join(instance.root, 'workspaces') }),
    })
    expect(cfg.status).toBe(200)

    const sessionRes = await json(instance.url, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'etape3-demo' }),
    })
    expect(sessionRes.status).toBe(201)
    const sessionId = sessionRes.body.session.id as string

    const warmupDeadline = Date.now() + 60_000
    let santeReady = 0
    while (Date.now() < warmupDeadline && santeReady !== 200) {
      try {
        const res = await fetch(`${instance.url}/sante`, { signal: AbortSignal.timeout(5_000) })
        santeReady = res.status
      } catch {
        santeReady = 0
      }
      if (santeReady !== 200) await sleep(250)
    }
    expect(santeReady).toBe(200)
    await sleep(1_500)

    async function loopDelay(): Promise<number> {
      const res = await fetch(`${instance.url}/api/health/loop-delay`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`/api/health/loop-delay: ${res.status}`)
      const body = (await res.json()) as { maxMs: number }
      return body.maxMs
    }

    const health = { requests: 0, timeouts: 0, errors: 0 }
    const probeAc = new AbortController()
    const probe = (async () => {
      while (!probeAc.signal.aborted) {
        try {
          const responses = await Promise.all(
            ['/sante', '/api/diagnostics', '/api/health'].map((path) =>
              fetch(`${instance.url}${path}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }),
            ),
          )
          health.requests += responses.length
          if (responses.some((res) => res.status !== 200)) health.errors++
        } catch (error) {
          health.requests += 3
          if ((error as Error).name === 'TimeoutError') health.timeouts++
          else health.errors++
        }
        await sleep(200)
      }
    })()

    await loopDelay()

    const createStarted = performance.now()
    const switched = await json(instance.url, `/api/sessions/${sessionId}/switch-workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'heavy' }),
    })
    expect(switched.status).toBe(200)
    expect(String(switched.body.session.workspace)).toContain('heavy')
    const createEnded = performance.now()
    const createMax = await loopDelay()

    const deleteStarted = performance.now()
    const deleted = await json(instance.url, `/api/sessions/${sessionId}/delete-workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'heavy' }),
    })
    expect(deleted.status).toBe(200)
    const deleteEnded = performance.now()
    const deleteMax = await loopDelay()

    const opDuration = deleteEnded - createStarted
    await sleep(opDuration)
    const refMax = await loopDelay()

    probeAc.abort()
    await Promise.race([probe, sleep(2_000)])

    const opMax = Math.max(createMax, deleteMax)
    const overheadMs = opMax - refMax
    const peakPhase = createMax >= deleteMax ? 'create' : 'delete'

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        platform: process.platform,
        referenceMaxMs: Math.round(refMax * 10) / 10,
        opMaxMs: Math.round(opMax * 10) / 10,
        createMaxMs: Math.round(createMax * 10) / 10,
        deleteMaxMs: Math.round(deleteMax * 10) / 10,
        overheadMs: Math.round(overheadMs * 10) / 10,
        peakPhase,
        durationCreateMs: Math.round(createEnded - createStarted),
        durationDeleteMs: Math.round(deleteEnded - deleteStarted),
        health,
        loadAvg: loadavg(),
        uptimeS: uptime(),
        enforce: ENFORCE_LOOP_MAX,
      }),
    )

    expect(health.errors).toBe(0)
    expect(health.requests).toBeGreaterThan(3)
    expect(opDuration).toBeGreaterThan(500)

    if (ENFORCE_LOOP_MAX) {
      expect(health.timeouts).toBe(0)
      expect(overheadMs, `eventLoopDelay overhead ${overheadMs} ms on Linux`).toBeLessThanOrEqual(LOOP_MAX_MS)
    }
  }, 900_000)
})
