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

export interface DiagnosticsData {
  collectedAt: number
  intervalMs: number
  windowMs: number
  historyMs: number
  series: Record<DiagnosticsSeriesName, DiagnosticsSeries>
  history: DiagnosticsHistoryPoint[]
}
