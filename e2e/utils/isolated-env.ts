/**
 * Shared helpers for isolated OpenFox demo/e2e instances. HOME, config and
 * OPENFOX_DB_PATH must live under tmpdir; ports are allocated from a floor.
 */
import { execFile, type ChildProcess } from 'node:child_process'
import { readdir, readlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REAL_HOME = userInfo().homedir

export const PRODUCTION_PREFIXES = [
  join(REAL_HOME, 'Library', 'Application Support', 'openfox'),
  join(REAL_HOME, '.config', 'openfox'),
  join(REAL_HOME, '.local', 'share', 'openfox'),
]

export async function freePort(from: number): Promise<number> {
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

export function isolatedEnv(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
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

export function track(child: ChildProcess, name: string, logs: string[]): ChildProcess {
  const keep = (data: Buffer) => {
    logs.push(`[${name}] ${data.toString()}`)
    if (logs.length > 200) logs.shift()
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  return child
}

export async function openFiles(pid: number): Promise<string[]> {
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

export const productionFiles = (files: string[]): string[] =>
  files.filter((file) =>
    PRODUCTION_PREFIXES.some((prefix) => {
      if (file !== prefix && !file.startsWith(`${prefix}/`) && !file.startsWith(`${prefix}\\`)) return false
      const rest = file.slice(prefix.length).replace(/^[\\/]/, '')
      return rest !== '' && !rest.startsWith('workspaces/')
    }),
  )

export function killProcessTree(child: ChildProcess): void {
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
