import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const STORAGE_BACKUP_RETENTION_MS = 10 * 24 * 60 * 60 * 1000

export interface ProcessProbeResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

interface IntegrityDatabase {
  pragma(source: string, options: { simple: true }): unknown
}

interface BackupSource extends IntegrityDatabase {
  backup(path: string): Promise<unknown>
}

interface BackupReader extends IntegrityDatabase {
  close(): void
}

export function pruneExpiredStorageBackups(
  databasePath: string,
  now = Date.now(),
  retentionMs = STORAGE_BACKUP_RETENTION_MS,
): string[] {
  const directory = dirname(databasePath)
  const prefix = `${basename(databasePath)}.pre-storage-maintenance-`
  const removed: string[] = []
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue
    const path = join(directory, name)
    if (now - statSync(path).mtimeMs <= retentionMs) continue
    unlinkSync(path)
    removed.push(path)
  }
  return removed
}

export function assertDatabaseIsClosed(result: ProcessProbeResult): void {
  if (result.error) {
    throw new Error(`lsof probe failed: ${result.error.message}`)
  }
  if (result.stderr.trim()) {
    throw new Error(`lsof probe failed: ${result.stderr.trim()}`)
  }
  if (result.status === 1 && !result.stdout.trim()) return
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Database is open by PID(s) ${result.stdout.trim()}`)
  }
  throw new Error(`lsof probe failed: unexpected exit status ${String(result.status)}`)
}

export function assertIntegrity(database: IntegrityDatabase, label: string): void {
  const result = String(database.pragma('integrity_check', { simple: true }))
  if (result !== 'ok') {
    throw new Error(`${label} integrity check failed: ${result}`)
  }
}

export async function createVerifiedBackup(
  source: BackupSource,
  backupPath: string,
  openBackup: (path: string) => BackupReader,
): Promise<string> {
  assertIntegrity(source, 'Database')
  try {
    await source.backup(backupPath)
  } catch (error) {
    throw new Error(`Database backup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let backup: BackupReader
  try {
    backup = openBackup(backupPath)
  } catch (error) {
    throw new Error(`Backup open failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    assertIntegrity(backup, 'Backup')
  } finally {
    backup.close()
  }
  return backupPath
}
