import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export type Probe = (signal: AbortSignal) => Promise<void>

export const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, { signal }).catch(() => {})

/**
 * Run `body` while the probes poll in the background. Whatever happens in the
 * body (failed assertion, bench error, timeout), the probes are aborted and
 * awaited before this returns or rethrows.
 */
export async function withProbes<T>(probes: Probe[], body: () => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const running = probes.map((probe) => probe(controller.signal).catch(() => {}))
  try {
    return await body()
  } finally {
    controller.abort()
    await Promise.all(running)
  }
}

export interface BenchOptions {
  script: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  execArgv?: string[]
  timeoutMs: number
  logs: string[]
  during?: (child: ChildProcess) => Promise<void>
}

/**
 * Kill the whole process group of a detached child (the bench and the LLM
 * server it forks), then wait a bounded time for the leader to exit.
 */
export async function stopProcessGroup(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The whole group is already gone.
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  const settled = new AbortController()
  await Promise.race([once(child, 'exit'), delay(graceMs, undefined, { signal: settled.signal }).catch(() => {})])
  settled.abort()
}

/**
 * Fork a bench in its own process group and wait for it. Rejects when it exits
 * non-zero, outlives `timeoutMs`, or `during` throws; in every case the group
 * is killed and the timer cleared before the promise settles.
 */
export async function runBench(options: BenchOptions): Promise<void> {
  const child = fork(options.script, options.args, {
    cwd: options.cwd,
    env: options.env,
    execArgv: options.execArgv ?? [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: true,
  })
  const keep = (data: Buffer) => {
    options.logs.push(`[bench] ${data.toString()}`)
    if (options.logs.length > 200) options.logs.shift()
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)

  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  const timer = new AbortController()
  const timedOut = delay(options.timeoutMs, 'timeout' as const, { signal: timer.signal }).catch(
    () => 'cancelled' as const,
  )
  try {
    const [outcome] = await Promise.all([Promise.race([exited, timedOut]), options.during?.(child)])
    if (outcome === 'timeout') throw new Error(`Bench timed out after ${options.timeoutMs} ms`)
    if (outcome !== 0) throw new Error(`Bench exited with ${outcome}:\n${options.logs.join('')}`)
  } finally {
    timer.abort()
    await stopProcessGroup(child)
  }
}
