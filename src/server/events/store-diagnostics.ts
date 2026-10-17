import { performance } from 'node:perf_hooks'

export type StoreTiming =
  'snapshotStringify' | 'snapshotAppend' | 'snapshotBuild' | 'snapshotCacheInstall' | 'dataVersion'
export interface TimingTotal {
  count: number
  totalMs: number
  maxMs: number
}
export interface StoreDiagnostics {
  replayPrefixes: { entries: number; events: number; serializedBytes: number }
  fullReads: number
  snapshotParses: number
  snapshotParsedBytes: number
  snapshotCacheHits: number
  snapshotCacheMisses: number
  cacheMemory: {
    samples: number
    heapDeltaBytes: number
    rssDeltaBytes: number
    maxHeapDeltaBytes: number
    maxRssDeltaBytes: number
  }
  timings: Record<StoreTiming, TimingTotal>
}

export function emptyStoreDiagnostics(): StoreDiagnostics {
  const timing = (): TimingTotal => ({ count: 0, totalMs: 0, maxMs: 0 })
  return {
    replayPrefixes: { entries: 0, events: 0, serializedBytes: 0 },
    fullReads: 0,
    snapshotParses: 0,
    snapshotParsedBytes: 0,
    snapshotCacheHits: 0,
    snapshotCacheMisses: 0,
    cacheMemory: { samples: 0, heapDeltaBytes: 0, rssDeltaBytes: 0, maxHeapDeltaBytes: 0, maxRssDeltaBytes: 0 },
    timings: {
      snapshotStringify: timing(),
      snapshotAppend: timing(),
      snapshotBuild: timing(),
      snapshotCacheInstall: timing(),
      dataVersion: timing(),
    },
  }
}

export function measureStoreOperation<T>(
  diagnostics: StoreDiagnostics | null,
  operation: StoreTiming,
  work: () => T,
): T {
  if (!diagnostics) return work()
  const memory = operation === 'snapshotCacheInstall' ? process.memoryUsage() : null
  const started = performance.now()
  try {
    return work()
  } finally {
    const elapsed = performance.now() - started
    const timing = diagnostics.timings[operation]
    timing.count++
    timing.totalMs += elapsed
    timing.maxMs = Math.max(timing.maxMs, elapsed)
    if (memory) {
      const after = process.memoryUsage()
      const stats = diagnostics.cacheMemory
      const heap = after.heapUsed - memory.heapUsed,
        rss = after.rss - memory.rss
      stats.samples++
      stats.heapDeltaBytes += heap
      stats.rssDeltaBytes += rss
      stats.maxHeapDeltaBytes = Math.max(stats.maxHeapDeltaBytes, heap)
      stats.maxRssDeltaBytes = Math.max(stats.maxRssDeltaBytes, rss)
    }
  }
}
