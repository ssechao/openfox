/**
 * Étape 3 demo: create then delete a large workspace on an isolated instance
 * while /sante, /api/diagnostics and /api/health stay responsive and a
 * WebSocket client is subscribed to the session, so git status polling (every
 * second here) follows the session from the project into the workspace and
 * back. A dedicated 20 ms timer in the server and the same timer in an idle
 * witness process record timestamped loop delays over four disjoint phases
 * (create, workspace watched by the client, delete, then a reference of the
 * same total length under the same probe and polling load). CPU contention
 * delays both processes; a blocked event loop only delays the server. The
 * per-phase gap to the witness, over aligned windows, must stay ≤ 100 ms on
 * every platform; on Linux the absolute delay must also stay ≤ 100 ms.
 */
import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir, uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { DiagnosticsData } from '../src/shared/diagnostics.js'
import { freePort, isolatedEnv, killProcessTree, openFiles, productionFiles, track } from './utils/isolated-env.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10630
const FILE_COUNT = 5_000
const ENFORCE_LOOP_MAX = process.platform === 'linux'
const LOOP_MAX_MS = 100
const WINDOW_MS = 1_000
const GIT_POLL_MS = 1_000
const WORKSPACE_DWELL_MS = 3_000
const MARKER_FILE = 'dwell-marker.txt'
const HEALTH_TIMEOUT_MS = ENFORCE_LOOP_MAX ? 2_000 : 10_000

const WITNESS_SOURCE = `
const samples = []
let last = performance.now()
const tick = () => {
  const now = performance.now()
  samples.push([Date.now(), now - last - 20])
  last = now
  setTimeout(tick, 20)
}
setTimeout(tick, 20)
process.on('message', () => process.send(samples))
process.on('disconnect', () => process.exit(0))
process.send('ready')
`

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

type LoopSample = [firedAt: number, delayMs: number]

interface PhaseStats {
  openfoxMaxMs: number
  witnessMaxMs: number
  witnessGapMs: number
  worstWindow: { atMs: number; openfoxMs: number; witnessMs: number }
}

function stallMax(samples: LoopSample[], from: number, to: number): number {
  let max = 0
  for (const [firedAt, delay] of samples) {
    if (firedAt >= from && firedAt - delay < to && delay > max) max = delay
  }
  return max
}

function phaseStats(openfox: LoopSample[], witness: LoopSample[], from: number, to: number): PhaseStats {
  let worstWindow = { atMs: 0, openfoxMs: 0, witnessMs: 0 }
  let witnessGapMs = Number.NEGATIVE_INFINITY
  for (let start = from; start < to; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, to)
    const openfoxMs = stallMax(openfox, start, end)
    const witnessMs = stallMax(witness, start, end)
    if (openfoxMs - witnessMs > witnessGapMs) {
      witnessGapMs = openfoxMs - witnessMs
      worstWindow = { atMs: start - from, openfoxMs, witnessMs }
    }
  }
  return {
    openfoxMaxMs: stallMax(openfox, from, to),
    witnessMaxMs: stallMax(witness, from, to),
    witnessGapMs,
    worstWindow,
  }
}

const round = (value: number) => Math.round(value * 10) / 10

function roundStats(stats: PhaseStats) {
  return {
    openfoxMaxMs: round(stats.openfoxMaxMs),
    witnessMaxMs: round(stats.witnessMaxMs),
    witnessGapMs: round(stats.witnessGapMs),
    worstWindow: {
      atMs: Math.round(stats.worstWindow.atMs),
      openfoxMs: round(stats.worstWindow.openfoxMs),
      witnessMs: round(stats.worstWindow.witnessMs),
    },
  }
}

