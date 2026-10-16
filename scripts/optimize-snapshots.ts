#!/usr/bin/env node
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../src/server/config.js'
import { initDatabase, refreshRecentUserPrompts } from '../src/server/db/index.js'
import { EventStore } from '../src/server/events/index.js'
import { getDatabasePath } from '../src/cli/paths.js'
import {
  assertDatabaseIsClosed,
  assertIntegrity,
  createVerifiedBackup,
  pruneExpiredStorageBackups,
} from './maintenance-safety.js'

const CONFIRMED = process.argv.includes('--yes') && process.argv.includes('--server-stopped')

async function main(): Promise<void> {
  const config = loadConfig()
  const dbPath =
    config.database.path !== './openfox.db'
      ? config.database.path
      : getDatabasePath(config.mode === 'development' ? 'development' : 'production')
  console.log(`[optimize-snapshots] Database: ${dbPath}`)

  if (!CONFIRMED) {
    console.error('[optimize-snapshots] REFUSING: stop the server, then pass --yes --server-stopped to proceed.')
    process.exit(1)
  }

  const openProcesses = spawnSync('lsof', ['-t', '--', dbPath], { encoding: 'utf8' })
  assertDatabaseIsClosed(openProcesses)

  const removedBackups = pruneExpiredStorageBackups(dbPath)
  if (removedBackups.length > 0) {
    console.log(`[optimize-snapshots] Pruned expired backups: ${removedBackups.length}`)
  }

  const backupPath = `${dbPath}.pre-storage-maintenance-${Date.now()}.bak`
  const source = new Database(dbPath)
  try {
    await createVerifiedBackup(source, backupPath, (path) => new Database(path, { readonly: true }))
  } finally {
    source.close()
  }
  console.log(`[optimize-snapshots] Verified rollback backup: ${backupPath}`)

  const configWithPath = { ...config, database: { ...config.database, path: dbPath } }
  const db = initDatabase(configWithPath)
  const store = new EventStore(db)

  const refreshedPrompts = refreshRecentUserPrompts()
  console.log(`[optimize-snapshots] Refreshed recent prompts: ${refreshedPrompts} sessions`)

  const streamReport = await store.migrateSnapshotStreams({ backupPath })
  console.log('[optimize-snapshots] Stream migration report:')
  console.log(JSON.stringify(streamReport, null, 2))

  const archivedReport = await store.compactArchivedToolResults({ backupPath })
  console.log('[optimize-snapshots] Archived tool-result report:')
  console.log(JSON.stringify(archivedReport, null, 2))

  const storageReport = store.optimizeStorage()
  console.log('[optimize-snapshots] Obsolete snapshot report:')
  console.log(JSON.stringify(storageReport, null, 2))

  const checkpoint = store.checkpointWal()
  console.log('[optimize-snapshots] WAL checkpoint:', JSON.stringify(checkpoint))

  db.exec('VACUUM')
  assertIntegrity(db, 'Post-maintenance database')

  console.log(
    `[optimize-snapshots] Done: ${archivedReport.rewritten}/${archivedReport.scanned} snapshots rewritten, ` +
      `${archivedReport.compactedResults} archived results compacted, ` +
      `~${((archivedReport.bytesBefore - archivedReport.bytesAfter) / 1048576).toFixed(1)}MB removed before VACUUM.`,
  )
  console.log(`[optimize-snapshots] Rollback backup: ${backupPath}`)
  db.close()
}

void main()
