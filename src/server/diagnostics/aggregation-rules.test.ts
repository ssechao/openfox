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
      snapshotCacheHits: { unit: 'count', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 0 },
      snapshotCacheMisses: { unit: 'count', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 0 },
      snapshotCacheBytes: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 0 },
      snapshotCacheEvictions: { unit: 'count', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 0 },
      snapshotCacheLimitBytes: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 0 },
      ...overrides,
    },
    history: [],
    runtimes: [],
  }
}

describe('aggregation rules', () => {
  it('takes the max of p99 values from multiple workers, not the average', () => {
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
      makeData({ eventLoopDelayP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 9 } }),
    )

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.eventLoopDelayP99.value).toBe(9)
    // Average would be (3 + 7 + 9) / 3 = 6.33...
    expect(result.series.eventLoopDelayP99.value).not.toBeCloseTo(6.33, 1)
  })

  it('counts WAL size only from the gateway owner', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      walSize: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 100 },
    })

    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 1 },
      makeData({ walSize: { unit: 'bytes', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 999 } }),
    )

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.walSize.value).toBe(100)
  })

  it('counts running sessions only from the gateway owner', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      runningSessions: { unit: 'count', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 3 },
    })

    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 1 },
      makeData({ runningSessions: { unit: 'count', window: { startMs: 0, endMs: 10_000 }, samples: 1, value: 99 } }),
    )

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.runningSessions.value).toBe(3)
  })

  it('applies max rule to all latency percentiles', () => {
    const aggregator = createHealthAggregator()
    const gatewayData = makeData({
      eventLoopDelayP50: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 1 },
      eventLoopDelayMax: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 5 },
      healthLatencyP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 5, value: 2 },
    })

    aggregator.recordSnapshot(
      { workerId: 'w1', generation: 1 },
      makeData({
        eventLoopDelayP50: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 4 },
        eventLoopDelayMax: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 10, value: 15 },
        healthLatencyP99: { unit: 'ms', window: { startMs: 0, endMs: 10_000 }, samples: 5, value: 8 },
      }),
    )

    const result = aggregator.aggregate(gatewayData)
    expect(result.series.eventLoopDelayP50.value).toBe(4)
    expect(result.series.eventLoopDelayMax.value).toBe(15)
    expect(result.series.healthLatencyP99.value).toBe(8)
  })
})
