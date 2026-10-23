import type {
  DiagnosticsData,
  DiagnosticsSeriesName,
  DiagnosticsSeries,
  StaleWorkerSeries,
} from '../../shared/diagnostics.js'
import type { WorkerToken } from '../session/worker/protocol.js'

interface StoredSnapshot {
  token: WorkerToken
  data: DiagnosticsData
  receivedAt: number
}

export interface HealthAggregatorOptions {
  now?: () => number
  /** A worker snapshot older than this is treated as stale (default 2 report
   *  intervals of the 1 s worker report cadence = 2000 ms). */
  staleAfterMs?: number
}

export interface HealthAggregator {
  recordSnapshot(token: WorkerToken, data: DiagnosticsData): void
  expireWorker(token: WorkerToken): void
  activeSnapshots(): DiagnosticsData[]
  staleSeries(): StaleWorkerSeries[]
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

export function createHealthAggregator(options: HealthAggregatorOptions = {}): HealthAggregator {
  const readClock = options.now ?? Date.now
  const staleAfterMs = options.staleAfterMs ?? 2_000
  const snapshots = new Map<string, StoredSnapshot>()

  function recordSnapshot(token: WorkerToken, data: DiagnosticsData): void {
    snapshots.set(keyFor(token), { token, data, receivedAt: readClock() })
  }

  function expireWorker(token: WorkerToken): void {
    snapshots.delete(keyFor(token))
  }

  function partition(): { fresh: StoredSnapshot[]; stale: StoredSnapshot[] } {
    const cutoff = readClock() - staleAfterMs
    const fresh: StoredSnapshot[] = []
    const stale: StoredSnapshot[] = []
    for (const snapshot of snapshots.values()) {
      if (snapshot.receivedAt >= cutoff) fresh.push(snapshot)
      else stale.push(snapshot)
    }
    return { fresh, stale }
  }

  function activeSnapshots(): DiagnosticsData[] {
    return partition().fresh.map((s) => s.data)
  }

  function staleSeries(): StaleWorkerSeries[] {
    return partition().stale.map((s) => ({
      workerId: s.token.workerId,
      generation: s.token.generation,
      receivedAt: s.receivedAt,
    }))
  }

  function aggregate(gatewayData: DiagnosticsData): DiagnosticsData {
    const { fresh, stale } = partition()
    const workerData = fresh.map((s) => s.data)

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
      staleSeries: stale.map((s) => ({
        workerId: s.token.workerId,
        generation: s.token.generation,
        receivedAt: s.receivedAt,
      })),
    }
  }

  return {
    recordSnapshot,
    expireWorker,
    activeSnapshots,
    staleSeries,
    aggregate,
  }
}
