/**
 * Frame-timing statistics for the web memory benchmark.
 *
 * The page runs a `requestAnimationFrame` sampler; each callback timestamp is
 * one rendered frame. When the main thread is blocked, callbacks are delayed
 * rather than skipped, so the gaps between timestamps are what expose jank.
 */

/** A frame longer than this counts as jank (two dropped frames at 60Hz). */
export const LONG_FRAME_MS = 50

export interface FrameStats {
  /** rAF callbacks observed in the window. */
  frames: number
  /** Wall time spanned by the window, in ms. */
  windowMs: number
  /** Frames per second across the window (0 when fewer than two frames). */
  fps: number
  /** 95th percentile inter-frame gap, in ms. */
  p95FrameMs: number
  /** Longest inter-frame gap, in ms. */
  worstFrameMs: number
  /** Number of gaps longer than LONG_FRAME_MS. */
  longFrames: number
}

export const EMPTY_FRAME_STATS: FrameStats = {
  frames: 0,
  windowMs: 0,
  fps: 0,
  p95FrameMs: 0,
  worstFrameMs: 0,
  longFrames: 0,
}

export function frameDeltas(timestamps: number[]): number[] {
  const deltas: number[] = []
  for (let index = 1; index < timestamps.length; index++) {
    deltas.push((timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0))
  }
  return deltas
}

export function summarizeFrames(timestamps: number[]): FrameStats {
  const first = timestamps[0]
  const last = timestamps[timestamps.length - 1]
  if (first === undefined || last === undefined || timestamps.length < 2) {
    return { ...EMPTY_FRAME_STATS, frames: timestamps.length }
  }

  const deltas = frameDeltas(timestamps)
  const windowMs = last - first
  const sorted = [...deltas].sort((a, b) => a - b)
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)

  return {
    frames: timestamps.length,
    windowMs: Math.round(windowMs),
    fps: windowMs > 0 ? Number((((timestamps.length - 1) * 1000) / windowMs).toFixed(1)) : 0,
    p95FrameMs: Number((sorted[Math.max(0, p95Index)] ?? 0).toFixed(1)),
    worstFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    longFrames: deltas.filter((delta) => delta > LONG_FRAME_MS).length,
  }
}
