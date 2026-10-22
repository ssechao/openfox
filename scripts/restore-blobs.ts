#!/usr/bin/env node
/**
 * Restore a 4a-2 backup under the instance lock.
 * Usage: npx tsx scripts/restore-blobs.ts --yes --from <dir> --db <path>
 */
import { existsSync } from 'node:fs'
import { restoreDatabaseAndBlobs } from '../src/server/events/blob-backup.js'
import {
  acquireInstanceLock,
  InstanceLockError,
  releaseInstanceLock,
  reportInstanceLockRefusal,
} from '../src/server/db/instance-lock.js'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const fromFlag = args.indexOf('--from')
const dbFlag = args.indexOf('--db')
const fromDir = fromFlag >= 0 ? args[fromFlag + 1] : undefined
const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : process.env['OPENFOX_DB_PATH']

if (!yes || !fromDir || !dbPath) {
  console.error('Usage: npx tsx scripts/restore-blobs.ts --yes --from <backup-dir> --db <sessions.db>')
  process.exit(1)
}
if (!existsSync(fromDir)) {
  console.error(`Backup not found: ${fromDir}`)
  process.exit(1)
}

try {
  acquireInstanceLock(dbPath)
} catch (error) {
  if (error instanceof InstanceLockError) {
    reportInstanceLockRefusal(error)
    process.exit(1)
  }
  throw error
}

try {
  restoreDatabaseAndBlobs(fromDir, dbPath)
  console.log(JSON.stringify({ fromDir, dbPath, restored: true }, null, 2))
} finally {
  releaseInstanceLock()
}
