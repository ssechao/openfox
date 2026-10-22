/**
 * Lot 4c demo: snapshot cache stays under a configured byte limit on the corpus.
 * Isolated instance, temp paths only. Set SNAPSHOT_CACHE_DEMO_REPORT=<file> to keep figures.
 */
import Database from 'better-sqlite3'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiagnosticsData } from '../src/shared/diagnostics.js'
// @ts-expect-error generated ESM corpus script
import { generateCorpus } from '../docs/backlog/corpus/generate.mjs'
import { freePort, isolatedEnv, killProcessTree, openFiles, productionFiles, track } from './utils/isolated-env.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10900
const TOKEN = '4c-demo-token'
const CHILD = join(REPO_ROOT, 'e2e/utils/health-server-child.ts')
const LIMIT_BYTES = 16 * 1024 * 1024
const MEDIUM_BYTES = 5 * 1024 * 1024
const MEDIUM_COUNT = 6

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

function addMediumSessions(dbPath: string, count: number, targetBytes: number): string[] {
  const db = new Database(dbPath)
  const now = '2026-10-22T00:00:00.000Z'
  const ts = Date.parse(now)
  const projectId = '4a1-project'
  const workdir = '/tmp/openfox-4c-medium-workdir'
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `4c-medium-${i}`
    db.prepare(
      `INSERT INTO sessions (id, project_id, workdir, phase, created_at, updated_at, title, mode, is_running, workflow_phase, message_count, recent_user_prompts)
       VALUES (?, ?, ?, 'idle', ?, ?, ?, 'builder', 0, 'build', 1, '[]')`,
    ).run(id, projectId, workdir, now, now, `medium ${i}`)
    const snapshot = {
      mode: 'builder',
      phase: 'build',
      isRunning: false,
      messages: [{ id: 'm0', role: 'user', content: `medium ${i}`, timestamp: ts, thinkingContent: '' }],
      criteria: [],
      todos: [],
      metadataEntries: {},
      contextState: {
        currentTokens: 0,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      },
      currentContextWindowId: 'win-1',
      snapshotSeq: 1,
      snapshotAt: ts,
    }
    let payload = JSON.stringify(snapshot)
    const missing = targetBytes - payload.length
    if (missing > 0) {
      snapshot.messages[0]!.thinkingContent = 'm'.repeat(missing)
      payload = JSON.stringify(snapshot)
    }
    db.prepare(
      `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'session.initialized', ?)`,
    ).run(id, ts, JSON.stringify({ projectId, workdir, contextWindowId: 'win-1' }))
    db.prepare(
      `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 2, ?, 'turn.snapshot', ?)`,
    ).run(id, ts, payload)
    ids.push(id)
  }
  db.close()
  return ids
}

async function startInstance(dbPath: string, portFrom: number): Promise<Instance> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-4c-demo-')))
  await mkdir(join(root, 'home'), { recursive: true })
  const port = await freePort(portFrom)
  const logs: string[] = []
  await writeFile(join(root, 'config.json'), JSON.stringify({ providers: [], mcpServers: [] }))
  const child = track(
    fork(CHILD, [], {
      cwd: REPO_ROOT,
      env: isolatedEnv(root, {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_GLOBAL_CONFIG_PATH: join(root, 'config.json'),
        OPENFOX_HOST: '127.0.0.1',
        OPENFOX_PORT: String(port),
        OPENFOX_LLM_URL: 'http://127.0.0.1:9/v1',
        OPENFOX_MOCK_LLM: 'true',
        OPENFOX_TEST_REQUIRE_AUTH: '1',
        OPENFOX_TEST_AUTH_TOKEN: TOKEN,
        OPENFOX_SNAPSHOT_CACHE_MAX_BYTES: String(LIMIT_BYTES),
        OPENFOX_SNAPSHOT_CACHE_MAX_ENTRIES: '4',
      }),
      execArgv: ['--import', 'tsx/esm'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    }),
    'server',
    logs,
  )
  const listening = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`start timeout\n${logs.join('')}`)), 180_000)
    child.on('message', (message) => {
      const value = (message as { port?: number } | null)?.port
      if (typeof value === 'number') {
        clearTimeout(timer)
        done(value)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`exited ${code}\n${logs.join('')}`))
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
      }, 10_000)
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

