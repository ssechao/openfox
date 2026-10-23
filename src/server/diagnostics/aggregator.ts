import type { DiagnosticsData, DiagnosticsSeriesName, DiagnosticsSeries } from '../../shared/diagnostics.js'
import type { WorkerToken } from '../session/worker/protocol.js'

interface StoredSnapshot {
  token: WorkerToken
  data: DiagnosticsData
  receivedAt: number
}

export interface HealthAggregator {
  recordSnapshot(token: WorkerToken, data: DiagnosticsData): void
  expireWorker(token: WorkerToken): void
  activeSnapshots(): DiagnosticsData[]
  aggregate(gatewayData: DiagnosticsData): DiagnosticsData
}

const LATENCY_SERIES: DiagnosticsSeriesName[] = [
  'eventLoopDelayP50',
  'eventLoopDelayP99',
  'eventLoopDelayMax',
  'healthLatencyP99',
  'eventStoreReadP99',
  'eventStoreWriteP99',
]

const GAUGE_SERIES: DiagnosticsSeriesName[] = ['rss', 'heapUsed']

const OWNER_ONLY_SERIES: DiagnosticsSeriesName[] = ['walSize', 'runningSessions']

function keyFor(token: WorkerToken): string {
  return `${token.workerId}:${token.generation}`
}

function mergeSeries(
  gatewaySeries: DiagnosticsSeries,
  workerSeries: DiagnosticsSeries[],
  strategy: 'max' | 'sum',
): DiagnosticsSeries {
  const values = [gatewaySeries.value, ...workerSeries.map((s) => s.value)].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  )
  if (values.length === 0) {
    return { ...gatewaySeries, value: null }
  }
  const value = strategy === 'max' ? Math.max(...values) : values.reduce((a, b) => a + b, 0)
  return {
    ...gatewaySeries,
    samples: gatewaySeries.samples + workerSeries.reduce((sum, s) => sum + s.samples, 0),
    value,
  }
}

export function createHealthAggregator(now: () => number = Date.now): HealthAggregator {
  const snapshots = new Map<string, StoredSnapshot>()

  function recordSnapshot(token: WorkerToken, data: DiagnosticsData): void {
    snapshots.set(keyFor(token), { token, data, receivedAt: now() })
  }

  function expireWorker(token: WorkerToken): void {
    snapshots.delete(keyFor(token))
  }

  function activeSnapshots(): DiagnosticsData[] {
    return [...snapshots.values()].map((s) => s.data)
  }

  function aggregate(gatewayData: DiagnosticsData): DiagnosticsData {
    const workerData = activeSnapshots()

    const series = { ...gatewayData.series }

    // Latency percentiles and memory gauges are merged with the max rule
    // (never an average of several p99).
    for (const name of [...LATENCY_SERIES, ...GAUGE_SERIES]) {
      const workerSeries = workerData.map((d) => d.series[name]).filter((s): s is DiagnosticsSeries => !!s)
      series[name] = mergeSeries(gatewayData.series[name], workerSeries, 'max')
    }

    for (const name of OWNER_ONLY_SERIES) {
      // Gateway is the single owner of WAL size and running-sessions count.
      // Workers may send these values, but they are ignored.
      series[name] = gatewayData.series[name]
    }

    return {
      ...gatewayData,
      series,
    }
  }

  return {
    recordSnapshot,
    expireWorker,
    activeSnapshots,
    aggregate,
  }
}
