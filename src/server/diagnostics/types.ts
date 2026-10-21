import type { DiagnosticsData } from '../../shared/diagnostics.js'

export type { DiagnosticsData }

export interface DiagnosticsCollector {
  start(): void
  stop(): void
  recordEventLoopDelay(ms: number): void
  recordHealthLatency(ms: number): void
  recordRead(ms: number): void
  recordWrite(ms: number): void
  getData(): DiagnosticsData
}
