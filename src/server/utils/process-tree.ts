import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const SIGKILL_TIMEOUT_MS = 200

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function execStdout(file: string, args: string[], timeout = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) reject(err)
      else resolve(stdout ?? '')
    })
  })
}

async function childrenOf(pid: number): Promise<number[]> {
  try {
    const stdout = await execStdout('pgrep', ['-P', String(pid)])
    return stdout
      .trim()
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((n) => n > 0)
  } catch {
    return []
  }
}

async function getDescendantPids(rootPid: number): Promise<number[]> {
  const descendants: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()!
    const kids = await childrenOf(current)
    for (const kid of kids) {
      if (seen.has(kid)) continue
      seen.add(kid)
      descendants.push(kid)
      queue.push(kid)
    }
  }
  return descendants
}

function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, signal)
  } catch {
    // May have already exited
  }
}

export async function signalProcessGroup(pid: number, immediate = false): Promise<boolean> {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
  } catch {
    return false
  }

  if (!immediate) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch (error) {
      void error
    }
    await sleep(SIGKILL_TIMEOUT_MS)
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    void error
  }
  return true
}

/**
 * Kill a process and all its descendants.
 *
 * On Unix, uses process group signaling (SIGTERM → SIGKILL) as the primary
 * mechanism.  Since `detached: true` makes the spawned process the leader of
 * a new process group, `kill(-pid, …)` reaches the shell and every process
 * it spawned — including backgrounded children that inherited the shell's
 * stdio pipes.  This avoids the "zombie pipe" problem where a surviving
 * child keeps pipe write-ends open, preventing the parent from ever
 * receiving the `close` event.
 *
 * Falls back to individual PID enumeration via `ps` for edge cases where
 * children created their own process groups (e.g. via `setsid`).
 *
 * On Windows, delegates to `taskkill /f /t`.
 */
export async function killProcessTree(pid: number, immediate = false): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('exit', () => resolve())
      killer.once('error', () => resolve())
    })
    return
  }

  // Snapshot the tree first. A child that called setsid is reparented to
  // init as soon as its parent dies, so enumerating after the kill misses it.
  const enumerated = await getDescendantPids(pid)

  const signalTree = (signal: 'SIGTERM' | 'SIGKILL') => {
    try {
      process.kill(-pid, signal)
    } catch {
      /* group may already be gone */
    }
    for (const childPid of enumerated) {
      try {
        process.kill(-childPid, signal)
      } catch {
        /* own group, or already gone */
      }
      killProcess(childPid, signal)
    }
    killProcess(pid, signal)
  }

  if (!immediate) {
    signalTree('SIGTERM')
    const deadline = Date.now() + SIGKILL_TIMEOUT_MS
    while (Date.now() < deadline && isAlive(pid)) {
      await sleep(20)
    }
  }
  signalTree('SIGKILL')

  if (enumerated.length === 0 && !isAlive(pid)) return

  const survivors = await getDescendantPids(pid)
  for (const p of new Set([...enumerated, ...survivors, pid])) {
    try {
      process.kill(-p, 'SIGKILL')
    } catch {
      /* ignore */
    }
    killProcess(p, 'SIGKILL')
  }
}

/**
 * Kill a ChildProcess and all its descendants.
 * Convenience wrapper around `killProcessTree`.
 */
export async function terminateProcessTree(
  proc: ChildProcess,
  options?: { exited?: () => boolean; immediate?: boolean },
): Promise<void> {
  const pid = proc.pid
  if (!pid || options?.exited?.()) {
    return
  }

  await killProcessTree(pid, options?.immediate ?? false)
}
