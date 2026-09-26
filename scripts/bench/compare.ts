/**
 * Baseline-vs-run comparison helpers for the web memory benchmark.
 *
 * Pure on purpose: the benchmark extracts numbers, this decides whether a
 * change is a win, a loss, or noise.
 */

export type Verdict = 'better' | 'worse' | 'same'

/** Changes smaller than this are treated as run-to-run noise, not regressions. */
export const NOISE_PCT = 3

/**
 * Relative change from `before` to `after`, in percent.
 * `null` when there is nothing to compare against or the baseline is zero.
 */
export function deltaPct(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null
  return ((after - before) / Math.abs(before)) * 100
}

export function verdict(
  before: number | null,
  after: number | null,
  higherIsBetter: boolean,
  noisePct = NOISE_PCT,
): Verdict {
  const delta = deltaPct(before, after)
  if (delta === null || Math.abs(delta) < noisePct) return 'same'
  const improved = higherIsBetter ? delta > 0 : delta < 0
  return improved ? 'better' : 'worse'
}

/** Signed percentage for display, e.g. `-42.3%`. */
export function formatDelta(delta: number | null): string {
  if (delta === null) return 'n/a'
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`
}
