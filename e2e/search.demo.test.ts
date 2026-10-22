/**
 * Lot 4b demo: FTS5 search p99 ≤ 100 ms vs the previous full-list path.
 * Isolated instance, temp paths only. Set SEARCH_DEMO_REPORT=<file> to keep figures.
 */
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10800
const N = 100
const REAL_HOME = userInfo().homedir
const PRODUCTION_PREFIXES = [
  join(REAL_HOME, 'Library', 'Application Support', 'openfox'),
  join(REAL_HOME, '.config', 'openfox'),
  join(REAL_HOME, '.local', 'share', 'openfox'),
]

const run = promisify(execFile)

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer()
      probe.once('error', () => done(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port from ${from}`)
}

function isolatedEnv(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('OPENFOX_') && !key.startsWith('XDG_')) env[key] = value
  }
  return {
    ...env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
    OPENFOX_LOG_LEVEL: 'error',
    OPENFOX_DISABLE_AUTO_SESSION_TITLE: 'true',
    ...extra,
  }
}

function track(child: ChildProcess, name: string, logs: string[]): ChildProcess {
  const keep = (data: Buffer) => {
    logs.push(`[${name}] ${data.toString()}`)
    if (logs.length > 200) logs.shift()
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  return child
}

async function startInstance(root: string, dbPath: string): Promise<Instance> {
  await mkdir(join(root, 'home'), { recursive: true })
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

async function stopInstance(instance: Instance, removeRoot = false): Promise<void> {
  if (instance.child.exitCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        instance.child.kill('SIGKILL')
        done()
      }, 15_000)
      instance.child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      instance.child.send('close')
    })
  }
  if (removeRoot) await rm(instance.root, { recursive: true, force: true })
}

async function openFiles(pid: number): Promise<string[]> {
  if (process.platform === 'linux') {
    const fds = await readdir(`/proc/${pid}/fd`)
    const targets = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')))
    return targets.filter(Boolean)
  }
  const { stdout } = await run('lsof', ['-n', '-P', '-Fn', '-p', String(pid)], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
}

const productionFiles = (files: string[]) =>
  files.filter((file) => PRODUCTION_PREFIXES.some((prefix) => file.startsWith(prefix)))

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0
}

async function timedGet(url: string): Promise<{ ms: number; status: number; body: unknown }> {
  const started = performance.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  const body = await res.json()
  return { ms: performance.now() - started, status: res.status, body }
}

describe('search FTS5 demo (isolated instance)', () => {
  let root: string
  let dbPath: string
  let fixtures: Record<string, string>
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-search-demo-')))
    dbPath = join(root, 'sessions.db')
    const { stdout } = await run('node', [join(REPO_ROOT, 'docs/backlog/corpus/generate.mjs'), dbPath, 'search'], {
      cwd: REPO_ROOT,
    })
    const generated = JSON.parse(stdout) as {
      sessionCount: number
      eventCount: number
      fixtures: Record<string, string>
    }
    fixtures = generated.fixtures
    report['corpus'] = { sessions: generated.sessionCount, events: generated.eventCount, commit: 'ff2b1018' }
  }, 60_000)

  afterAll(async () => {
    const out = process.env['SEARCH_DEMO_REPORT']
    if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf-8')
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  it('returns indexReady:false with an explicit message until rebuild, then searches in ≤ 100 ms p99', async () => {
    let instance = await startInstance(root, dbPath)
    expect(productionFiles(await openFiles(instance.child.pid!))).toEqual([])
    expect(productionFiles(await openFiles(process.pid))).toEqual([])

    const notReady = await timedGet(`${instance.url}/api/sessions?q=xylophone-alpha`)
    expect(notReady.status).toBe(200)
    const notReadyBody = notReady.body as {
      sessions: unknown[]
      indexReady: boolean
      message?: { en: string; fr: string }
    }
    expect(notReadyBody.indexReady).toBe(false)
    expect(notReadyBody.sessions).toEqual([])
    expect(notReadyBody.message?.en).toMatch(/unavailable/i)
    expect(notReadyBody.message?.fr).toMatch(/indisponible/i)

    const punctuation = await timedGet(`${instance.url}/api/sessions?q=${encodeURIComponent('AND OR * "')}`)
    expect(punctuation.status).toBe(200)

    await stopInstance(instance)

    await run(join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/rebuild-search-index.ts', '--yes', '--db', dbPath], {
      cwd: REPO_ROOT,
    })

    instance = await startInstance(root, dbPath)
    try {
      const beforeLatencies: number[] = []
      for (let i = 0; i < N; i++) {
        const hit = await timedGet(`${instance.url}/api/sessions`)
        expect(hit.status).toBe(200)
        beforeLatencies.push(hit.ms)
      }
      const afterLatencies: number[] = []
      let lastBody: { sessions?: Array<{ id: string }>; hasMore?: boolean; indexReady?: boolean } = {}
      for (let i = 0; i < N; i++) {
        const hit = await timedGet(`${instance.url}/api/sessions?q=xylophone-alpha&limit=20&offset=0`)
        expect(hit.status).toBe(200)
        lastBody = hit.body as typeof lastBody
        afterLatencies.push(hit.ms)
      }
      expect(lastBody.indexReady).toBe(true)
      expect(lastBody.sessions?.some((s) => s.id === fixtures['xylophoneSessionId'])).toBe(true)

      const cafe = await timedGet(`${instance.url}/api/sessions?q=${encodeURIComponent('cafe')}`)
      const cafeBody = cafe.body as { sessions: Array<{ id: string }> }
      expect(cafeBody.sessions.some((s) => s.id === fixtures['cafeSessionId'])).toBe(true)

      const prefix = await timedGet(`${instance.url}/api/sessions?q=prefix`)
      const prefixBody = prefix.body as { sessions: Array<{ id: string }> }
      expect(prefixBody.sessions.some((s) => s.id === fixtures['prefixSessionId'])).toBe(true)

      const multi = await timedGet(`${instance.url}/api/sessions?q=${encodeURIComponent('alpha bravo')}`)
      const multiBody = multi.body as { sessions: Array<{ id: string }> }
      expect(multiBody.sessions.some((s) => s.id === fixtures['multiSessionId'])).toBe(true)

      const ancient = await timedGet(`${instance.url}/api/sessions?q=ancient-prompt-omega`)
      const ancientBody = ancient.body as { sessions: Array<{ id: string }> }
      expect(ancientBody.sessions.some((s) => s.id === fixtures['ancientSessionId'])).toBe(true)

      const negative = await timedGet(`${instance.url}/api/sessions?q=zzznomatchterm`)
      const negativeBody = negative.body as { sessions: Array<{ id: string }>; indexReady: boolean }
      expect(negativeBody.indexReady).toBe(true)
      expect(negativeBody.sessions).toEqual([])

      const page1 = await timedGet(`${instance.url}/api/sessions?q=synthetic&limit=5&offset=0`)
      const page1Body = page1.body as { sessions: Array<{ id: string }>; hasMore: boolean }
      expect(page1Body.sessions).toHaveLength(5)
      expect(page1Body.hasMore).toBe(true)
      const page2 = await timedGet(`${instance.url}/api/sessions?q=synthetic&limit=5&offset=5`)
      const page2Body = page2.body as { sessions: Array<{ id: string }> }
      const ids1 = new Set(page1Body.sessions.map((s) => s.id))
      expect(page2Body.sessions.every((s) => !ids1.has(s.id))).toBe(true)

      const before = {
        n: beforeLatencies.length,
        p50: percentile(beforeLatencies, 0.5),
        p99: percentile(beforeLatencies, 0.99),
        cold: beforeLatencies[0],
        warm: percentile(beforeLatencies.slice(1), 0.99),
      }
      const after = {
        n: afterLatencies.length,
        p50: percentile(afterLatencies, 0.5),
        p99: percentile(afterLatencies, 0.99),
        cold: afterLatencies[0],
        warm: percentile(afterLatencies.slice(1), 0.99),
      }
      report['before'] = before
      report['after'] = after
      report['ratio'] = before.p99 === 0 ? null : after.p99 / before.p99
      expect(after.p99).toBeLessThanOrEqual(100)
      expect(productionFiles(await openFiles(instance.child.pid!))).toEqual([])
    } finally {
      await stopInstance(instance)
    }
  }, 180_000)
})
