/**
 * Holds or contends for an instance lock. Used by instance-lock.test.ts.
 */
import { acquireInstanceLock } from './instance-lock.js'

const parent = process.ppid
try {
  process.stdin.resume()
} catch {
  // stdin may be ignored
}
const die = (): void => process.exit(0)
process.stdin.on('end', die)
process.stdin.on('close', die)
const watch = setInterval(() => {
  if (process.ppid !== parent) die()
  try {
    process.kill(parent, 0)
  } catch {
    die()
  }
}, 200)
watch.unref()

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
