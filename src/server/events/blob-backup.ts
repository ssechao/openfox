import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parkAtBlobBarrier } from './blob-barrier.js'
import { collectBlobRefsFromEvents, type BlobScanProgress } from './blob-scan.js'
import { FileBlobStore, blobDirForDatabase, durableWriteFile, unlinkQuiet } from './blob-store.js'

export const BLOB_BACKUP_MANIFEST = 'manifest.json'

export class BlobBackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlobBackupError'
  }
}

export interface BlobBackupManifest {
  version: 1
  complete: boolean
  createdAt: string
  dbFile: string
  blobs: Array<{ hash: string; mime: string; size: number }>
}

export interface BlobBackupReport {
  dest: string
  blobs: number
}

function readManifest(dir: string): BlobBackupManifest {
  const path = join(dir, BLOB_BACKUP_MANIFEST)
  if (!existsSync(path)) throw new BlobBackupError(`Backup manifest missing: ${path}`)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as BlobBackupManifest
  if (parsed.version !== 1 || parsed.complete !== true || parsed.dbFile !== 'sessions.db') {
    throw new BlobBackupError('Backup manifest incomplete or unsupported')
  }
  return parsed
}

const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const

function unlinkSqliteSidecars(dbPath: string): void {
  for (const suffix of SQLITE_SIDECARS) unlinkQuiet(`${dbPath}${suffix}`)
}

function renameSqliteSidecars(fromDb: string, toDb: string): void {
  for (const suffix of SQLITE_SIDECARS) {
    const src = `${fromDb}${suffix}`
    if (existsSync(src)) renameSync(src, `${toDb}${suffix}`)
  }
}

function removeSqliteAndSidecars(dbPath: string): void {
  unlinkQuiet(dbPath)
  unlinkSqliteSidecars(dbPath)
}

type RestorePhase = 'prepared' | 'old-retired' | 'db-published' | 'published'

interface RestoreJournal {
  version: 1
  destDbPath: string
  destBlobsDir: string
  staging: string
  bakDb: string
  bakBlobs: string
  phase: RestorePhase
}

export function restoreJournalPath(destDbPath: string): string {
  return `${destDbPath}.restore-journal`
}

