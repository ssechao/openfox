import Database from 'better-sqlite3'
import { fork } from 'node:child_process'
import { createServer, get, Agent } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { cpus, totalmem, platform, arch } from 'node:os'
import { fileURLToPath } from 'node:url'
import { EventStore } from '../../src/server/events/store.js'
import { buildSnapshotFromSessionState, foldContextState } from '../../src/server/events/folding.js'
import { processContextImages } from '../../src/server/context/image-processor.js'
import { buildContextMessages } from '../../src/server/chat/conversation-history.js'
import type { SessionSnapshot, StoredEvent } from '../../src/server/events/types.js'

const sizes = [50, 46, 32, 26, 24, 6.5, 6]
const turns = 3
const rounds = 4
const withoutVision = process.env['OF_PERF_WITHOUT_VISION'] === '1'
const staggered = process.env['OF_PERF_STAGGERED'] === '1'
const delays = sizes.map((_, index) =>
  Array.from({ length: turns }, (_entry, turn) => ((index + 1) * 7919 + (turn + 1) * 3571) % 2001),
)
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const numericDelta = (before: unknown, after: unknown): unknown => {
  if (typeof before === 'number' && typeof after === 'number') return after - before
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const first = before as Record<string, unknown>
    return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, numericDelta(first[key], value)]))
  }
  return null
}
const quantiles = (samples: number[]) => {
  const values = [...samples].sort((a, b) => a - b)
  const at = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0
  return { samples: values.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: values.at(-1) ?? 0 }
}

