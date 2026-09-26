import { describe, expect, it } from 'vitest'
import { EMPTY_FRAME_STATS, LONG_FRAME_MS, frameDeltas, summarizeFrames } from './frames.js'

/** Timestamps at a steady 60Hz for `count` frames. */
function steady(count: number, intervalMs = 1000 / 60): number[] {
  return Array.from({ length: count }, (_, index) => index * intervalMs)
}

describe('frameDeltas', () => {
  it('returns the gap between consecutive frames', () => {
    expect(frameDeltas([0, 16, 32, 64])).toEqual([16, 16, 32])
  })

  it('is empty for fewer than two frames', () => {
    expect(frameDeltas([])).toEqual([])
    expect(frameDeltas([10])).toEqual([])
  })
})

describe('summarizeFrames', () => {
  it('reports an empty window when there is nothing to measure', () => {
    expect(summarizeFrames([])).toEqual({ ...EMPTY_FRAME_STATS, frames: 0 })
    expect(summarizeFrames([5])).toEqual({ ...EMPTY_FRAME_STATS, frames: 1 })
  })

  it('derives fps from the frame count and the spanned window', () => {
    const stats = summarizeFrames(steady(61))
    expect(stats.frames).toBe(61)
    expect(stats.windowMs).toBe(1000)
    expect(stats.fps).toBeCloseTo(60, 1)
    expect(stats.longFrames).toBe(0)
  })

  it('reflects a stalled main thread as a low fps and a long frame', () => {
    // 10 steady frames, then a 900ms stall, then 10 more.
    const stalled = [
      ...steady(10),
      150 + 900,
      ...steady(11)
        .slice(1)
        .map((t) => t + 1050),
    ]
    const stats = summarizeFrames(stalled)
    expect(stats.worstFrameMs).toBeGreaterThanOrEqual(900)
    expect(stats.longFrames).toBe(1)
    expect(stats.fps).toBeLessThan(30)
  })

  it('counts every gap over the long-frame threshold', () => {
    const timestamps = [0, 16, 16 + LONG_FRAME_MS + 1, 16 + LONG_FRAME_MS + 17, 16 + 2 * LONG_FRAME_MS + 20]
    expect(summarizeFrames(timestamps).longFrames).toBe(2)
  })

  it('reports a p95 frame time that ignores the outlier', () => {
    const timestamps = [...steady(100), 1650 + 800]
    const stats = summarizeFrames(timestamps)
    expect(stats.p95FrameMs).toBeCloseTo(16.7, 0)
    expect(stats.worstFrameMs).toBeCloseTo(800, 0)
  })

  it('never divides by a zero-width window', () => {
    const stats = summarizeFrames([100, 100])
    expect(stats.fps).toBe(0)
    expect(stats.windowMs).toBe(0)
  })
})
