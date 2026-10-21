import { execFile, fork, type ChildProcess } from 'node:child_process'
import { readdir, readlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../shared/i18n/index.js'
import { InstanceLockError, formatInstanceLockRefusal, reportInstanceLockRefusal } from '../server/db/instance-lock.js'

const run = promisify(execFile)
const DIR = dirname(fileURLToPath(import.meta.url))
const LOCK_CHILD = join(DIR, '../server/db/instance-lock.test-child.ts')
const SERVE_CHILD = join(DIR, 'instance-lock-refuse.test-child.ts')
const MIN_PORT = 10620

function developmentDbPath(home: string): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'openfox-dev', 'sessions.db')
  }
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'openfox-dev', 'sessions.db')
  }
  return join(home, '.local', 'share', 'openfox-dev', 'sessions.db')
}

function isolatedEnv(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('OPENFOX_') && !key.startsWith('XDG_')) env[key] = value
  }
  return {
    ...env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
    OPENFOX_LOG_LEVEL: 'error',
    OPENFOX_DISABLE_AUTO_SESSION_TITLE: 'true',
    ...extra,
  }
}

async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer()
      probe.once('error', () => done(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port from ${from}`)
}

async function openFiles(pid: number): Promise<string[]> {
  if (process.platform === 'linux') {
    const fds = await readdir(`/proc/${pid}/fd`)
    const targets = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')))
    return targets.filter(Boolean)
  }
  const { stdout } = await run('lsof', ['-n', '-P', '-Fn', '-p', String(pid)], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
}

function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

describe('instance lock CLI message', () => {
  const children: ChildProcess[] = []
  const roots: string[] = []

  afterEach(async () => {
    for (const child of children) killProcessTree(child)
    children.length = 0
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('prints the English refusal by default, with path and PID, without opening the database', () => {
    setLocale('en')
    const error = new InstanceLockError('/tmp/sessions.db', {
      pid: 4242,
      startedAt: '2026-10-21T00:00:00.000Z',
    })
    const line = formatInstanceLockRefusal('en', error.dbPath, {
      pid: error.ownerPid!,
      startedAt: error.ownerStartedAt!,
    })
    expect(line).toMatch(/database already in use by instance PID 4242/)
    expect(line).toContain('/tmp/sessions.db')
    expect(line).toMatch(/stop PID 4242/)
    expect(line.split('\n')).toHaveLength(1)
    expect(error.message).toBe(line)
    expect(reportInstanceLockRefusal(error)).toBe(line)
  })

  it('runServe refuses without opening a write-locked sessions database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openfox-lock-cli-'))
    roots.push(root)
    const home = join(root, 'home')
    const dbPath = developmentDbPath(home)
    await mkdir(dirname(dbPath), { recursive: true })
    await mkdir(home, { recursive: true })
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE IF NOT EXISTS _openfox_probe (id INTEGER PRIMARY KEY)')
    seed.close()

    const holder = fork(LOCK_CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    children.push(holder)
    const held = await new Promise<{ ok?: boolean; pid?: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock holder timed out')), 10_000)
      holder.once('message', (value) => {
        clearTimeout(timer)
        resolve(value as { ok?: boolean; pid?: number })
      })
      holder.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`lock holder exited ${code}`))
      })
    })
    expect(held.ok).toBe(true)
    expect(held.pid).toBeGreaterThan(0)

    const writer = new Database(dbPath)
    writer.pragma('locking_mode = EXCLUSIVE')
    writer.exec('BEGIN EXCLUSIVE')

    const port = await freePort(MIN_PORT)
    const logs: string[] = []
    const child = fork(SERVE_CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: isolatedEnv(root, {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_GLOBAL_CONFIG_PATH: join(root, 'config.json'),
        OPENFOX_HOST: '127.0.0.1',
        OPENFOX_PORT: String(port),
        OPENFOX_MOCK_LLM: 'true',
      }),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    children.push(child)
    const keep = (data: Buffer) => {
      logs.push(data.toString())
      if (logs.length > 200) logs.shift()
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve child did not become ready:\n${logs.join('')}`)), 60_000)
      child.once('message', (value) => {
        if ((value as { ready?: boolean }).ready) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`serve child exited ${code} before ready:\n${logs.join('')}`))
      })
    })

    const openedMain: string[] = []
    const poll = setInterval(() => {
      if (!child.pid || child.exitCode !== null) return
      void openFiles(child.pid)
        .then((files) => {
          for (const file of files) {
            if (file === dbPath || file.startsWith(`${dbPath}-`)) openedMain.push(file)
          }
        })
        .catch(() => {
          // Process may have exited between the pid check and lsof.
        })
    }, 20)

    const started = Date.now()
    child.send('go')
    const exitCode = await waitForExit(child, 8_000)
    const elapsed = Date.now() - started
    clearInterval(poll)
    writer.close()

    const stderr = logs.join('')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/database already in use by instance PID/)
    expect(stderr).toMatch(new RegExp(`PID ${held.pid}`))
    expect(stderr).toContain(dbPath)
    expect(elapsed).toBeLessThan(2_000)
    expect(openedMain).toEqual([])
  }, 90_000)
})
