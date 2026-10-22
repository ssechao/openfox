import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { terminateProcessTree } from './process-tree.js'

/** Default timeout for generic shell/file commands. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

/** Workspace `config.setup` commands (e.g. npm install). */
export const WORKSPACE_SETUP_TIMEOUT_MS = 10 * 60 * 1000

/** Recursive workspace directory removal. */
export const WORKSPACE_DELETE_TIMEOUT_MS = 2 * 60 * 1000

/** `id` / `sudo` / `getent` permission helpers. */
export const PERMISSIONS_COMMAND_TIMEOUT_MS = 15_000

/** `git init` when creating a project. */
export const GIT_INIT_TIMEOUT_MS = 30_000

/** Read-only git queries (branch, diff, status) behind git status polling and review diffs. */
export const GIT_QUERY_TIMEOUT_MS = 10_000

/** Bytes of stdout/stderr kept after draining. Earlier output is discarded. */
export const CAPTURED_OUTPUT_LIMIT = 64 * 1024

export class CommandTimeoutError extends Error {
  readonly command: string
  readonly timeoutMs: number
  constructor(command: string, timeoutMs: number) {
    super(`Command timed out after ${timeoutMs} ms: ${command}`)
    this.name = 'CommandTimeoutError'
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

export class CommandAbortedError extends Error {
  readonly command: string
  constructor(command: string) {
    super(`Command aborted: ${command}`)
    this.name = 'CommandAbortedError'
    this.command = command
  }
}

export class CommandFailedError extends Error {
  readonly command: string
  readonly code?: string | number
  readonly status?: number
  readonly stdout: string
  readonly stderr: string
  constructor(
    command: string,
    opts: { code?: string | number; status?: number; stdout?: string; stderr?: string; message?: string },
  ) {
    super(opts.message ?? (opts.stderr?.trim() || `${command} failed`))
    this.name = 'CommandFailedError'
    this.command = command
    if (opts.code !== undefined) this.code = opts.code
    if (opts.status !== undefined) this.status = opts.status
    else if (typeof opts.code === 'number') this.status = opts.code
    this.stdout = opts.stdout ?? ''
    this.stderr = opts.stderr ?? ''
  }
}

export function isCommandMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const e = err as Error & { code?: string | number; status?: number }
  if (e.code === 'ENOENT') return true
  if (e.status === 127 || e.status === 9009) return true
  if (e.code === 127 || e.code === 9009) return true
  return /is not recognized as an internal or external command/i.test(e.message)
}

export interface BoundedExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  stdio?: SpawnOptions['stdio']
}

function spawnChild(file: string, args: string[], options: BoundedExecOptions): ChildProcess {
  return spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  })
}

function commandLabel(file: string, args: string[]): string {
  return [file, ...args].join(' ')
}

function appendCapped(previous: string, chunk: Buffer | string): string {
  const next = previous + chunk.toString()
  if (next.length <= CAPTURED_OUTPUT_LIMIT) return next
  return next.slice(next.length - CAPTURED_OUTPUT_LIMIT)
}

async function waitForSpawned(
  proc: ChildProcess,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  if (signal?.aborted) {
    await terminateProcessTree(proc, { immediate: true })
    throw new CommandAbortedError(command)
  }

  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = appendCapped(stdout, chunk)
  })
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = appendCapped(stderr, chunk)
  })

  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) {
        void terminateProcessTree(proc).finally(() => reject(err))
      }
    }

    const timer = setTimeout(() => {
      finish(new CommandTimeoutError(command, timeoutMs))
    }, timeoutMs)

    const onAbort = () => {
      finish(new CommandAbortedError(command))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new CommandFailedError(command, {
          code: code ?? 1,
          status: code ?? 1,
          stdout,
          stderr,
        }),
      )
    })

    proc.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      const failed = new CommandFailedError(command, {
        ...(code !== undefined ? { code } : {}),
        message: err.message,
        stdout,
        stderr,
      })
      finish(failed)
    })
  })
}

/** Spawn `file args` with a finite timeout. Abort kills the whole process tree (SIGTERM then SIGKILL). */
export async function runFile(
  file: string,
  args: string[],
  options: BoundedExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const proc = spawnChild(file, args, options)
  return waitForSpawned(proc, commandLabel(file, args), timeoutMs, options.signal)
}

/** Run a shell command string (`sh -c` / `cmd.exe`) with the same timeout and abort semantics. */
export async function runShell(
  command: string,
  options: BoundedExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const proc =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawnChild('sh', ['-c', command], options)
  return waitForSpawned(proc, command, timeoutMs, options.signal)
}