const authed = { 'x-session-token': TOKEN }

async function cacheSeries(url: string): Promise<{
  hits: number | null
  misses: number | null
  bytes: number | null
  evictions: number | null
  limit: number | null
}> {
  const res = await fetch(`${url}/api/diagnostics`, { headers: authed })
  expect(res.status).toBe(200)
  const data = (await res.json()) as DiagnosticsData
  return {
    hits: data.series.snapshotCacheHits.value,
    misses: data.series.snapshotCacheMisses.value,
    bytes: data.series.snapshotCacheBytes.value,
    evictions: data.series.snapshotCacheEvictions.value,
    limit: data.series.snapshotCacheLimitBytes.value,
  }
}

async function getSession(url: string, id: string): Promise<void> {
  const res = await fetch(`${url}/api/sessions/${id}`, { headers: authed })
  expect(res.status).toBe(200)
  await res.arrayBuffer()
}

describe('4c snapshot cache demo', () => {
  let corpusDir: string
  let dbPath: string
  let heavyId: string
  let mediumIds: string[]
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    corpusDir = await realpath(await mkdtemp(join(tmpdir(), 'openfox-4c-corpus-')))
    dbPath = join(corpusDir, 'sessions.db')
    const info = generateCorpus(dbPath, { workdir: join(corpusDir, 'workdir') })
    heavyId = info.sessionId
    expect(info.snapshotBytes).toBeGreaterThan(LIMIT_BYTES)
    mediumIds = addMediumSessions(dbPath, MEDIUM_COUNT, MEDIUM_BYTES)
    report['corpus'] = { snapshotBytes: info.snapshotBytes, heavyId, mediumIds, dbPath }
  }, 180_000)

  afterAll(async () => {
    await rm(corpusDir, { recursive: true, force: true })
    if (process.env['SNAPSHOT_CACHE_DEMO_REPORT']) {
      await writeFile(process.env['SNAPSHOT_CACHE_DEMO_REPORT'], JSON.stringify(report, null, 2))
    }
  })

  it('keeps cache bytes under the configured limit on the corpus', async () => {
    const instance = await startInstance(dbPath, MIN_PORT)
    try {
      const files = await openFiles(instance.child.pid!)
      expect(productionFiles(files)).toEqual([])

      for (const id of mediumIds) {
        await getSession(instance.url, id)
        await getSession(instance.url, id)
      }

      const beforeHeavy = await cacheSeries(instance.url)
      expect(beforeHeavy.limit).toBe(LIMIT_BYTES)
      expect(beforeHeavy.bytes).not.toBeNull()
      expect(beforeHeavy.bytes!).toBeLessThanOrEqual(LIMIT_BYTES)

      await getSession(instance.url, heavyId)
      const afterFirstHeavy = await cacheSeries(instance.url)
      expect(afterFirstHeavy.misses).not.toBeNull()
      expect(beforeHeavy.misses).not.toBeNull()
      expect(afterFirstHeavy.misses!).toBeGreaterThan(beforeHeavy.misses!)
      expect(afterFirstHeavy.hits).toBe(beforeHeavy.hits)
      expect(afterFirstHeavy.bytes!).toBeLessThanOrEqual(LIMIT_BYTES)

      await getSession(instance.url, heavyId)
      const afterSecondHeavy = await cacheSeries(instance.url)
      expect(afterSecondHeavy.misses).not.toBeNull()
      expect(afterSecondHeavy.misses!).toBeGreaterThan(afterFirstHeavy.misses!)
      expect(afterSecondHeavy.hits).toBe(afterFirstHeavy.hits)
      expect(afterSecondHeavy.bytes!).toBeLessThanOrEqual(LIMIT_BYTES)
      expect(afterSecondHeavy.limit).toBe(LIMIT_BYTES)
      expect(afterSecondHeavy.evictions).toBeGreaterThanOrEqual(1)
      expect(afterSecondHeavy.hits).toBeGreaterThanOrEqual(1)
      report['diagnostics'] = { beforeHeavy, afterFirstHeavy, afterSecondHeavy }

      const live = await openFiles(instance.child.pid!)
      expect(productionFiles(live)).toEqual([])
    } finally {
      await stopInstance(instance)
    }
  }, 600_000)
})
