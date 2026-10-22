#!/usr/bin/env node
/**
 * Explicit blob migration. Disabled by default; never invoked at startup.
 * Usage: npx tsx scripts/migrate-blobs.ts --yes --db <path>
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { EventStore } from '../src/server/events/store.js'
import {
  acquireInstanceLock,
  InstanceLockError,
  releaseInstanceLock,
  reportInstanceLockRefusal,
} from '../src/server/db/instance-lock.js'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const dbFlag = args.indexOf('--db')
const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : process.env['OPENFOX_DB_PATH']

if (!yes || !dbPath) {
  console.error('Usage: npx tsx scripts/migrate-blobs.ts --yes --db <sessions.db>')
  console.error('Refusing to run: this command is explicit and off by default (lot 4a-1).')
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
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

const db = new Database(dbPath)
try {
  const store = new EventStore(db)
  const reports = store.migrateAllBlobs()
  const checkpoint = store.checkpointWal()
  console.log(JSON.stringify({ dbPath, sessions: reports.length, reports, checkpoint }, null, 2))
} finally {
  db.close()
  releaseInstanceLock()
}
