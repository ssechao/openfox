/**
 * Intermediate parent used to prove that a lock child dies with its parent.
 */
import { fork } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installParentExitGuard } from '../utils/parent-exit-guard.js'

installParentExitGuard()

const childPath = join(dirname(fileURLToPath(import.meta.url)), 'instance-lock.test-child.ts')
const dbPath = process.env['OPENFOX_LOCK_DB_PATH']
if (!dbPath) process.exit(2)

const child = fork(childPath, [], {
  execArgv: ['--import', 'tsx/esm'],
  env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  detached: true,
})
child.on('message', (message) => {
  process.send?.({ parentPid: process.pid, childPid: child.pid, ...(message as object) })
})
setInterval(() => {}, 60_000)
