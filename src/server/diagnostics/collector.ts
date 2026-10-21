import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import type {
  DiagnosticsData,
  DiagnosticsHistoryPoint,
  DiagnosticsSeries,
  DiagnosticsUnit,
} from '../../shared/diagnostics.js'
import type { DiagnosticsCollector } from './types.js'
import { LatencyHistogram, mergedCount, mergedMax, mergedPercentile } from './histogram.js'

type LatencyMetric = 'loop' | 'health' | 'read' | 'write'
type GaugeMetric = 'walSize' | 'runningSessions' | 'rss' | 'heapUsed'

interface Bucket {
  startMs: number
  latencies: Partial<Record<LatencyMetric, LatencyHistogram>>
  gauges: Partial<Record<GaugeMetric, number>>
}

export interface CollectorOptions {
  countRunningSessions?: () => number
  dbPath?: string
  intervalMs?: number
  windowMs?: number
  historyMs?: number
  loopSampleMs?: number
  enableLoopSampler?: boolean
}

function walSizeBytes(dbPath: string | undefined): number | undefined {
  if (!dbPath || dbPath === ':memory:') return undefined
  try {
    return statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

/**
 * Single owner of the health metrics. Observations land in one bucket per
 * fixed interval (wall-clock aligned), each holding mergeable histograms, so
 * window statistics sum bin counts across buckets instead of averaging
 * per-interval percentiles. Buckets are keyed by their start time and expire by
 * elapsed time; at most `historyMs / intervalMs` of them are ever kept. Readers
 * never mutate state.
 */
export function createDiagnosticsCollector(options: CollectorOptions = {}): DiagnosticsCollector {
  const intervalMs = options.intervalMs ?? 1_000
  const windowMs = options.windowMs ?? 10_000
  const historyMs = options.historyMs ?? 60_000
  const loopSampleMs = options.loopSampleMs ?? 20
  const enableLoopSampler = options.enableLoopSampler ?? true
  const historySlots = Math.max(1, Math.round(historyMs / intervalMs))
  const windowSlots = Math.max(1, Math.round(windowMs / intervalMs))

  const buckets: Bucket[] = []
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let loopTimer: ReturnType<typeof setTimeout> | null = null

  function slotStart(now: number): number {
    return Math.floor(now / intervalMs) * intervalMs
  }

  function currentBucket(): Bucket {
    const start = slotStart(Date.now())
    const last = buckets[buckets.length - 1]
    if (last && last.startMs === start) return last
    const oldest = start - (historySlots - 1) * intervalMs
    while (buckets.length > 0 && buckets[0]!.startMs < oldest) buckets.shift()
    const bucket: Bucket = { startMs: start, latencies: {}, gauges: {} }
    buckets.push(bucket)
    return bucket
  }

  function record(metric: LatencyMetric, ms: number): void {
    const bucket = currentBucket()
    let histogram = bucket.latencies[metric]
    if (!histogram) {
      histogram = new LatencyHistogram()
      bucket.latencies[metric] = histogram
    }
    histogram.record(ms)
  }

  function sampleGauges(): void {
    const bucket = currentBucket()
    const memory = process.memoryUsage()
    bucket.gauges.rss = memory.rss
    bucket.gauges.heapUsed = memory.heapUsed
    const wal = walSizeBytes(options.dbPath)
    if (wal !== undefined) bucket.gauges.walSize = wal
    if (options.countRunningSessions) {
      try {
        bucket.gauges.runningSessions = options.countRunningSessions()
      } catch {
        // Database unavailable (shutdown): leave the gauge empty for this interval.
      }
    }
  }

  // Event-loop delay is sampled with a timer, not monitorEventLoopDelay: every
  // `loopSampleMs` (20 ms by default) a setTimeout records how late it fired
  // (actual minus scheduled time). Resolution is therefore ~`loopSampleMs`; a
  // stall of B ms yields one sample of about B ms. This is the reference method
  // for the multithread demos; its figures are not the API latencies of the
  // stream bench (e.g. the p99 of GET /api/sessions/:id).
  function scheduleLoopSample(): void {
    const expected = performance.now() + loopSampleMs
    loopTimer = setTimeout(() => {
      record('loop', Math.max(0, performance.now() - expected))
      scheduleLoopSample()
    }, loopSampleMs)
    loopTimer.unref()
  }

  function getData(): DiagnosticsData {
    const now = Date.now()
    const lastSlot = slotStart(now)
    const windowStart = lastSlot - windowSlots * intervalMs
    const window = { startMs: windowStart, endMs: now }
    const recent = buckets.filter((bucket) => bucket.startMs >= windowStart && bucket.startMs <= lastSlot)
    const histograms = (metric: LatencyMetric) =>
      recent.flatMap((bucket) => (bucket.latencies[metric] ? [bucket.latencies[metric]] : []))

    const latency = (metric: LatencyMetric, value: (h: LatencyHistogram[]) => number | null): DiagnosticsSeries => {
      const selected = histograms(metric)
      return { unit: 'ms', window, samples: mergedCount(selected), value: value(selected) }
    }
    const gauge = (metric: GaugeMetric, unit: DiagnosticsUnit): DiagnosticsSeries => {
      const values = recent.flatMap((bucket) => (bucket.gauges[metric] !== undefined ? [bucket.gauges[metric]] : []))
      return { unit, window, samples: values.length, value: values.at(-1) ?? null }
    }

    const byStart = new Map(buckets.map((bucket) => [bucket.startMs, bucket]))
    const history: DiagnosticsHistoryPoint[] = []
    for (let index = historySlots - 1; index >= 0; index--) {
      const timestamp = lastSlot - index * intervalMs
      const loop = byStart.get(timestamp)?.latencies.loop
      history.push({
        timestamp,
        eventLoopDelayMax: loop ? mergedMax([loop]) : null,
        eventLoopDelayP99: loop ? mergedPercentile([loop], 0.99) : null,
      })
    }

    return {
      collectedAt: now,
      intervalMs,
      windowMs,
      historyMs,
      series: {
        eventLoopDelayP50: latency('loop', (h) => mergedPercentile(h, 0.5)),
        eventLoopDelayP99: latency('loop', (h) => mergedPercentile(h, 0.99)),
        eventLoopDelayMax: latency('loop', mergedMax),
        healthLatencyP99: latency('health', (h) => mergedPercentile(h, 0.99)),
        eventStoreReadP99: latency('read', (h) => mergedPercentile(h, 0.99)),
        eventStoreWriteP99: latency('write', (h) => mergedPercentile(h, 0.99)),
        walSize: gauge('walSize', 'bytes'),
        runningSessions: gauge('runningSessions', 'count'),
        rss: gauge('rss', 'bytes'),
        heapUsed: gauge('heapUsed', 'bytes'),
      },
      history,
    }
  }

  return {
    start() {
      if (tickTimer) return
      sampleGauges()
      tickTimer = setInterval(sampleGauges, intervalMs)
      tickTimer.unref()
      if (enableLoopSampler) scheduleLoopSample()
    },
    stop() {
      if (tickTimer) clearInterval(tickTimer)
      if (loopTimer) clearTimeout(loopTimer)
      tickTimer = null
      loopTimer = null
    },
    recordEventLoopDelay: (ms) => record('loop', ms),
    recordHealthLatency: (ms) => record('health', ms),
    recordRead: (ms) => record('read', ms),
    recordWrite: (ms) => record('write', ms),
    getData,
  }
}
