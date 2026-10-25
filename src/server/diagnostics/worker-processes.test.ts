import { describe, expect, it } from 'vitest'
import type { DiagnosticsData, DiagnosticsSeriesName } from '../../shared/diagnostics.js'
import { DIAGNOSTICS_SERIES_NAMES } from '../../shared/diagnostics.js'
import { createHealthAggregator } from './aggregator.js'

function makeData(rss: number, heapUsed: number): DiagnosticsData {
  const series = Object.fromEntries(
    DIAGNOSTICS_SERIES_NAMES.map((name: DiagnosticsSeriesName) => [
      name,
      {
        unit: name === 'rss' || name === 'heapUsed' || name.includes('Bytes') ? 'bytes' : 'ms',
        window: { startMs: 0, endMs: 10_000 },
        samples: 1,
        value: name === 'rss' ? rss : name === 'heapUsed' ? heapUsed : 1,
      },
    ]),
  ) as DiagnosticsData['series']
  series.runningSessions.unit = 'count'
  return {
    collectedAt: 10_000,
    intervalMs: 1_000,
    windowMs: 10_000,
    historyMs: 60_000,
    series,
    history: [],
    runtimes: [],
  }
}

describe('worker process diagnostics', () => {
  it('reports fresh and stale worker processes while excluding stale gauges after 2500 ms', () => {
    let clock = 10_000
    const aggregator = createHealthAggregator({ now: () => clock })
    const gateway = makeData(100, 50)

    aggregator.recordSnapshot({ workerId: 'worker-a', generation: 3 }, makeData(300, 150), {
      sessionId: 'session-a',
      pid: 101,
    })
    clock = 11_000
    aggregator.recordSnapshot({ workerId: 'worker-b', generation: 4 }, makeData(400, 200), {
      sessionId: 'session-b',
      pid: 202,
    })

    clock = 12_500
    const boundary = aggregator.aggregate(gateway)
    expect(boundary.series.rss.value).toBe(400)
    expect(boundary.workerProcesses).toEqual([
      {
        sessionId: 'session-a',
        workerId: 'worker-a',
        generation: 3,
        pid: 101,
        rss: 300,
        heapUsed: 150,
        series: makeData(300, 150).series,
        receivedAt: 10_000,
        ageMs: 2_500,
        freshness: 'fresh',
      },
      {
        sessionId: 'session-b',
        workerId: 'worker-b',
        generation: 4,
        pid: 202,
        rss: 400,
        heapUsed: 200,
        series: makeData(400, 200).series,
        receivedAt: 11_000,
        ageMs: 1_500,
        freshness: 'fresh',
      },
    ])

    clock = 12_501
    const stale = aggregator.aggregate(gateway)
    expect(stale.series.rss.value).toBe(400)
    expect(stale.workerProcesses?.[0]).toMatchObject({ ageMs: 2_501, freshness: 'stale' })
    expect(stale.workerProcesses?.[1]).toMatchObject({ ageMs: 1_501, freshness: 'fresh' })
    expect(stale.staleSeries).toEqual([{ workerId: 'worker-a', generation: 3, receivedAt: 10_000, reason: 'ttl' }])
  })

  it.each(['exit', 'crash', 'shutdown'] as const)(
    'retains a worker expired by %s for 10 minutes, then evicts it',
    (reason) => {
      let clock = 10_000
      const aggregator = createHealthAggregator({ now: () => clock })
      const token = { workerId: 'worker-a', generation: 1 }
      aggregator.recordSnapshot(token, makeData(300, 150), { sessionId: 'session-a', pid: 101 })
      aggregator.expireWorker(token, reason)

      expect(aggregator.activeSnapshots()).toEqual([])
      expect(aggregator.aggregate(makeData(100, 50))).toMatchObject({
        staleSeries: [{ workerId: 'worker-a', generation: 1, receivedAt: 10_000, reason }],
        workerProcesses: [
          {
            sessionId: 'session-a',
            workerId: 'worker-a',
            generation: 1,
            freshness: 'stale',
            series: makeData(300, 150).series,
          },
        ],
      })

      clock += 600_001
      expect(aggregator.aggregate(makeData(100, 50))).toMatchObject({ staleSeries: [], workerProcesses: [] })
    },
  )

  it('bounds stale snapshots without diagnostics reads between worker exits', () => {
    let clock = 10_000
    const aggregator = createHealthAggregator({ now: () => clock, maxStaleSeries: 3 })

    for (let generation = 1; generation <= 5; generation++) {
      const token = { workerId: 'worker-a', generation }
      aggregator.recordSnapshot(token, makeData(300 + generation, 150 + generation), {
        sessionId: `session-${generation}`,
        pid: 100 + generation,
      })
      aggregator.expireWorker(token, 'exit')
      clock += 1
    }

    expect(aggregator.retainedSnapshots()).toBe(3)
    const result = aggregator.aggregate(makeData(100, 50))
    expect(result.staleSeries).toEqual([
      { workerId: 'worker-a', generation: 3, receivedAt: 10_002, reason: 'exit' },
      { workerId: 'worker-a', generation: 4, receivedAt: 10_003, reason: 'exit' },
      { workerId: 'worker-a', generation: 5, receivedAt: 10_004, reason: 'exit' },
    ])
    expect(result.workerProcesses).toHaveLength(3)
  })

  it('purges expired retention on the next write without a diagnostics read', () => {
    let clock = 10_000
    const aggregator = createHealthAggregator({ now: () => clock })
    const expired = { workerId: 'worker-a', generation: 1 }
    aggregator.recordSnapshot(expired, makeData(300, 150), { sessionId: 'session-a', pid: 101 })
    aggregator.expireWorker(expired, 'exit')

    clock += 600_001
    aggregator.recordSnapshot({ workerId: 'worker-b', generation: 1 }, makeData(400, 200), {
      sessionId: 'session-b',
      pid: 202,
    })

    expect(aggregator.retainedSnapshots()).toBe(1)
  })
})