async function startWitness(logs: string[]): Promise<ChildProcess> {
  const env = { ...process.env }
  delete env['NODE_OPTIONS']
  const child = track(
    spawn(process.execPath, ['-e', WITNESS_SOURCE], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
    }),
    'witness',
    logs,
  )
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Witness did not start:\n${logs.join('')}`)), 30_000)
    child.once('message', () => {
      clearTimeout(timer)
      done()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`Witness exited (${code}):\n${logs.join('')}`))
    })
  })
  return child
}

function witnessSamples(child: ChildProcess): Promise<LoopSample[]> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Witness did not return its samples')), 30_000)
    child.once('message', (message) => {
      clearTimeout(timer)
      done(message as LoopSample[])
    })
    child.send('samples')
  })
}

interface SessionWatcher {
  statuses: Array<{ at: number; paths: string[] }>
  close: () => Promise<void>
}

async function watchSession(base: string, sessionId: string): Promise<SessionWatcher> {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`)
  const statuses: SessionWatcher['statuses'] = []
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('WebSocket did not open')), 30_000)
    socket.once('open', () => {
      clearTimeout(timer)
      done()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
  })
  const loaded = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('session.load was not acknowledged')), 60_000)
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as {
        id?: string
        type: string
        payload?: { diff?: { files?: Array<{ path: string }> } }
      }
      if (message.type === 'git.status') {
        statuses.push({ at: Date.now(), paths: (message.payload?.diff?.files ?? []).map((file) => file.path) })
      }
      if (message.id !== 'demo-session-load') return
      clearTimeout(timer)
      if (message.type === 'ack') done()
      else fail(new Error(`session.load failed: ${raw.toString()}`))
    })
  })
  socket.send(JSON.stringify({ id: 'demo-session-load', type: 'session.load', payload: { sessionId } }))
  await loaded
  return {
    statuses,
    close: () =>
      new Promise<void>((done) => {
        if (socket.readyState === WebSocket.CLOSED) return done()
        socket.once('close', () => done())
        socket.close()
      }),
  }
}

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
        OPENFOX_GIT_POLL_INTERVAL: String(GIT_POLL_MS),
      }),
      execArgv: [
        '--import',
        'tsx/esm',
        ...(process.env['ETAPE3_CPU_PROF_DIR']
          ? ['--cpu-prof', `--cpu-prof-dir=${process.env['ETAPE3_CPU_PROF_DIR']}`]
          : []),
      ],
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

  it('creates then deletes a large workspace without blocking the event loop beyond the witness', async () => {
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

    async function serverSamples(
      since: number,
    ): Promise<{ samples: LoopSample[]; clock: { wallMs: number; hrtimeUs: number } }> {
      const res = await fetch(`${instance.url}/api/health/loop-delay?since=${since}`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`/api/health/loop-delay: ${res.status}`)
      return (await res.json()) as { samples: LoopSample[]; clock: { wallMs: number; hrtimeUs: number } }
    }

    const witness = await startWitness(instance.logs)
    try {
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
      const watcher = await watchSession(instance.url, sessionId)
      await sleep(2 * GIT_POLL_MS)

      const createStarted = Date.now()
      const switched = await json(instance.url, `/api/sessions/${sessionId}/switch-workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'heavy' }),
      })
      expect(switched.status).toBe(200)
      const workspacePath = String(switched.body.session.workspace)
      expect(workspacePath).toContain('heavy')
      const createEnded = Date.now()

      const statusDeadline = Date.now() + 30_000
      const workspaceSeen = () =>
        watcher.statuses.some((status) => status.paths.some((path) => path.startsWith('bulk')))
      while (!workspaceSeen() && Date.now() < statusDeadline) await sleep(50)
      const markerWritten = Date.now()
      await writeFile(join(workspacePath, MARKER_FILE), 'polled\n')
      const markerSeen = () =>
        watcher.statuses.some((status) => status.at >= markerWritten && status.paths.includes(MARKER_FILE))
      while (!markerSeen() && Date.now() < statusDeadline) await sleep(50)
      const dwellRemaining = createEnded + WORKSPACE_DWELL_MS - Date.now()
      if (dwellRemaining > 0) await sleep(dwellRemaining)
      const dwellEnded = Date.now()

      const deleted = await json(instance.url, `/api/sessions/${sessionId}/delete-workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'heavy' }),
      })
      expect(deleted.status).toBe(200)
      const deleteEnded = Date.now()

      const opDuration = deleteEnded - createStarted
      await sleep(opDuration)
      const referenceEnded = Date.now()

      probeAc.abort()
      await Promise.race([probe, sleep(2_000)])
      await watcher.close()

      const [server, witnessed] = await Promise.all([serverSamples(createStarted - 60_000), witnessSamples(witness)])
      const openfox = server.samples
      const profDir = process.env['ETAPE3_CPU_PROF_DIR']
      if (profDir) {
        const stalls = (samples: LoopSample[]) => samples.filter(([, delay]) => delay > LOOP_MAX_MS)
        await writeFile(
          join(profDir, `stalls-${server.clock.wallMs}.json`),
          JSON.stringify({
            clock: server.clock,
            phases: { createStarted, createEnded, dwellEnded, deleteEnded, referenceEnded },
            openfox: stalls(openfox),
            witness: stalls(witnessed),
          }),
        )
      }
      const create = phaseStats(openfox, witnessed, createStarted, createEnded)
      const dwell = phaseStats(openfox, witnessed, createEnded, dwellEnded)
      const remove = phaseStats(openfox, witnessed, dwellEnded, deleteEnded)
      const reference = phaseStats(openfox, witnessed, deleteEnded, referenceEnded)

      const opMax = Math.max(create.openfoxMaxMs, dwell.openfoxMaxMs, remove.openfoxMaxMs)
      const overheadMs = opMax - reference.openfoxMaxMs
      const statusesIn = (from: number, to: number) =>
        watcher.statuses.filter((status) => status.at >= from && status.at < to)
      const workspaceStatuses = statusesIn(createStarted, deleteEnded).filter((status) =>
        status.paths.some((path) => path.startsWith('bulk')),
      )

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          platform: process.platform,
          create: roundStats(create),
          workspace: roundStats(dwell),
          delete: roundStats(remove),
          reference: roundStats(reference),
          opMaxMs: round(opMax),
          overheadMs: round(overheadMs),
          durationCreateMs: createEnded - createStarted,
          durationWorkspaceMs: dwellEnded - createEnded,
          durationDeleteMs: deleteEnded - dwellEnded,
          gitStatus: {
            create: statusesIn(createStarted, createEnded).length,
            workspace: statusesIn(createEnded, dwellEnded).length,
            delete: statusesIn(dwellEnded, deleteEnded).length,
            reference: statusesIn(deleteEnded, referenceEnded).length,
            withWorkspaceFiles: workspaceStatuses.length,
            markerSeen: markerSeen(),
          },
          samples: { openfox: openfox.length, witness: witnessed.length },
          health,
          loadAvg: loadavg(),
          uptimeS: uptime(),
          enforceAbsolute: ENFORCE_LOOP_MAX,
        }),
      )

      expect(health.errors).toBe(0)
      expect(health.requests).toBeGreaterThan(3)
      expect(opDuration).toBeGreaterThan(500)
      expect(markerSeen(), 'a git status poll of the watched workspace reached the client').toBe(true)
      expect(workspaceStatuses.length).toBeGreaterThan(0)
      expect(
        openfox.filter(([firedAt]) => firedAt >= createStarted && firedAt <= referenceEnded).length,
      ).toBeGreaterThan(0)
      expect(
        witnessed.filter(([firedAt]) => firedAt >= createStarted && firedAt <= referenceEnded).length,
      ).toBeGreaterThan(0)

      for (const [phase, stats] of [
        ['create', create],
        ['workspace', dwell],
        ['delete', remove],
        ['reference', reference],
      ] as const) {
        expect(
          stats.witnessGapMs,
          `${phase}: server loop delay exceeds the witness by ${stats.witnessGapMs} ms`,
        ).toBeLessThanOrEqual(LOOP_MAX_MS)
      }

      if (ENFORCE_LOOP_MAX) {
        expect(health.timeouts).toBe(0)
        expect(opMax, `eventLoopDelay max ${opMax} ms during the operation on Linux`).toBeLessThanOrEqual(LOOP_MAX_MS)
        expect(overheadMs, `eventLoopDelay overhead ${overheadMs} ms on Linux`).toBeLessThanOrEqual(LOOP_MAX_MS)
      }
    } finally {
      killProcessTree(witness)
    }
  }, 900_000)
})
