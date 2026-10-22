/**
 * Étape 1 demo: an isolated OpenFox instance reports its own health while it
 * is loaded. Everything runs on temporary paths (HOME, database, config) set
 * before the child process starts, on a free port >= 10600.
 *
 * Set HEALTH_DEMO_REPORT=<file> to keep the measured figures as JSON.
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
import { pause, runBench, withProbes, type Probe } from './utils/load-run.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10600
const BLOCK_MS = 500
const HEALTH_TIMEOUT_MS = 2_000

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

async function startInstance(): Promise<Instance> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-health-demo-')))
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
        OPENFOX_TEST_BLOCK_LOOP: '1',
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

async function waitFor(
  base: string,
  predicate: (data: DiagnosticsData) => boolean,
  timeoutMs: number,
): Promise<DiagnosticsData> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const data = await diagnostics(base)
    if (predicate(data)) return data
    if (performance.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`)
    await sleep(250)
  }
}

const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10)

function snapshot(data: DiagnosticsData, startedAt: number) {
  const s = data.series
  return {
    t: Math.round((performance.now() - startedAt) / 100) / 10,
    loopP50: round(s.eventLoopDelayP50.value),
    loopP99: round(s.eventLoopDelayP99.value),
    loopMax: round(s.eventLoopDelayMax.value),
    healthP99: round(s.healthLatencyP99.value),
    readP99: round(s.eventStoreReadP99.value),
    writeP99: round(s.eventStoreWriteP99.value),
    walBytes: s.walSize.value,
    running: s.runningSessions.value,
    rssMiB: s.rss.value === null ? null : Math.round(s.rss.value / 1024 / 1024),
    heapMiB: s.heapUsed.value === null ? null : Math.round(s.heapUsed.value / 1024 / 1024),
  }
}

describe('health dashboard demo (isolated instance)', () => {
  let instance: Instance
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    instance = await startInstance()
    report['port'] = instance.port
  }, 150_000)

  afterAll(async () => {
    if (instance) await stopInstance(instance)
    const out = process.env['HEALTH_DEMO_REPORT']
    if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf-8')
  }, 30_000)

  it('runs on its temporary database and never opens the production paths', async () => {
    expect(instance.port).toBeGreaterThanOrEqual(MIN_PORT)
    await diagnostics(instance.url)
    const serverFiles = await openFiles(instance.child.pid!)
    expect(serverFiles).toContain(instance.dbPath)
    expect(productionFiles(serverFiles)).toEqual([])
    expect(productionFiles(await openFiles(process.pid))).toEqual([])
    report['database'] = instance.dbPath
  }, 30_000)

  it('detects a calibrated loop block with the max, then the window returns to rest', async () => {
    const before = await waitFor(instance.url, (data) => data.series.eventLoopDelayP99.samples > 50, 10_000)
    const blockedAt = performance.now()
    const response = await fetch(`${instance.url}/api/test/block-loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: BLOCK_MS }),
    })
    expect(response.status).toBe(200)

    const during = await waitFor(
      instance.url,
      (data) => (data.series.eventLoopDelayMax.value ?? 0) >= BLOCK_MS * 0.8,
      5_000,
    )
    const after = await waitFor(
      instance.url,
      (data) => (data.series.eventLoopDelayMax.value ?? 0) < BLOCK_MS * 0.8,
      20_000,
    )
    const restoredAfterMs = performance.now() - blockedAt

    expect(during.series.eventLoopDelayMax.value).toBeGreaterThanOrEqual(BLOCK_MS * 0.8)
    expect(restoredAfterMs).toBeGreaterThanOrEqual(9_000)
    expect(after.series.eventLoopDelayP99.value).toBeLessThan(BLOCK_MS * 0.5)
    report['calibratedBlock'] = {
      injectedMs: BLOCK_MS,
      before: snapshot(before, blockedAt),
      during: snapshot(during, blockedAt),
      after: snapshot(after, blockedAt),
      restoredAfterSeconds: Math.round(restoredAfterMs / 100) / 10,
    }
  }, 45_000)

  it('keeps /api/health answering while the stream bench runs against this instance', async () => {
    const startedAt = performance.now()
    const health = { requests: 0, timeouts: 0, errors: 0, latencies: [] as number[] }
    const timeline: Array<ReturnType<typeof snapshot> & { phase: string }> = []
    let phase = 'idle'

    const probeHealth: Probe = async (signal) => {
      while (!signal.aborted) {
        const sent = performance.now()
        try {
          const res = await fetch(`${instance.url}/api/health`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]),
          })
          await res.arrayBuffer()
          health.requests++
          health.latencies.push(performance.now() - sent)
        } catch (error) {
          if (signal.aborted) break
          health.requests++
          if ((error as Error).name === 'TimeoutError') health.timeouts++
          else health.errors++
        }
        await pause(100, signal)
      }
    }
    let diagnosticsFailures = 0
    const sampleDiagnostics: Probe = async (signal) => {
      while (!signal.aborted) {
        try {
          timeline.push({ phase, ...snapshot(await diagnostics(instance.url), startedAt) })
        } catch {
          diagnosticsFailures++
        }
        await pause(1_000, signal)
      }
    }

    const benchOut = join(instance.root, 'bench.json')
    await withProbes([probeHealth, sampleDiagnostics], async () => {
      await sleep(3_000)
      phase = 'bench'
      await runBench({
        script: join(REPO_ROOT, 'scripts/bench/stream-batching.ts'),
        args: [
          `--server-url=${instance.url}`,
          `--out=${benchOut}`,
          '--fragments=40000',
          '--calls=40',
          '--rate=3000',
          '--probe-interval=50',
          '--idle-probe=1000',
          '--label=etape1-demo',
        ],
        cwd: REPO_ROOT,
        env: isolatedEnv(instance.root, {}),
        execArgv: ['--import', 'tsx/esm'],
        timeoutMs: 150_000,
        logs: instance.logs,
        during: async (bench) => {
          await sleep(2_000)
          if (bench.exitCode === null) expect(productionFiles(await openFiles(bench.pid!))).toEqual([])
        },
      })
      phase = 'rest'
      await sleep(12_000)
    })

    const sorted = [...health.latencies].sort((a, b) => a - b)
    const pick = (p: number) => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null)
    const benchResult = JSON.parse(await readFile(benchOut, 'utf-8')) as Record<string, unknown>
    const peak = (key: 'loopP99' | 'loopMax') =>
      Math.max(0, ...timeline.filter((point) => point.phase === 'bench').map((point) => point[key] ?? 0))

    report['streamBench'] = {
      bench: {
        turnSeconds: benchResult['turnSeconds'],
        timedOut: benchResult['timedOut'],
        llm: benchResult['llm'],
        apiConfigStreamingMs: benchResult['apiConfigStreamingMs'],
      },
      externalHealthProbe: {
        requests: health.requests,
        timeouts: health.timeouts,
        errors: health.errors,
        timeoutMs: HEALTH_TIMEOUT_MS,
        p50: pick(0.5),
        p99: pick(0.99),
        max: round(sorted.at(-1) ?? null),
      },
      peakDuringBench: { loopP99: peak('loopP99'), loopMax: peak('loopMax') },
      diagnosticsFailures,
      timeline,
    }

    expect(benchResult['timedOut']).toBe(false)
    expect(health.timeouts).toBe(0)
    expect(health.errors).toBe(0)
    expect(timeline.some((point) => point.phase === 'bench' && point.loopP99 !== null)).toBe(true)
    expect(timeline.some((point) => point.phase === 'bench' && (point.writeP99 ?? 0) > 0)).toBe(true)
    expect(timeline.some((point) => point.phase === 'bench' && (point.running ?? 0) >= 1)).toBe(true)
    expect(timeline.filter((point) => point.phase === 'rest').at(-1)?.running).toBe(0)
  }, 200_000)
})
