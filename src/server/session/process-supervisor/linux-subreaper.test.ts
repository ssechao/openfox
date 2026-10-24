import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LINUX_SUBREAPER_PYTHON_ENV,
  linuxSubreaperSpawnFailure,
  resolveLinuxSubreaperInterpreter,
  spawnLinuxSubreaper,
} from './linux-subreaper.js'

describe('Linux session supervisor python3 prerequisite', () => {
  it('defaults to python3 and honours the override', () => {
    expect(resolveLinuxSubreaperInterpreter({})).toBe('python3')
    expect(resolveLinuxSubreaperInterpreter({ [LINUX_SUBREAPER_PYTHON_ENV]: ' /usr/bin/python3.12 ' })).toBe(
      '/usr/bin/python3.12',
    )
    expect(resolveLinuxSubreaperInterpreter({ [LINUX_SUBREAPER_PYTHON_ENV]: '   ' })).toBe('python3')
  })

  it('names python3 and the override when the interpreter is missing', () => {
    const failure = linuxSubreaperSpawnFailure(
      Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }),
      'python3',
    )
    expect(failure?.message).toContain('python3')
    expect(failure?.message).toContain(LINUX_SUBREAPER_PYTHON_ENV)
    expect(failure?.message).toContain('PR_SET_CHILD_SUBREAPER')
  })

  it('leaves unrelated spawn errors untouched', () => {
    expect(
      linuxSubreaperSpawnFailure(Object.assign(new Error('permission denied'), { code: 'EACCES' }), 'python3'),
    ).toBeNull()
  })
})

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

  it('reports a python3-naming failure when the configured interpreter is missing', async () => {
    const previous = process.env[LINUX_SUBREAPER_PYTHON_ENV]
    const missing = join(tmpdir(), `openfox-missing-python-${Date.now()}`)
    process.env[LINUX_SUBREAPER_PYTHON_ENV] = missing
    try {
      const child = spawnLinuxSubreaper({ path: 'ignored.cjs', execArgv: [], env: process.env })
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve))
      expect(error.code).toBe('ENOENT')
      expect(linuxSubreaperSpawnFailure(error, missing)?.message).toContain('OPENFOX_PYTHON')
    } finally {
      if (previous === undefined) delete process.env[LINUX_SUBREAPER_PYTHON_ENV]
      else process.env[LINUX_SUBREAPER_PYTHON_ENV] = previous
    }
  }, 10_000)
})
