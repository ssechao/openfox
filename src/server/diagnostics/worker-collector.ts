import { createDiagnosticsCollector } from './collector.js'
import type { DiagnosticsData } from '../../shared/diagnostics.js'
import type { DiagnosticsCollector } from './types.js'

export interface WorkerDiagnosticsCollector {
  start(send: (data: DiagnosticsData) => void): void
  stop(): void
  collector: DiagnosticsCollector
}

/**
 * Worker-side health series (étape 6b). Collects event-loop delay and memory
 * gauges inside the worker process and emits a `DiagnosticsData` snapshot on a
 * fixed interval. The caller (the worker entry) attaches the (workerId,
 * generation) token and forwards each snapshot to the gateway over IPC.
 *
 * The worker does NOT own the shared database, so it reports no WAL size and
 * no authoritative running-sessions count — the gateway remains the single
 * owner of those (see the aggregator's owner-only series).
 */
export function createWorkerDiagnosticsCollector(
  options: { reportIntervalMs?: number } = {},
): WorkerDiagnosticsCollector {
  const reportIntervalMs = options.reportIntervalMs ?? 1_000

  const collector = createDiagnosticsCollector({
    enableLoopSampler: true,
    intervalMs: 1_000,
    windowMs: 10_000,
    historyMs: 60_000,
  })

  let sendFn: ((data: DiagnosticsData) => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  function start(send: (data: DiagnosticsData) => void): void {
    if (timer) return
    sendFn = send
    collector.start()
    // Send an initial snapshot immediately so the gateway has data right away.
    send(collector.getData())
    timer = setInterval(() => {
      sendFn?.(collector.getData())
    }, reportIntervalMs)
    timer.unref()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    collector.stop()
    sendFn = null
  }

  return {
    start,
    stop,
    collector,
  }
}
