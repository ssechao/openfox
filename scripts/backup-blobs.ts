#!/usr/bin/env node
/**
 * Online backup of sqlite + referenced blobs. No instance lock.
 * Usage: npx tsx scripts/backup-blobs.ts --yes --db <path> --out <dir>
 * --out directory must not already exist.
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
  console.error('--out directory must not already exist')
  process.exit(1)
}
const sourceDb = dbPath
const destDir = outDir
if (!existsSync(sourceDb)) {
  console.error(`Database not found: ${sourceDb}`)
  process.exit(1)
}
if (existsSync(destDir)) {
  console.error(`Backup destination already exists: ${destDir}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const report = await backupDatabaseAndBlobs(sourceDb, destDir, {
    onProgress: (scanned, refs) => {
      process.stderr.write(`backup: scanned ${scanned} events, ${refs} blob refs\n`)
    },
  })
  console.log(JSON.stringify(report, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
