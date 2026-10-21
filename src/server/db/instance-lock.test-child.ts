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
