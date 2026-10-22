import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'

/**
 * Test-only: park the current process at a named barrier so the parent can
 * SIGKILL it. Production never sets OPENFOX_BLOB_BARRIER.
 */
export function parkAtBlobBarrier(name: string): void {
  if (process.env['OPENFOX_BLOB_BARRIER'] !== name) return
  const file = process.env['OPENFOX_BLOB_BARRIER_FILE']
  if (file) {
    writeFileSync(file, name)
    try {
      const fd = openSync(file, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // marker without fsync is still usable as a fallback
    }
  }
  process.send?.({ parked: name, pid: process.pid })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
