/**
 * Holds or contends for an instance lock. Used by instance-lock.test.ts.
 */
import { acquireInstanceLock } from './instance-lock.js'
import { installParentExitGuard } from '../utils/parent-exit-guard.js'

installParentExitGuard()

const dbPath = process.env['OPENFOX_LOCK_DB_PATH']
if (!dbPath) {
  process.stderr.write('OPENFOX_LOCK_DB_PATH is required\n')
  process.exit(2)
}

const retry = process.env['OPENFOX_LOCK_RETRY'] === '1'
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

for (;;) {
  try {
    const result = acquireInstanceLock(dbPath)
    process.send?.({ ok: true, pid: process.pid, owner: result.owner })
    break
  } catch (error) {
    if (!retry) {
      process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) })
      process.exit(1)
    }
    sleep(20)
  }
}

setInterval(() => {}, 60_000)
