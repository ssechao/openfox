import { spawn, type ChildProcess } from 'node:child_process'
import { gitSpawnEnv } from './env.js'

export function spawnGitProcess(cwd: string, args: string[]): ChildProcess {
  return spawn('git', args, {
    cwd,
    env: gitSpawnEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  })
}
