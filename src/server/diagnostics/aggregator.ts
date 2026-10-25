import type {
  DiagnosticsData,
  DiagnosticsSeriesName,
  DiagnosticsSeries,
  StaleWorkerSeries,
  WorkerProcessDiagnostics,
  WorkerSeriesExpiryReason,
} from '../../shared/diagnostics.js'
import type { WorkerToken } from '../session/worker/protocol.js'

interface WorkerProcessOwner {
  sessionId: string
  pid: number
}

interface StoredSnapshot {
  token: WorkerToken
  data: DiagnosticsData
  receivedAt: number
  owner?: WorkerProcessOwner
  expiredAt?: number
  expiryReason?: Exclude<WorkerSeriesExpiryReason, 'ttl'>
}

export interface HealthAggregatorOptions {
  now?: () => number
  /** A worker snapshot older than this is treated as stale (default 2500 ms). */
  staleAfterMs?: number
  staleRetentionMs?: number
  maxStaleSeries?: number
}

export interface HealthAggregator {
  recordSnapshot(token: WorkerToken, data: DiagnosticsData, owner?: WorkerProcessOwner): void
  expireWorker(token: WorkerToken, reason: Exclude<WorkerSeriesExpiryReason, 'ttl'>): void
  activeSnapshots(): DiagnosticsData[]
  staleSeries(): StaleWorkerSeries[]
  retainedSnapshots(): number
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
  const staleAfterMs = options.staleAfterMs ?? 2_500
  const staleRetentionMs = options.staleRetentionMs ?? 600_000
  const maxStaleSeries = Math.max(0, Math.floor(options.maxStaleSeries ?? 1_000))
  const snapshots = new Map<string, StoredSnapshot>()

  function isStale(snapshot: StoredSnapshot, now: number): boolean {
    return snapshot.expiryReason !== undefined || now - snapshot.receivedAt > staleAfterMs
  }

  function staleAt(snapshot: StoredSnapshot): number {
    return snapshot.expiredAt ?? snapshot.receivedAt + staleAfterMs
  }

  function prune(now: number): void {
    const retainedStale: Array<{ key: string; staleAt: number }> = []
    for (const [key, snapshot] of snapshots) {
      if (!isStale(snapshot, now)) continue
      const since = staleAt(snapshot)
      if (now - since > staleRetentionMs) snapshots.delete(key)
      else retainedStale.push({ key, staleAt: since })
    }

    const excess = retainedStale.length - maxStaleSeries
    if (excess <= 0) return
    retainedStale.sort((a, b) => a.staleAt - b.staleAt)
    for (const { key } of retainedStale.slice(0, excess)) snapshots.delete(key)
  }

  function recordSnapshot(token: WorkerToken, data: DiagnosticsData, owner?: WorkerProcessOwner): void {
    const now = readClock()
    prune(now)
    snapshots.set(keyFor(token), { token, data, receivedAt: now, ...(owner ? { owner } : {}) })
  }

  function expireWorker(token: WorkerToken, reason: Exclude<WorkerSeriesExpiryReason, 'ttl'>): void {
    const now = readClock()
    const snapshot = snapshots.get(keyFor(token))
    if (snapshot && !snapshot.expiryReason) {
      snapshot.expiredAt = now
      snapshot.expiryReason = reason
    }
    prune(now)
  }

  function partition(now = readClock()): { fresh: StoredSnapshot[]; stale: StoredSnapshot[] } {
    prune(now)
    const fresh: StoredSnapshot[] = []
    const stale: StoredSnapshot[] = []
    for (const snapshot of snapshots.values()) {
      if (isStale(snapshot, now)) stale.push(snapshot)
      else fresh.push(snapshot)
    }
    return { fresh, stale }
  }

  function activeSnapshots(): DiagnosticsData[] {
    return partition().fresh.map((s) => s.data)
  }

  function staleEntry(snapshot: StoredSnapshot): StaleWorkerSeries {
    return {
      workerId: snapshot.token.workerId,
      generation: snapshot.token.generation,
      receivedAt: snapshot.receivedAt,
      reason: snapshot.expiryReason ?? 'ttl',
    }
  }

  function staleSeries(): StaleWorkerSeries[] {
    return partition().stale.map(staleEntry)
  }

  function processSnapshot(snapshot: StoredSnapshot, now: number): WorkerProcessDiagnostics | null {
    if (!snapshot.owner) return null
    const ageMs = Math.max(0, now - snapshot.receivedAt)
    return {
      sessionId: snapshot.owner.sessionId,
      workerId: snapshot.token.workerId,
      generation: snapshot.token.generation,
      pid: snapshot.owner.pid,
      rss: snapshot.data.series.rss.value,
      heapUsed: snapshot.data.series.heapUsed.value,
      series: snapshot.data.series,
      receivedAt: snapshot.receivedAt,
      ageMs,
      freshness: snapshot.expiryReason === undefined && ageMs <= staleAfterMs ? 'fresh' : 'stale',
    }
  }

  function aggregate(gatewayData: DiagnosticsData): DiagnosticsData {
    const now = readClock()
    const { fresh, stale } = partition(now)
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
      staleSeries: stale.map(staleEntry),
      workerProcesses: [...snapshots.values()].flatMap((snapshot) => {
        const process = processSnapshot(snapshot, now)
        return process ? [process] : []
      }),
    }
  }

  return {
    recordSnapshot,
    expireWorker,
    activeSnapshots,
    staleSeries,
    retainedSnapshots: () => snapshots.size,
    aggregate,
  }
}
