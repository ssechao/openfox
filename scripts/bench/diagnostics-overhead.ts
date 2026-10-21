/**
 * CPU cost of the health collector, enabled vs disabled, over `--seconds`
 * (30 by default) per scenario, with /api/diagnostics-style reads every 2 s.
 * Deliberate scope: the collector alone in an idle process, not a full server.
 * dbPath is ':memory:', so the per-second stat() of the WAL file is excluded.
 */
import { performance } from 'node:perf_hooks'
import { createDiagnosticsCollector } from '../../src/server/diagnostics/collector.js'

const seconds = Number(process.argv.find((arg) => arg.startsWith('--seconds='))?.slice(10) ?? 30)
const POLL_MS = 2_000
const LIMIT_PERCENT_OF_CORE = 1

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

async function measure(enabled: boolean): Promise<{ cpuMs: number; wallMs: number; percentOfCore: number }> {
  const collector = createDiagnosticsCollector({ countRunningSessions: () => 0, dbPath: ':memory:' })
  const keepAlive = setInterval(() => {}, 1_000)
  const poll = enabled ? setInterval(() => JSON.stringify(collector.getData()), POLL_MS) : null
  if (enabled) collector.start()

  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  await sleep(seconds * 1_000)
  const wallMs = performance.now() - started
  const cpu = process.cpuUsage(cpuBefore)

  collector.stop()
  if (poll) clearInterval(poll)
  clearInterval(keepAlive)
  const cpuMs = (cpu.user + cpu.system) / 1_000
  return { cpuMs, wallMs, percentOfCore: (cpuMs / wallMs) * 100 }
}

const round = (value: number) => Math.round(value * 1000) / 1000

const disabled = await measure(false)
const enabled = await measure(true)
const overhead = enabled.percentOfCore - disabled.percentOfCore
const report = {
  secondsPerScenario: seconds,
  pollEveryMs: POLL_MS,
  disabled: { cpuMs: round(disabled.cpuMs), percentOfCore: round(disabled.percentOfCore) },
  enabled: { cpuMs: round(enabled.cpuMs), percentOfCore: round(enabled.percentOfCore) },
  overheadPercentOfCore: round(overhead),
  limitPercentOfCore: LIMIT_PERCENT_OF_CORE,
  pass: overhead < LIMIT_PERCENT_OF_CORE,
}
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1
