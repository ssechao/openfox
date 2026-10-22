import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  CAPTURED_OUTPUT_LIMIT,
  CommandAbortedError,
  CommandFailedError,
  CommandTimeoutError,
  isCommandMissing,
  runFile,
  runShell,
} from './bounded-exec.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && isAlive(pid)) await sleep(50)
}

function timerFiredMs(ms = 20): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    setTimeout(() => resolve(performance.now() - t0), ms)
  })
}

describe('bounded-exec', () => {
  it('runs a file command and returns stdout', async () => {
    const { stdout } = await runFile(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      timeoutMs: 5_000,
    })
    expect(stdout).toBe('ok')
  })

  it('runs a shell command', async () => {
    const { stdout } = await runShell('echo hello', { timeoutMs: 5_000 })
    expect(stdout.trim()).toBe('hello')
  })

  it('does not block a 20ms timer while a command sleeps 2s', async () => {
    const running = runShell('sleep 2', { timeoutMs: 5_000 })
    await sleep(50)
    const fired = await timerFiredMs(20)
    expect(fired).toBeLessThan(100)
    await running
  })

  it('kills the command on timeout', async () => {
    const started = Date.now()
    await expect(runShell('sleep 10', { timeoutMs: 300 })).rejects.toBeInstanceOf(CommandTimeoutError)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('kills the whole process group on abort, including descendants', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-bounded-exec-'))
    const marker = join(dir, 'child.pid')
    const script = [
      `const {spawn}=require('child_process');`,
      `const fs=require('fs');`,
      `const child=spawn('sleep',['30'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
      `setInterval(()=>{},1000);`,
    ].join('')
    const ac = new AbortController()
    const running = runFile(process.execPath, ['-e', script], { cwd: dir, timeoutMs: 10_000, signal: ac.signal })
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      try {
        const pid = Number((await readFile(marker, 'utf8')).trim())
        if (pid > 0) {
          expect(isAlive(pid)).toBe(true)
          ac.abort()
          await expect(running).rejects.toBeInstanceOf(CommandAbortedError)
          await waitUntilDead(pid)
          expect(isAlive(pid)).toBe(false)
          await rm(dir, { recursive: true, force: true })
          return
        }
      } catch {
        await sleep(30)
      }
    }
    ac.abort()
    await running.catch(() => {})
    await rm(dir, { recursive: true, force: true })
    throw new Error('descendant pid was not recorded')
  })

  it('rejects with CommandFailedError on non-zero exit', async () => {
    await expect(runShell('exit 3', { timeoutMs: 5_000 })).rejects.toMatchObject({
      name: 'CommandFailedError',
      status: 3,
    })
  })

  it('keeps only the last 64 KiB of a massive stdout while still draining', async () => {
    const payload = 200_000
    const { stdout } = await runFile(process.execPath, ['-e', `process.stdout.write('x'.repeat(${payload}))`], {
      timeoutMs: 10_000,
    })
    expect(stdout.length).toBe(CAPTURED_OUTPUT_LIMIT)
    expect(stdout).toBe('x'.repeat(CAPTURED_OUTPUT_LIMIT))
  })

  it('reports a missing executable as ENOENT', async () => {
    try {
      await runFile('openfox-no-such-binary-etape3', [], { timeoutMs: 2_000 })
      throw new Error('expected missing command to fail')
    } catch (err) {
      expect(isCommandMissing(err)).toBe(true)
      expect((err as CommandFailedError).code).toBe('ENOENT')
    }
  })
})