function makeSnapshot(megabytes: number): SessionSnapshot {
  const messages: SessionSnapshot['messages'] = []
  const content = 's'.repeat(65536)
  for (let n = 0; n < Math.floor((megabytes * 1000000) / content.length); n++) {
    messages.push({
      id: 'm' + n,
      role: n % 2 ? 'assistant' : 'user',
      content,
      timestamp: n + 1,
      contextWindowId: n < 10 ? 'active' : 'archive',
      isComplete: true,
    })
  }
  return {
    mode: 'builder',
    phase: 'build',
    isRunning: true,
    messages,
    criteria: [],
    todos: [],
    readFiles: [],
    metadataEntries: {},
    currentContextWindowId: 'active',
    snapshotAt: 1000,
    snapshotSeq: 1,
    contextState: {
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 1,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
  }
}

async function worker() {
  const db = new Database(':memory:')
  const store = new EventStore(db, { diagnostics: true })
  const bytes: number[] = []
  for (const [n, size] of sizes.entries()) {
    store.append(String(n), {
      type: 'session.initialized',
      data: { projectId: 'bench', workdir: '/synthetic', contextWindowId: 'active' },
    })
    const snapshot = makeSnapshot(size)
    bytes.push(Buffer.byteLength(JSON.stringify(snapshot)))
    store.append(String(n), { type: 'turn.snapshot', data: snapshot })
    store.append(String(n), { type: 'running.changed', data: { isRunning: true } })
    store.getLatestSnapshot(String(n))
  }
  const readEvents = (id: string): StoredEvent[] => {
    const optimized = store as EventStore & { getReplayEvents?: (id: string) => StoredEvent[] }
    return optimized.getReplayEvents ? optimized.getReplayEvents(id) : store.getEvents(id)
  }
  const windowId = (id: string): string => {
    const optimized = store as EventStore & { getCurrentWindowId?: (id: string) => string | undefined }
    return optimized.getCurrentWindowId
      ? (optimized.getCurrentWindowId(id) ?? '')
      : foldContextState(store.getEvents(id), '').currentContextWindowId
  }
  const round = async (id: string) => {
    const window = windowId(id)
    const rawEvents = readEvents(id)
    const { events } = await processContextImages(rawEvents, { modelSupportsVision: !withoutVision })
    const messages = buildContextMessages(events, { type: 'toplevel', sessionId: id })
    if (window !== 'active' || messages.length < 10) throw new Error('Invalid benchmark reconstruction')
  }
  for (const id of sizes.keys()) await round(String(id))
  store.resetDiagnostics()
  const before = process.memoryUsage()
  const delay = monitorEventLoopDelay({ resolution: 10 })
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No benchmark port')
  process.send?.({ ready: true, port: address.port })
  await new Promise<void>((resolve) => process.once('message', () => resolve()))
  delay.enable()
  const started = performance.now()
  const roundSamples: unknown[] = [],
    turnSamples: unknown[] = []
  const builds: number[] = [],
    appends: number[] = [],
    roundTimes: number[] = []
  await Promise.all(
    sizes.map(async (_size, index) => {
      const id = String(index)
      for (let turn = 0; turn < turns; turn++) {
        for (let r = 0; r < rounds; r++) {
          await tick()
          const counters = store.getDiagnostics()
          const start = performance.now()
          await round(id)
          const durationMs = performance.now() - start
          roundTimes.push(durationMs)
          roundSamples.push({
            session: index,
            turn,
            round: r,
            durationMs,
            counters: numericDelta(counters, store.getDiagnostics()),
          })
        }
        await tick()
        if (staggered) await new Promise((resolve) => setTimeout(resolve, delays[index]![turn]))
        const counters = store.getDiagnostics()
        const buildStart = performance.now()
        const snapshot = store.measureSnapshotOperation('snapshotBuild', () =>
          buildSnapshotFromSessionState({
            session: { mode: 'builder', phase: 'build', isRunning: true, criteria: [] },
            events: readEvents(id),
            latestSeq: store.getLatestSeq(id) ?? 0,
          }),
        )
        builds.push(performance.now() - buildStart)
        const appendStart = performance.now()
        store.append(id, { type: 'turn.snapshot', data: snapshot })
        store.cleanupOldEvents(id)
        appends.push(performance.now() - appendStart)
        turnSamples.push({ session: index, turn, counters: numericDelta(counters, store.getDiagnostics()) })
      }
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  delay.disable()
  const result = {
    kind: 'storage-round-reconstruction',
    hotPath: process.env['OPENFOX_SNAPSHOT_HOT_PATH'] !== '0',
    runtime: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    hostMemoryBytes: totalmem(),
    parameters: {
      withoutVision,
      staggered,
      endOfTurnDelaysMs: staggered ? delays : null,
      sizesMB: sizes,
      actualSnapshotBytes: bytes,
      totalBytes: bytes.reduce((a, b) => a + b, 0),
      turnsPerSession: turns,
      roundsPerTurn: rounds,
      sessions: sizes.length,
      warmupRoundsPerSession: 1,
    },
    elapsedMs: performance.now() - started,
    eventLoopDelayMs: {
      p50: delay.percentile(50) / 1e6,
      p95: delay.percentile(95) / 1e6,
      p99: delay.percentile(99) / 1e6,
      max: delay.max / 1e6,
    },
    roundSamples,
    turnSamples,
    roundMs: quantiles(roundTimes),
    snapshotBuildMs: quantiles(builds),
    snapshotAppendAndCleanupMs: quantiles(appends),
    memoryBefore: before,
    memoryAfter: process.memoryUsage(),
    diagnostics: store.getDiagnostics(),
  }
  process.send?.({ done: result })
  await new Promise<void>((resolve) => process.once('message', () => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  process.disconnect?.()
}

async function probe() {
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout?.on('data', (chunk) => process.stderr.write(chunk))
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    process.exitCode = 1
  }, 300000)
  const agent = new Agent({ keepAlive: true, maxSockets: 256 })
  const samples: number[] = []
  let errors = 0,
    interval: ReturnType<typeof setInterval> | undefined
  const pending = new Set<Promise<void>>()
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code) reject(new Error('Benchmark worker exit ' + code))
      else resolve()
    })
    child.on('message', async (message: { ready?: boolean; port?: number; done?: unknown }) => {
      if (message.ready) {
        interval = setInterval(() => {
          const start = performance.now()
          const task = new Promise<void>((done) => {
            const req = get('http://127.0.0.1:' + message.port + '/api/health', { agent }, (res) => {
              res.resume()
              res.once('end', () => {
                samples.push(performance.now() - start)
                done()
              })
              res.once('error', () => {
                errors++
                done()
              })
            })
            req.once('error', () => {
              errors++
              done()
            })
            req.setTimeout(60000, () => req.destroy())
          })
          pending.add(task)
          void task.finally(() => pending.delete(task))
        }, 10)
        child.send('start')
      }
      if (message.done) {
        clearInterval(interval)
        await Promise.all(pending)
        process.stdout.write(
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              measurement: message.done,
              healthMs: quantiles(samples),
              healthErrors: errors,
              limitations: [
                'Synthetic storage and reconstruction workload with the real image processor; fixture has no images or PDFs, no provider generation',
                'Health handler matches the small production JSON response; no production instance is used',
              ],
            },
            null,
            2,
          ) + '\n',
        )
        child.send('stop')
      }
    })
  }).finally(() => {
    clearTimeout(timer)
    clearInterval(interval)
    agent.destroy()
  })
}

if (process.argv.includes('--worker')) await worker()
else await probe()
