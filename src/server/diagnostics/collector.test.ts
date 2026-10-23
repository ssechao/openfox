import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createDiagnosticsCollector } from './collector.js'
import type { DiagnosticsCollector } from './types.js'
import { SessionRuntimeRegistry } from '../session/runtime.js'

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0)

describe('diagnostics collector', () => {
  let collector: DiagnosticsCollector

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    collector = createDiagnosticsCollector({
      now: () => Date.now(),
      countRunningSessions: () => 3,
      intervalMs: 1_000,
      windowMs: 10_000,
      historyMs: 60_000,
      enableLoopSampler: false,
    })
  })

  afterEach(() => {
    collector.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const series = () => collector.getData().series

  it('reports null values with zero samples when nothing was recorded', () => {
    const data = series()
    expect(data.eventLoopDelayP99).toMatchObject({ unit: 'ms', samples: 0, value: null })
    expect(data.healthLatencyP99.value).toBeNull()
    expect(data.eventStoreReadP99.value).toBeNull()
    expect(data.eventStoreWriteP99.value).toBeNull()
    expect(data.runningSessions.value).toBeNull()
  })

  it('computes percentiles and max from the recorded observations', () => {
    for (let ms = 1; ms <= 100; ms++) collector.recordEventLoopDelay(ms)
    const data = series()
    expect(data.eventLoopDelayP50.samples).toBe(100)
    expect(data.eventLoopDelayP50.value).toBeGreaterThanOrEqual(50)
    expect(data.eventLoopDelayP50.value).toBeLessThanOrEqual(50 * 1.05)
    expect(data.eventLoopDelayP99.value).toBeGreaterThanOrEqual(99)
    expect(data.eventLoopDelayP99.value).toBeLessThanOrEqual(100)
    expect(data.eventLoopDelayMax.value).toBe(100)
  })

  it('merges intervals by summing counts, not by averaging per-interval percentiles', () => {
    for (let i = 0; i < 1000; i++) collector.recordEventLoopDelay(1)
    vi.setSystemTime(T0 + 1_000)
    for (let i = 0; i < 10; i++) collector.recordEventLoopDelay(500)
    const p99 = series().eventLoopDelayP99.value!
    expect(p99).toBeGreaterThanOrEqual(1)
    expect(p99).toBeLessThan(1.1)
    expect(series().eventLoopDelayMax.value).toBe(500)
    expect(series().eventLoopDelayP99.samples).toBe(1010)
  })

  it('expires intervals by elapsed time even when no tick ran in between', () => {
    collector.recordHealthLatency(42)
    expect(series().healthLatencyP99.value).toBe(42)
    vi.setSystemTime(T0 + 11_000)
    expect(series().healthLatencyP99).toMatchObject({ samples: 0, value: null })
  })

  it('goes back to rest once a spike leaves the window', () => {
    collector.recordEventLoopDelay(800)
    for (let s = 1; s <= 12; s++) {
      vi.setSystemTime(T0 + s * 1_000)
      for (let i = 0; i < 100; i++) collector.recordEventLoopDelay(2)
    }
    expect(series().eventLoopDelayMax.value).toBe(2)
    expect(series().eventLoopDelayP99.value).toBeLessThanOrEqual(2)
  })

  it('reports the window bounds on every series', () => {
    collector.recordRead(5)
    const { window } = series().eventStoreReadP99
    expect(window).toEqual({ startMs: T0 - 10_000, endMs: T0 })
  })

  it('separates EventStore reads from writes', () => {
    collector.recordRead(2)
    collector.recordRead(8)
    collector.recordWrite(20)
    expect(series().eventStoreReadP99.value).toBe(8)
    expect(series().eventStoreWriteP99.value).toBe(20)
  })

  it('samples memory and running sessions as gauges', () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 100,
      heapTotal: 200,
      heapUsed: 50,
      external: 0,
      arrayBuffers: 0,
    })
    collector.start()
    vi.advanceTimersByTime(2_000)
    const data = series()
    expect(data.rss).toMatchObject({ unit: 'bytes', value: 100 })
    expect(data.heapUsed.value).toBe(50)
    expect(data.runningSessions).toMatchObject({ unit: 'count', value: 3 })
    expect(data.runningSessions.samples).toBeGreaterThanOrEqual(2)
  })

  it('sources runningSessions from the runtime registry (the owner), not the EventStore count', () => {
    const registry = new SessionRuntimeRegistry()
    // Two active runtimes (chat + workflow) and one idle one.
    registry.get('sess-active-1').acquire('chat')
    registry.get('sess-active-2').acquire('workflow')
    const idleHandle = registry.get('sess-idle').acquire('chat')
    registry.get('sess-idle').release(idleHandle)

    const registryCollector = createDiagnosticsCollector({
      now: () => Date.now(),
      countRunningSessions: () => 99, // EventStore fallback — must be ignored
      runtimeRegistry: registry,
      intervalMs: 1_000,
      windowMs: 10_000,
      historyMs: 60_000,
      enableLoopSampler: false,
    })
    registryCollector.start()
    vi.advanceTimersByTime(1_000)
    const data = registryCollector.getData()
    // The registry (owner) reports 2 active, not the EventStore's 99.
    expect(data.series.runningSessions).toMatchObject({ unit: 'count', value: 2 })
    registryCollector.stop()
  })

  it('measures a real event-loop stall with its own sampler', async () => {
    vi.useRealTimers()
    const live = createDiagnosticsCollector({ loopSampleMs: 10 })
    live.start()
    await new Promise((done) => setTimeout(done, 30))
    const until = performance.now() + 150
    while (performance.now() < until) {
      // Busy-wait: hold the event loop for 150 ms.
    }
    await new Promise((done) => setTimeout(done, 30))
    live.stop()
    expect(live.getData().series.eventLoopDelayMax.value).toBeGreaterThanOrEqual(150 * 0.8)
  })

  it('stays bounded and coherent when the injected clock goes backwards', () => {
    let clock = T0
    const jumpy = createDiagnosticsCollector({ now: () => clock, enableLoopSampler: false })
    for (let s = 0; s < 90; s++) {
      clock = T0 + s * 1_000
      jumpy.recordEventLoopDelay(1)
    }
    for (let s = 0; s < 90; s++) {
      clock = T0 - 3_600_000 + s * 1_000
      jumpy.recordEventLoopDelay(7)
    }
    expect(jumpy.retainedIntervals()).toBeLessThanOrEqual(60)
    const { series, history } = jumpy.getData()
    expect(series.eventLoopDelayMax).toMatchObject({ samples: 101, value: 7 })
    expect(series.eventLoopDelayP50.value).toBe(7)
    expect(history).toHaveLength(60)
    expect(history.at(-1)!.timestamp).toBe(T0 + 89_000)
  })

  it('keeps a fixed 60-slot history and bounded memory over a long run', () => {
    collector.start()
    for (let s = 0; s < 300; s++) {
      collector.recordEventLoopDelay(s % 7)
      vi.advanceTimersByTime(1_000)
    }
    const { history } = collector.getData()
    expect(history).toHaveLength(60)
    expect(history.at(-1)!.timestamp - history[0]!.timestamp).toBe(59_000)
    expect(history.filter((point) => point.eventLoopDelayMax !== null).length).toBeLessThanOrEqual(60)
  })
})
