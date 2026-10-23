import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { getPlatformShell } from './platform.js'
import { getSetting, SETTINGS_KEYS } from '../db/settings.js'
import { finalizeExclusiveChild, reserveExclusiveChild } from '../session/worker/children.js'

export function checkAborted(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted
}

export interface SpawnShellOptions {
  cwd: string
  detached?: boolean
  stdio?: StdioOptions
}

export function spawnShell(command: string, options: SpawnShellOptions): ChildProcess {
  const shell = getPlatformShell()
  // cmd.exe: Node's default arg quoting escapes inner double quotes with
  // backslashes, which cmd does not understand — commands like
  // node -e "..." silently break. Mimic what Node itself does for
  // { shell: true }: /d /s /c + the whole command wrapped in quotes,
  // passed verbatim.
  const isCmd = shell.command === 'cmd.exe'
  const args = isCmd ? ['/d', '/s', '/c', `"${command}"`] : [...shell.args, command]
  const proxyUrl = getSetting(SETTINGS_KEYS.PROXY_URL)
  const proxyEnv: Record<string, string> = {}
  if (proxyUrl) {
    proxyEnv['HTTP_PROXY'] = proxyUrl
    proxyEnv['HTTPS_PROXY'] = proxyUrl
  }

  const reservation = reserveExclusiveChild(command)
  const child = spawn(shell.command, args, {
    ...(isCmd ? { windowsVerbatimArguments: true } : {}),
    cwd: options.cwd,
    env: { ...process.env, ...proxyEnv },
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // detached is only useful for Unix process-group semantics; on win32 it
    // spawns a visible console window and makes MSYS binaries (tail, sleep)
    // hang on pipes. Tree-kill uses taskkill on win32, so detached is unneeded.
    ...(options.detached && process.platform !== 'win32' ? { detached: true } : {}),
  })
  try {
    finalizeExclusiveChild(reservation, child.pid)
  } catch (error) {
    if (options.detached && process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (killError) {
        void killError
      }
    }
    try {
      child.kill('SIGKILL')
    } catch (killError) {
      void killError
    }
    throw new Error(`Failed to track spawned child: ${error instanceof Error ? error.message : String(error)}`)
  }
  return child
}

export function spawnShellProcess(command: string, cwd: string, _signal?: AbortSignal, detached = false): ChildProcess {
  return spawnShell(command, { cwd, detached })
}
