/**
 * Simulates a vitest runner that forks the lock parent. Killing this process
 * must take down both the parent helper and the lock grandchild.
 */
import { fork } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installParentExitGuard } from '../utils/parent-exit-guard.js'

installParentExitGuard()

const parentPath = join(dirname(fileURLToPath(import.meta.url)), 'instance-lock.test-parent.ts')
const dbPath = process.env['OPENFOX_LOCK_DB_PATH']
if (!dbPath) process.exit(2)

const parent = fork(parentPath, [], {
  execArgv: ['--import', 'tsx/esm'],
  env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  detached: true,
})
parent.on('message', (message) => {
  process.send?.({ runnerPid: process.pid, ...(message as object) })
})
setInterval(() => {}, 60_000)