function readRestoreJournal(destDbPath: string): RestoreJournal | null {
  const path = restoreJournalPath(destDbPath)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RestoreJournal
    if (parsed.version !== 1 || typeof parsed.destDbPath !== 'string' || typeof parsed.staging !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeRestoreJournal(journal: RestoreJournal): void {
  durableWriteFile(restoreJournalPath(journal.destDbPath), Buffer.from(JSON.stringify(journal), 'utf8'))
}

function failRestoreIfInjected(step: string): void {
  if (process.env['OPENFOX_BLOB_RESTORE_FAIL'] === step) {
    throw new BlobBackupError(`injected restore failure: ${step}`)
  }
}

function finishPublishedRestore(journal: RestoreJournal): void {
  removeSqliteAndSidecars(journal.bakDb)
  rmSync(journal.bakBlobs, { recursive: true, force: true })
  unlinkQuiet(restoreJournalPath(journal.destDbPath))
  rmSync(journal.staging, { recursive: true, force: true })
  new FileBlobStore(journal.destBlobsDir, { ownerDbPath: journal.destDbPath })
}

function rollbackRestoreJournal(journal: RestoreJournal): void {
  const stagingDb = join(journal.staging, 'sessions.db')
  const stagingBlobs = join(journal.staging, 'blobs')
  if (existsSync(journal.bakDb)) {
    if (existsSync(journal.destDbPath)) {
      mkdirSync(journal.staging, { recursive: true })
      if (existsSync(stagingDb)) unlinkQuiet(stagingDb)
      renameSync(journal.destDbPath, stagingDb)
      unlinkSqliteSidecars(journal.destDbPath)
    }
    renameSync(journal.bakDb, journal.destDbPath)
    renameSqliteSidecars(journal.bakDb, journal.destDbPath)
  }
  if (existsSync(journal.bakBlobs)) {
    if (existsSync(journal.destBlobsDir)) {
      mkdirSync(journal.staging, { recursive: true })
      if (existsSync(stagingBlobs)) rmSync(stagingBlobs, { recursive: true, force: true })
      renameSync(journal.destBlobsDir, stagingBlobs)
    }
    renameSync(journal.bakBlobs, journal.destBlobsDir)
  }
  unlinkQuiet(restoreJournalPath(journal.destDbPath))
  rmSync(journal.staging, { recursive: true, force: true })
}

function completeRestoreFromStaging(journal: RestoreJournal): boolean {
  const stagingDb = join(journal.staging, 'sessions.db')
  const stagingBlobs = join(journal.staging, 'blobs')
  if (!existsSync(journal.destDbPath) && existsSync(stagingDb)) {
    mkdirSync(dirname(journal.destDbPath), { recursive: true })
    renameSync(stagingDb, journal.destDbPath)
  }
  if (!existsSync(journal.destBlobsDir) && existsSync(stagingBlobs)) {
    renameSync(stagingBlobs, journal.destBlobsDir)
  }
  return existsSync(journal.destDbPath) && existsSync(journal.destBlobsDir)
}

export function recoverRestoreIfNeeded(
  destDbPath: string,
  options: { liveDbOpen?: boolean } = {},
): 'noop' | 'completed' | 'rolled-back' {
  const journal = readRestoreJournal(destDbPath)
  if (!journal) return 'noop'
  const destDbExists = existsSync(journal.destDbPath)
  const destBlobsExist = existsSync(journal.destBlobsDir)
  const stagingBlobsExist = existsSync(join(journal.staging, 'blobs'))
  const stagingDbExists = existsSync(join(journal.staging, 'sessions.db'))
  const canComplete =
    (destDbExists && destBlobsExist) ||
    (destDbExists && !destBlobsExist && stagingBlobsExist) ||
    (!destDbExists && stagingDbExists && stagingBlobsExist && !options.liveDbOpen)
  if (canComplete) {
    if (!completeRestoreFromStaging(journal)) {
      if (options.liveDbOpen) return 'noop'
      rollbackRestoreJournal(journal)
      return 'rolled-back'
    }
    finishPublishedRestore(journal)
    return 'completed'
  }
  if (options.liveDbOpen) {
    if (journal.phase === 'prepared') {
      unlinkQuiet(restoreJournalPath(journal.destDbPath))
      rmSync(journal.staging, { recursive: true, force: true })
      return 'rolled-back'
    }
    return 'noop'
  }
  rollbackRestoreJournal(journal)
  return 'rolled-back'
}

export async function backupDatabaseAndBlobs(
  dbPath: string,
  destDir: string,
  options: { onProgress?: BlobScanProgress } = {},
): Promise<BlobBackupReport> {
  if (existsSync(destDir)) {
    throw new BlobBackupError(`Backup destination already exists: ${destDir}`)
  }
  mkdirSync(dirname(destDir), { recursive: true })
  const tmp = `${destDir}.tmp-${randomUUID()}`
  mkdirSync(tmp, { recursive: true })
  const source = new Database(dbPath, { timeout: 5000 })
  try {
    source.pragma('busy_timeout = 5000')
    await source.backup(join(tmp, 'sessions.db'))
  } finally {
    source.close()
  }
  parkAtBlobBarrier('after-sqlite-backup')

  const snapshot = new Database(join(tmp, 'sessions.db'), { readonly: true, fileMustExist: true })
  let refs: Array<{ hash: string; mime: string; size: number }>
  try {
    refs = [...collectBlobRefsFromEvents(snapshot, options.onProgress).values()].map((ref) => ({
      hash: ref.hash,
      mime: ref.mime,
      size: ref.size,
    }))
  } finally {
    snapshot.close()
  }

  const liveBlobs = new FileBlobStore(blobDirForDatabase(dbPath), { ownerDbPath: dbPath })
  const backupBlobs = new FileBlobStore(join(tmp, 'blobs'))
  parkAtBlobBarrier('before-blob-copy')
  try {
    for (const ref of refs) {
      if (!liveBlobs.has(ref.hash)) {
        throw new BlobBackupError(`Referenced blob missing during backup: ${ref.hash}`)
      }
      backupBlobs.copyBlobFrom(liveBlobs, ref.hash)
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }

  const manifest: BlobBackupManifest = {
    version: 1,
    complete: true,
    createdAt: new Date().toISOString(),
    dbFile: 'sessions.db',
    blobs: refs,
  }
  parkAtBlobBarrier('before-manifest')
  durableWriteFile(join(tmp, BLOB_BACKUP_MANIFEST), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  parkAtBlobBarrier('before-publish')
  if (existsSync(destDir)) {
    rmSync(tmp, { recursive: true, force: true })
    throw new BlobBackupError(`Backup destination already exists: ${destDir}`)
  }
  renameSync(tmp, destDir)
  return { dest: destDir, blobs: refs.length }
}

export function restoreDatabaseAndBlobs(backupDir: string, destDbPath: string): void {
  recoverRestoreIfNeeded(destDbPath)
  const manifest = readManifest(backupDir)
  const dbFile = join(backupDir, manifest.dbFile)
  if (!existsSync(dbFile)) throw new BlobBackupError(`Backup database missing: ${dbFile}`)
  const backupBlobs = new FileBlobStore(join(backupDir, 'blobs'))
  for (const ref of manifest.blobs) {
    if (!backupBlobs.has(ref.hash)) {
      throw new BlobBackupError(`Backup blob missing: ${ref.hash}`)
    }
  }

  const destBlobsDir = blobDirForDatabase(destDbPath)
  const staging = `${destDbPath}.restoring-${randomUUID()}`
  const journal: RestoreJournal = {
    version: 1,
    destDbPath,
    destBlobsDir,
    staging,
    bakDb: `${destDbPath}.pre-restore`,
    bakBlobs: `${destBlobsDir}.pre-restore`,
    phase: 'prepared',
  }
  mkdirSync(staging, { recursive: true })
  try {
    copyFileSync(dbFile, join(staging, 'sessions.db'))
    const stagedBlobs = new FileBlobStore(join(staging, 'blobs'))
    for (const ref of manifest.blobs) {
      stagedBlobs.copyBlobFrom(backupBlobs, ref.hash)
    }
    writeRestoreJournal(journal)
    parkAtBlobBarrier('before-restore-publish')

    removeSqliteAndSidecars(journal.bakDb)
    rmSync(journal.bakBlobs, { recursive: true, force: true })
    if (existsSync(destDbPath)) {
      renameSync(destDbPath, journal.bakDb)
      renameSqliteSidecars(destDbPath, journal.bakDb)
    }
    if (existsSync(destBlobsDir)) renameSync(destBlobsDir, journal.bakBlobs)
    journal.phase = 'old-retired'
    writeRestoreJournal(journal)

    mkdirSync(dirname(destDbPath), { recursive: true })
    renameSync(join(staging, 'sessions.db'), destDbPath)
    journal.phase = 'db-published'
    writeRestoreJournal(journal)
    parkAtBlobBarrier('after-restore-db-publish')
    failRestoreIfInjected('blobs-rename')
    renameSync(join(staging, 'blobs'), destBlobsDir)
    journal.phase = 'published'
    writeRestoreJournal(journal)
    finishPublishedRestore(journal)
  } catch (error) {
    const current = readRestoreJournal(destDbPath) ?? journal
    try {
      rollbackRestoreJournal(current)
    } catch {
      recoverRestoreIfNeeded(destDbPath)
    }
    throw error
  } finally {
    if (!existsSync(restoreJournalPath(destDbPath))) {
      rmSync(staging, { recursive: true, force: true })
    }
  }
}
