import { describe, it, expect } from 'vitest'
import { createHealthAggregator } from './aggregator.js'
import type { DiagnosticsData } from '../../shared/diagnostics.js'

function makeData(overrides: Partial<DiagnosticsData['series']> = {}, collectedAt = 1_000): DiagnosticsData {
  return {
    collectedAt,
    intervalMs: 1_000,
    windowMs: 10_000,
    historyMs: 60_000,
    series: {
      eventLoopDelayP50: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 1 },
      eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 5 },
      eventLoopDelayMax: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 10 },
      healthLatencyP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 5, value: 2 },
      eventStoreReadP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 3, value: 1 },
      eventStoreWriteP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 3, value: 1 },
      walSize: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 100 },
      runningSessions: { unit: 'count', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 1 },
      rss: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 50 },
      heapUsed: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 30 },
      ...overrides,
    },
    history: [],
    runtimes: [],
  }
}

describe('worker health series', () => {
  it('uses a live worker series and expires it after crash', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 3 },
    })
    const workerToken = { workerId: 'w1', generation: 1 }

    aggregator.recordSnapshot(
      workerToken,
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 7 } }),
    )

    const live = aggregator.aggregate(gatewayData)
    expect(live.series.eventLoopDelayP99.value).toBe(7)
    expect(aggregator.activeSnapshots()).toHaveLength(1)

    aggregator.expireWorker(workerToken)

    const afterCrash = aggregator.aggregate(gatewayData)
    expect(afterCrash.series.eventLoopDelayP99.value).toBe(3)
    expect(aggregator.activeSnapshots()).toHaveLength(0)
  })

  it('keeps stale generation expired when the same worker restarts with a new generation', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 3 },
    })

    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 1 },
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 7 } }),
    )
    aggregator.expireWorker({ workerId: 'w1', generation: 1 })
    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 2 },
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 9 } }),
    )

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.eventLoopDelayP99.value).toBe(9)
    expect(aggregator.activeSnapshots()).toHaveLength(1)
  })

  it('aggregates series from multiple live workers', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 3 },
    })

    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 1 },
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 7 } }),
    )
    aggregator.recordSnapshot(
      { workerId: 'w2', generation: 1 },
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 12 } }),
    )

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.eventLoopDelayP99.value).toBe(12)
    expect(aggregator.activeSnapshots()).toHaveLength(2)
  })

  it('expires only the crashed worker, not others', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 3 },
    })

    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 1 },
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 7 } }),
    )
    aggregator.recordSnapshot(
      { workerId: 'w2', generation: 1 },
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 12 } }),
    )

    aggregator.expireWorker({ workerId: 'w1', generation: 1 })

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.eventLoopDelayP99.value).toBe(12)
    expect(aggregator.activeSnapshots()).toHaveLength(1)
  })
})
