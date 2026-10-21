const BASE_MS = 0.01
const GROWTH = 1.05
const LOG_GROWTH = Math.log(GROWTH)
export const HISTOGRAM_BINS = 360

function binIndex(ms: number): number {
  if (ms <= BASE_MS) return 0
  return Math.min(HISTOGRAM_BINS - 1, Math.ceil(Math.log(ms / BASE_MS) / LOG_GROWTH))
}

function binUpperBound(index: number): number {
  return BASE_MS * GROWTH ** index
}

export class LatencyHistogram {
  readonly counts = new Uint32Array(HISTOGRAM_BINS)
  count = 0
  min = Number.POSITIVE_INFINITY
  max = 0

  record(ms: number): void {
    const value = Number.isFinite(ms) && ms > 0 ? ms : 0
    this.counts[binIndex(value)]!++
    this.count++
    if (value < this.min) this.min = value
    if (value > this.max) this.max = value
  }
}

export function mergedMax(histograms: LatencyHistogram[]): number | null {
  let max: number | null = null
  for (const histogram of histograms) {
    if (histogram.count > 0 && (max === null || histogram.max > max)) max = histogram.max
  }
  return max
}

export function mergedCount(histograms: LatencyHistogram[]): number {
  return histograms.reduce((total, histogram) => total + histogram.count, 0)
}

export function mergedPercentile(histograms: LatencyHistogram[], percentile: number): number | null {
  const total = mergedCount(histograms)
  if (total === 0) return null
  const rank = Math.max(1, Math.ceil(percentile * total))
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (const histogram of histograms) {
    if (histogram.count === 0) continue
    min = Math.min(min, histogram.min)
    max = Math.max(max, histogram.max)
  }
  let cumulative = 0
  for (let index = 0; index < HISTOGRAM_BINS; index++) {
    for (const histogram of histograms) cumulative += histogram.counts[index]!
    if (cumulative >= rank) return Math.min(max, Math.max(min, binUpperBound(index)))
  }
  return max
}
