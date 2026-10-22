#!/usr/bin/env node
/**
 * Explicit FTS5 search-index rebuild. Disabled by default; never invoked at startup.
 * Usage: npx tsx scripts/rebuild-search-index.ts --yes --db <path>
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import {
  acquireInstanceLock,
  InstanceLockError,
  releaseInstanceLock,
  reportInstanceLockRefusal,
} from '../src/server/db/instance-lock.js'
import { rebuildSearchIndex } from '../src/server/search/fts-index.js'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const dbFlag = args.indexOf('--db')
const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : process.env['OPENFOX_DB_PATH']

if (!yes || !dbPath) {
  console.error('Usage: npx tsx scripts/rebuild-search-index.ts --yes --db <sessions.db>')
  console.error('Refusing to run: this command is explicit and off by default (lot 4b).')
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
  const result = rebuildSearchIndex(db)
  console.log(JSON.stringify({ dbPath, ...result, indexReady: true }, null, 2))
} finally {
  db.close()
  releaseInstanceLock()
}
