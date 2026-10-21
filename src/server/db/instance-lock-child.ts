/**
 * Holds or contends for an instance lock. Used by instance-lock.test.ts to
 * cover cross-process acquisition, SIGKILL release, and concurrent reclaim.
 */
import { acquireInstanceLock } from './instance-lock.js'

const dbPath = process.env['OPENFOX_LOCK_DB_PATH']
if (!dbPath) {
  process.stderr.write('OPENFOX_LOCK_DB_PATH is required\n')
  process.exit(2)
}

try {
  const result = acquireInstanceLock(dbPath)
  process.send?.({ ok: true, pid: process.pid, owner: result.owner })
} catch (error) {
  process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}

setInterval(() => {}, 60_000)
