import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pause, runBench, withProbes } from './utils/load-run.js'

const FAKE_BENCH = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [pidFile, mode] = process.argv.slice(2)
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(pidFile, String(grandchild.pid))
if (mode === 'fail') process.exit(1)
setInterval(() => {}, 1000)
`

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!isAlive(pid)) return true
    await new Promise((done) => setTimeout(done, 100))
  }
  return false
}

const resources = () => {
  const active = process.getActiveResourcesInfo()
  return {
    timers: active.filter((r) => r === 'Timeout').length,
    processes: active.filter((r) => r === 'ProcessWrap').length,
  }
}

describe('demo load runner cleanup', () => {
  let dir: string
  let script: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openfox-load-run-'))
    script = join(dir, 'fake-bench.mjs')
    await writeFile(script, FAKE_BENCH, 'utf-8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function started(pidFile: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(pidFile, 'utf-8').then(Boolean, () => false)) return
      await new Promise((done) => setTimeout(done, 50))
    }
  }

  async function forcedFailure(mode: 'fail' | 'hang', during?: (pidFile: string) => Promise<void>) {
    const pidFile = join(dir, `${mode}-${Date.now()}.pid`)
    const before = resources()
    let probeStopped = false
    let probeRounds = 0
    const probe = async (signal: AbortSignal) => {
      while (!signal.aborted) {
        probeRounds++
        await pause(20, signal)
      }
      probeStopped = true
    }
    let leaderPid: number | undefined
    const run = withProbes([probe], () =>
      runBench({
        script,
        args: [pidFile, mode],
        cwd: dir,
        env: process.env,
        timeoutMs: 1_500,
        logs: [],
        during: async (child) => {
          leaderPid = child.pid
          await during?.(pidFile)
        },
      }),
    )
    const error = await run.then(
      () => null,
      (reason: unknown) => reason as Error,
    )
    const grandchildPid = Number(await readFile(pidFile, 'utf-8'))
    return { error, before, probeStopped, probeRounds, leaderPid: leaderPid!, grandchildPid }
  }

  async function expectNothingLeft(result: Awaited<ReturnType<typeof forcedFailure>>) {
    expect(result.probeStopped).toBe(true)
    expect(result.probeRounds).toBeGreaterThan(0)
    expect(await waitDead(result.leaderPid)).toBe(true)
    expect(await waitDead(result.grandchildPid)).toBe(true)
    const after = resources()
    expect(after.timers).toBeLessThanOrEqual(result.before.timers)
    expect(after.processes).toBeLessThanOrEqual(result.before.processes)
  }

  it('stops the probes and the whole bench group when the bench exits non-zero', async () => {
    const result = await forcedFailure('fail', () => pause(200, new AbortController().signal))
    expect(result.error?.message).toMatch(/exited with 1/)
    await expectNothingLeft(result)
  })

  it('kills a bench that outlives its timeout, grandchildren included', async () => {
    const result = await forcedFailure('hang')
    expect(result.error?.message).toMatch(/timed out after 1500 ms/)
    await expectNothingLeft(result)
  })

  it('cleans up when an assertion fails while the bench is still running', async () => {
    const result = await forcedFailure('hang', async (pidFile) => {
      await started(pidFile)
      expect('production file').toBe('none')
    })
    expect(result.error?.message).toMatch(/expected 'production file' to be 'none'/)
    await expectNothingLeft(result)
  })
})
