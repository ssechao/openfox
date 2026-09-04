#!/usr/bin/env node
/**
 * Storage maintenance: de-duplicate stale streaming output from persisted
 * snapshots and prune transient stream events covered by a snapshot. Pending
 * events newer than the latest snapshot are retained.
 *
 * The migration is also auto-run in the background at server startup, so this
 * script is only needed to force it early (or when the server is stopped).
 * Either way, the migration itself creates a rollback backup
 * (`<db>.pre-de-dup.bak`) before its first rewrite.
 *
 * Usage:
 *   npm run optimize:snapshots -- --yes --server-stopped
 *
 * The `--yes` flag is mandatory to run it manually. The transient-event
 * migration verifies a fresh backup before pruning and vacuums the live file.
 */
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../src/server/config.js'
import { initDatabase } from '../src/server/db/index.js'
import { EventStore } from '../src/server/events/index.js'
import { getDatabasePath } from '../src/cli/paths.js'
import { assertDatabaseIsClosed } from './maintenance-safety.js'

const CONFIRMED = process.argv.includes('--yes') && process.argv.includes('--server-stopped')

async function main(): Promise<void> {
  const config = loadConfig()
  // Mirror the server: an unset OPENFOX_DB_PATH (default './openfox.db') means
  // "use the platform data dir" (~/.local/share/openfox[-dev]/sessions.db).
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
  try {
    assertDatabaseIsClosed(openProcesses)
  } catch (error) {
    console.error(`[optimize-snapshots] REFUSING: ${error instanceof Error ? error.message : String(error)}.`)
    process.exit(1)
  }

  const backupPath = `${dbPath}.pre-storage-maintenance-${Date.now()}.bak`
  const source = new Database(dbPath)
  const sourceIntegrity = String(source.pragma('integrity_check', { simple: true }))
  if (sourceIntegrity !== 'ok') {
    source.close()
    throw new Error(`Database integrity check failed: ${sourceIntegrity}`)
  }
  await source.backup(backupPath)
  source.close()

  const backup = new Database(backupPath, { readonly: true })
  const backupIntegrity = String(backup.pragma('integrity_check', { simple: true }))
  backup.close()
  if (backupIntegrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${backupIntegrity}`)
  }
  console.log(`[optimize-snapshots] Verified rollback backup: ${backupPath}`)

  const configWithPath = { ...config, database: { ...config.database, path: dbPath } }
  const db = initDatabase(configWithPath)
  const store = new EventStore(db)

  const report = await store.migrateSnapshotStreams()
  console.log('[optimize-snapshots] Migration report:')
  console.log(JSON.stringify(report, null, 2))

  const transientReport = await store.migrateTransientEvents({ backupPath })
  console.log('[optimize-snapshots] Transient event migration report:')
  console.log(JSON.stringify(transientReport, null, 2))

  const checkpoint = store.checkpointWal()
  console.log('[optimize-snapshots] WAL checkpoint:', JSON.stringify(checkpoint))

  if (report.skipped) {
    console.log('[optimize-snapshots] Nothing to do (snapshots already migrated).')
  } else {
    console.log(
      `[optimize-snapshots] Done: ${report.rewritten}/${report.scanned} snapshots rewritten, ` +
        `${report.droppedStreams} streams dropped, ~${((report.bytesBefore - report.bytesAfter) / 1048576).toFixed(1)}MB freed.`,
    )
    console.log('[optimize-snapshots] Rollback backup: ' + (report.backupPath ?? '(in-memory db, none)'))
  }

  db.close()
}

void main()
