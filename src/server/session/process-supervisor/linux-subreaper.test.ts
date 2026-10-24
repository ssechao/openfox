import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnLinuxSubreaper } from './linux-subreaper.js'

describe.runIf(process.platform === 'linux')('Linux session supervisor subreaper', () => {
  it('reaps an adopted detached descendant after its worker is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-subreaper-'))
    const workerPath = join(root, 'worker.cjs')
    const controllerPath = join(root, 'controller.cjs')
    writeFileSync(
      workerPath,
      `const { spawn } = require('node:child_process')
const child = spawn('sh', ['-c', 'exec sleep 120'], { detached: true, stdio: 'ignore' })
process.send(child.pid)
setInterval(() => {}, 1000)
`,
    )
    writeFileSync(
      controllerPath,
      `const { fork } = require('node:child_process')
const { existsSync } = require('node:fs')
const worker = fork(${JSON.stringify(workerPath)}, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
worker.once('message', (pid) => {
  process.kill(worker.pid, 'SIGKILL')
  setTimeout(() => {
    try { process.kill(-pid, 'SIGTERM') } catch {}
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ pid, exists: existsSync(\`/proc/\${pid}/stat\`) }))
      process.exit(0)
    }, 2000)
  }, 100)
})
`,
    )

    const child = spawnLinuxSubreaper({ path: controllerPath, execArgv: [], env: process.env })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })

    try {
      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ pid: expect.any(Number), exists: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)
})
