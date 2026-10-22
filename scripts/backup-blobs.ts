#!/usr/bin/env node
/**
 * Online backup of sqlite + referenced blobs. No instance lock.
 * Usage: npx tsx scripts/backup-blobs.ts --yes --db <path> --out <dir>
 */
import { existsSync } from 'node:fs'
import { backupDatabaseAndBlobs } from '../src/server/events/blob-backup.js'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const dbFlag = args.indexOf('--db')
const outFlag = args.indexOf('--out')
const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : process.env['OPENFOX_DB_PATH']
const outDir = outFlag >= 0 ? args[outFlag + 1] : undefined

if (!yes || !dbPath || !outDir) {
  console.error('Usage: npx tsx scripts/backup-blobs.ts --yes --db <sessions.db> --out <dir>')
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const report = await backupDatabaseAndBlobs(dbPath, outDir)
  console.log(JSON.stringify(report, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
