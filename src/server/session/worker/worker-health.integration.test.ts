import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../../../shared/types.js'
import type { WorkerToGatewayMessage } from './protocol.js'
import { createHealthAggregator } from '../../diagnostics/aggregator.js'
import { initChildrenTracking } from './children.js'

const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session worker health', () => {
  it('emits health from the worker and includes it in the aggregate', async () => {
    const root = join(tmpdir(), `openfox-worker-health-${randomUUID()}`)
    roots.push(root)
    await mkdir(root, { recursive: true })
    const childrenPath = join(root, 'worker.children')
    initChildrenTracking(childrenPath)

    const token = { workerId: randomUUID(), generation: 1 }
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 1000, idleTimeout: 1000 },
      context: { maxTokens: 1000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 1, maxConsecutiveFailures: 1, toolTimeout: 1000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(root, 'sessions.db') },
      logging: { level: 'error' },
      workdir: root,
      globalConfigPath: join(root, 'config.json'),
    }

    const child = fork(join(here, 'child.ts'), [], {
      execArgv: ['--import', 'tsx/esm'],
      env: {
        ...process.env,
        OPENFOX_MOCK_LLM: 'true',
        OPENFOX_WORKER_ID: token.workerId,
        OPENFOX_WORKER_GENERATION: String(token.generation),
        OPENFOX_WORKER_DB_PATH: config.database.path,
        OPENFOX_WORKER_CHILDREN: childrenPath,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    children.push(child)

    const health = await new Promise<Extract<WorkerToGatewayMessage, { type: 'health' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for worker health')), 10_000)
      child.on('message', (raw) => {
        const message = raw as WorkerToGatewayMessage
        if (message.type === 'ready') {
          child.send({ ...token, type: 'start', sessionId: 'missing-session', config })
        } else if (message.type === 'health') {
          clearTimeout(timer)
          resolve(message)
        }
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`worker exited before health: code=${code} signal=${signal}`))
      })
      child.once('error', reject)
    })

    expect(health.workerId).toBe(token.workerId)
    expect(health.generation).toBe(token.generation)
    expect(health.data.series.rss.value).toBeGreaterThan(0)

    const aggregator = createHealthAggregator()
    aggregator.recordSnapshot(token, health.data)
    const aggregate = aggregator.aggregate(health.data)
    expect(aggregate.series.rss.samples).toBe(health.data.series.rss.samples * 2)
    expect(aggregate.series.rss.value).toBe(health.data.series.rss.value)
    expect(aggregator.activeSnapshots()).toEqual([health.data])
  }, 20_000)
})
