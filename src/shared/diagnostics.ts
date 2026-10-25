export type DiagnosticsUnit = 'ms' | 'bytes' | 'count'

export interface DiagnosticsSeries {
  unit: DiagnosticsUnit
  window: { startMs: number; endMs: number }
  samples: number
  value: number | null
}

export type DiagnosticsSeriesName =
  | 'eventLoopDelayP50'
  | 'eventLoopDelayP99'
  | 'eventLoopDelayMax'
  | 'healthLatencyP99'
  | 'eventStoreReadP99'
  | 'eventStoreWriteP99'
  | 'walSize'
  | 'runningSessions'
  | 'rss'
  | 'heapUsed'
  | 'snapshotCacheHits'
  | 'snapshotCacheMisses'
  | 'snapshotCacheBytes'
  | 'snapshotCacheEvictions'
  | 'snapshotCacheLimitBytes'

export const DIAGNOSTICS_SERIES_NAMES: readonly DiagnosticsSeriesName[] = [
  'eventLoopDelayP50',
  'eventLoopDelayP99',
  'eventLoopDelayMax',
  'healthLatencyP99',
  'eventStoreReadP99',
  'eventStoreWriteP99',
  'walSize',
  'runningSessions',
  'rss',
  'heapUsed',
  'snapshotCacheHits',
  'snapshotCacheMisses',
  'snapshotCacheBytes',
  'snapshotCacheEvictions',
  'snapshotCacheLimitBytes',
]

export interface DiagnosticsHistoryPoint {
  timestamp: number
  eventLoopDelayMax: number | null
  eventLoopDelayP99: number | null
}

export type RuntimeState = 'idle' | 'running' | 'paused' | 'stopping' | 'compacting' | 'workflow'

export type RuntimeLastCommand = 'launch' | 'stop' | 'pause' | 'resume' | 'answer' | 'workflow' | 'compact'

export interface RuntimeSnapshot {
  sessionId: string
  state: RuntimeState
  lastCommand: RuntimeLastCommand | null
}

/**
 * A worker health series that is no longer counted in the aggregated totals
 * because its worker is dead (crash/shutdown) or its last snapshot is older
 * than the 2500 ms TTL. Exposed for debugging only — it never
 * participates in p50/p99/max or any gauge.
 */
export type WorkerSeriesExpiryReason = 'exit' | 'crash' | 'shutdown' | 'ttl'

export interface StaleWorkerSeries {
  workerId: string
  generation: number
  receivedAt: number
  reason: WorkerSeriesExpiryReason
}

export type WorkerProcessFreshness = 'fresh' | 'stale'

export interface WorkerProcessDiagnostics {
  sessionId: string
  workerId: string
  generation: number
  pid: number
  rss: number | null
  heapUsed: number | null
  series: Record<DiagnosticsSeriesName, DiagnosticsSeries>
  receivedAt: number
  ageMs: number
  freshness: WorkerProcessFreshness
}

export interface DiagnosticsData {
  collectedAt: number
  intervalMs: number
  windowMs: number
  historyMs: number
  series: Record<DiagnosticsSeriesName, DiagnosticsSeries>
  history: DiagnosticsHistoryPoint[]
  runtimes: RuntimeSnapshot[]
  /** Worker series excluded from the aggregated totals (dead or TTL-expired). */
  staleSeries?: StaleWorkerSeries[]
  workerProcesses?: WorkerProcessDiagnostics[]
}
