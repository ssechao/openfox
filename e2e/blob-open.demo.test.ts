/**
 * Lot 4a-1 demo: blob store on a generated corpus, isolated instance.
 * C3: remasure before/after, blob route round-trip + auth, UI src from the ref.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error generated ESM corpus script
import { generateCorpus } from '../docs/backlog/corpus/generate.mjs'
import { freePort, isolatedEnv, killProcessTree, openFiles, productionFiles, track } from './utils/isolated-env.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 10720
const TOKEN = '4a1-demo-token'
const CHILD = join(REPO_ROOT, 'e2e/utils/health-server-child.ts')

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const even = sorted.length % 2 === 0
  const value = even ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
  return Math.round(value * 10) / 10
}

async function startInstance(dbPath: string, portFrom: number): Promise<Instance> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-4a1-demo-')))
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

async function stopInstance(instance: Instance, keepDb = false): Promise<void> {
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
  if (!keepDb) await rm(instance.root, { recursive: true, force: true })
  else await rm(join(instance.root, 'home'), { recursive: true, force: true }).catch(() => undefined)
}

async function timedGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number
  bytes: number
  ms: number
  body: Buffer
}> {
  const t0 = performance.now()
  const res = await fetch(url, { headers })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, bytes: body.length, ms: Math.round((performance.now() - t0) * 10) / 10, body }
}

const authed = { 'x-session-token': TOKEN }

describe('4a-1 blob open demo', () => {
  let corpusDir: string
  let dbPath: string
  let sessionId: string
  let roundTripHash: string
  let roundTripBytes: number
  const report: Record<string, unknown> = { loadavg: loadavg() }

  beforeAll(async () => {
    corpusDir = await realpath(await mkdtemp(join(tmpdir(), 'openfox-4a1-corpus-')))
    dbPath = join(corpusDir, 'sessions.db')
    const info = generateCorpus(dbPath, { workdir: join(corpusDir, 'workdir') })
    sessionId = info.sessionId
    roundTripHash = info.roundTripHash
    roundTripBytes = info.roundTripBytes
    report['corpus'] = { snapshotBytes: info.snapshotBytes, sessionId, dbPath }
  }, 60_000)

  afterAll(async () => {
    await rm(corpusDir, { recursive: true, force: true })
    if (process.env['ETAPE4A1_DEMO_REPORT']) {
      await writeFile(process.env['ETAPE4A1_DEMO_REPORT'], JSON.stringify(report, null, 2))
    }
  })

  async function coldOpenTimes(label: string, portFrom: number): Promise<number[]> {
    const times: number[] = []
    for (let i = 0; i < 3; i++) {
      console.error(`[4a1] ${label} cold ${i + 1} starting`)
      const instance = await startInstance(dbPath, portFrom + i * 3)
      try {
        console.error(`[4a1] ${label} cold ${i + 1} up on ${instance.port}`)
        const files = await openFiles(instance.child.pid!)
        expect(productionFiles(files)).toEqual([])
        await timedGet(`${instance.url}/api/health`)
        const got = await timedGet(`${instance.url}/api/sessions/${sessionId}`, authed)
        expect(got.status).toBe(200)
        times.push(got.ms)
        report[`${label}#${i + 1}`] = { ms: got.ms, bytes: got.bytes }
      } finally {
        await stopInstance(instance, true)
      }
    }
    return times
  }

  it('remasures before, migrates explicitly, then checks route, auth, UI and after', async () => {
    const before = await coldOpenTimes('before', MIN_PORT)
    const beforeMedian = median(before)
    report['before'] = { samples: before, median: beforeMedian }

    execFileSync('npx', ['tsx', 'scripts/migrate-blobs.ts', '--yes', '--db', dbPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })

    const after = await coldOpenTimes('after', MIN_PORT + 20)
    const afterMedian = median(after)
    const ratio = afterMedian / beforeMedian
    report['after'] = { samples: after, median: afterMedian, ratio }
    report['minus50'] = ratio <= 0.5
    // Non-blocking: always record the figure. Auth / round-trip / UI must pass.

    const instance = await startInstance(dbPath, MIN_PORT + 40)
    try {
      const files = await openFiles(instance.child.pid!)
      expect(productionFiles(files)).toEqual([])

      const session = await timedGet(`${instance.url}/api/sessions/${sessionId}`, authed)
      expect(session.status).toBe(200)
      const json = JSON.parse(session.body.toString('utf8')) as {
        messages: Array<{ attachments?: Array<{ blob?: { hash: string; mime: string } }> }>
      }
      const hashes = json.messages.flatMap((m) => (m.attachments ?? []).map((a) => a.blob?.hash).filter(Boolean))
      expect(hashes).toContain(roundTripHash)

      const blob = await timedGet(`${instance.url}/api/blobs/${roundTripHash}`, authed)
      expect(blob.status).toBe(200)
      expect(blob.body.length).toBe(roundTripBytes)
      expect(createHash('sha256').update(blob.body).digest('hex')).toBe(roundTripHash)
      expect(blob.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)

      const noAuth = await timedGet(`${instance.url}/api/blobs/${roundTripHash}`)
      expect(noAuth.status).toBe(401)

      const unknown = await timedGet(`${instance.url}/api/blobs/${'b'.repeat(64)}`, authed)
      expect(unknown.status).toBe(404)

      const traversal = await timedGet(`${instance.url}/api/blobs/${encodeURIComponent('../etc/passwd')}`, authed)
      expect([400, 404]).toContain(traversal.status)

      const invalid = await timedGet(`${instance.url}/api/blobs/not-a-hash`, authed)
      expect(invalid.status).toBe(400)
    } finally {
      await stopInstance(instance, true)
    }

    const { attachmentDisplaySrc, blobUrl } = await import('../src/shared/blob.js')
    const uiSrc = attachmentDisplaySrc({
      id: 'att-b',
      filename: 'shot-b.png',
      mimeType: 'image/png',
      size: roundTripBytes,
      blob: { hash: roundTripHash, mime: 'image/png', size: roundTripBytes },
    })
    expect(uiSrc).toBe(blobUrl(roundTripHash))
    const component = readFileSync(join(REPO_ROOT, 'web/src/components/shared/MessageAttachments.tsx'), 'utf8')
    expect(component).toContain('attachmentDisplaySrc')
    expect(component).toContain('src={attachmentDisplaySrc(attachment)}')
    report['ui'] = { src: uiSrc }
    console.log(JSON.stringify({ beforeMedian, afterMedian, ratio, minus50: ratio <= 0.5 }, null, 2))
  }, 600_000)
})
