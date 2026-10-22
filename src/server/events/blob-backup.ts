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

function uniqueManifestHashes(listed: Array<{ hash: string }>): Set<string> {
  const hashes = new Set<string>()
  for (const item of listed) {
    if (hashes.has(item.hash)) {
      throw new BlobBackupError(`Backup manifest duplicate ref: ${item.hash}`)
    }
    hashes.add(item.hash)
  }
  return hashes
}

function assertExactRefSets(listedHashes: Set<string>, fromDb: Iterable<string>): void {
  const dbHashes = new Set(fromDb)
  if (listedHashes.size !== dbHashes.size) {
    throw new BlobBackupError('Backup manifest does not match database blob refs')
  }
  for (const hash of dbHashes) {
    if (!listedHashes.has(hash)) {
      throw new BlobBackupError(`Backup manifest missing or mismatched ref: ${hash}`)
    }
  }
}

function assertManifestMatchesRefs(
  listed: Array<{ hash: string; mime: string; size: number }>,
  fromDb: Map<string, { hash: string; mime: string; size: number }>,
): void {
  const listedHashes = uniqueManifestHashes(listed)
  assertExactRefSets(listedHashes, fromDb.keys())
  for (const item of listed) {
    const ref = fromDb.get(item.hash)
    if (!ref || ref.mime !== item.mime || ref.size !== item.size) {
      throw new BlobBackupError(`Backup manifest missing or mismatched ref: ${item.hash}`)
    }
  }
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

type RestorePhase = 'prepared' | 'db-retired' | 'old-retired' | 'db-published' | 'published' | 'rolling-back'

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

function setRestorePhase(journal: RestoreJournal, phase: RestorePhase): void {
  journal.phase = phase
  writeRestoreJournal(journal)
}

function failRestoreIfInjected(step: string): void {
  if (process.env['OPENFOX_BLOB_RESTORE_FAIL'] === step) {
    throw new BlobBackupError(`injected restore failure: ${step}`)
  }
}

function stagingDbPath(journal: RestoreJournal): string {
  return join(journal.staging, 'sessions.db')
}

function stagingBlobsPath(journal: RestoreJournal): string {
  return join(journal.staging, 'blobs')
}

function finishPublishedRestore(journal: RestoreJournal): void {
  removeSqliteAndSidecars(journal.bakDb)
  rmSync(journal.bakBlobs, { recursive: true, force: true })
  unlinkQuiet(restoreJournalPath(journal.destDbPath))
  rmSync(journal.staging, { recursive: true, force: true })
  new FileBlobStore(journal.destBlobsDir, { ownerDbPath: journal.destDbPath })
}

function reuniteSqliteSidecars(journal: RestoreJournal): void {
  if (existsSync(journal.bakDb)) {
    renameSqliteSidecars(journal.destDbPath, journal.bakDb)
  }
}

function retireDestDb(journal: RestoreJournal): void {
  if (!existsSync(journal.bakDb) && existsSync(journal.destDbPath)) {
    renameSync(journal.destDbPath, journal.bakDb)
    parkAtBlobBarrier('after-restore-db-file-retired')
    renameSqliteSidecars(journal.destDbPath, journal.bakDb)
    parkAtBlobBarrier('after-restore-wal-retired')
  } else {
    reuniteSqliteSidecars(journal)
  }
}

function retireDestBlobs(journal: RestoreJournal): void {
  if (!existsSync(journal.bakBlobs) && existsSync(journal.destBlobsDir)) {
    renameSync(journal.destBlobsDir, journal.bakBlobs)
  }
}

function publishDestDb(journal: RestoreJournal): void {
  const stagingDb = stagingDbPath(journal)
  reuniteSqliteSidecars(journal)
  unlinkSqliteSidecars(journal.destDbPath)
  if (!existsSync(journal.destDbPath) && existsSync(stagingDb)) {
    mkdirSync(dirname(journal.destDbPath), { recursive: true })
    renameSync(stagingDb, journal.destDbPath)
  }
}

function publishDestBlobs(journal: RestoreJournal): void {
  const stagingBlobs = stagingBlobsPath(journal)
  if (!existsSync(journal.destBlobsDir) && existsSync(stagingBlobs)) {
    renameSync(stagingBlobs, journal.destBlobsDir)
  }
}

function dropRestoreWork(journal: RestoreJournal): void {
  unlinkQuiet(restoreJournalPath(journal.destDbPath))
  rmSync(journal.staging, { recursive: true, force: true })
}

function rollbackRestoreJournal(journal: RestoreJournal): void {
  setRestorePhase(journal, 'rolling-back')
  parkAtBlobBarrier('before-restore-rollback')
  reuniteSqliteSidecars(journal)
  if (existsSync(journal.bakDb)) {
    if (existsSync(journal.destDbPath)) {
      mkdirSync(journal.staging, { recursive: true })
      const stagingDb = stagingDbPath(journal)
      if (existsSync(stagingDb)) unlinkQuiet(stagingDb)
      renameSync(journal.destDbPath, stagingDb)
      unlinkSqliteSidecars(journal.destDbPath)
    }
    parkAtBlobBarrier('after-restore-rollback-db-file')
    renameSync(journal.bakDb, journal.destDbPath)
    renameSqliteSidecars(journal.bakDb, journal.destDbPath)
  }
  parkAtBlobBarrier('after-restore-rollback-db')
  if (existsSync(journal.bakBlobs)) {
    if (existsSync(journal.destBlobsDir)) {
      mkdirSync(journal.staging, { recursive: true })
      const stagingBlobs = stagingBlobsPath(journal)
      if (existsSync(stagingBlobs)) rmSync(stagingBlobs, { recursive: true, force: true })
      renameSync(journal.destBlobsDir, stagingBlobs)
    }
    renameSync(journal.bakBlobs, journal.destBlobsDir)
  }
  parkAtBlobBarrier('after-restore-rollback-blobs')
  dropRestoreWork(journal)
}

function replayRestoreForward(journal: RestoreJournal): 'completed' | 'rolled-back' {
  if (journal.phase === 'db-retired') {
    retireDestBlobs(journal)
    setRestorePhase(journal, 'old-retired')
  }
  if (journal.phase === 'old-retired') {
    publishDestDb(journal)
    if (!existsSync(journal.destDbPath)) {
      rollbackRestoreJournal(journal)
      return 'rolled-back'
    }
    setRestorePhase(journal, 'db-published')
  }
  if (journal.phase === 'db-published') {
    parkAtBlobBarrier('after-restore-recover-db')
    publishDestBlobs(journal)
    if (!existsSync(journal.destBlobsDir)) {
      rollbackRestoreJournal(journal)
      return 'rolled-back'
    }
    setRestorePhase(journal, 'published')
    parkAtBlobBarrier('after-restore-recover-blobs')
  }
  if (journal.phase === 'published') {
    finishPublishedRestore(journal)
    return 'completed'
  }
  rollbackRestoreJournal(journal)
  return 'rolled-back'
}

export function recoverRestoreIfNeeded(destDbPath: string): 'noop' | 'completed' | 'rolled-back' {
  const journal = readRestoreJournal(destDbPath)
  if (!journal) return 'noop'
  parkAtBlobBarrier('before-restore-recover')
  reuniteSqliteSidecars(journal)
  if (journal.phase === 'prepared' || journal.phase === 'rolling-back') {
    rollbackRestoreJournal(journal)
    return 'rolled-back'
  }
  return replayRestoreForward(journal)
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
      backupBlobs.copyBlobFrom(liveBlobs, ref)
    }
    const again = new Database(join(tmp, 'sessions.db'), { readonly: true, fileMustExist: true })
    try {
      assertManifestMatchesRefs(refs, collectBlobRefsFromEvents(again))
    } finally {
      again.close()
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error instanceof BlobBackupError ? error : new BlobBackupError(String(error))
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
  const backupSqlite = new Database(dbFile, { readonly: true, fileMustExist: true })
  let dbRefs: Map<string, { hash: string; mime: string; size: number }>
  try {
    dbRefs = collectBlobRefsFromEvents(backupSqlite)
  } finally {
    backupSqlite.close()
  }
  assertManifestMatchesRefs(manifest.blobs, dbRefs)
  const backupBlobs = new FileBlobStore(join(backupDir, 'blobs'))
  for (const ref of manifest.blobs) {
    const record = backupBlobs.get(ref.hash)
    if (record.mime !== ref.mime || record.size !== ref.size || record.hash !== ref.hash) {
      throw new BlobBackupError(`Backup blob mismatch: ${ref.hash}`)
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
      stagedBlobs.copyBlobFrom(backupBlobs, ref)
    }
    writeRestoreJournal(journal)
    parkAtBlobBarrier('before-restore-publish')

    removeSqliteAndSidecars(journal.bakDb)
    rmSync(journal.bakBlobs, { recursive: true, force: true })
    retireDestDb(journal)
    setRestorePhase(journal, 'db-retired')
    parkAtBlobBarrier('after-restore-db-retired')
    retireDestBlobs(journal)
    setRestorePhase(journal, 'old-retired')
    parkAtBlobBarrier('after-restore-old-retired')
    publishDestDb(journal)
    setRestorePhase(journal, 'db-published')
    parkAtBlobBarrier('after-restore-db-publish')
    failRestoreIfInjected('blobs-rename')
    publishDestBlobs(journal)
    setRestorePhase(journal, 'published')
    parkAtBlobBarrier('after-restore-blobs-publish')
    finishPublishedRestore(journal)
  } catch (error) {
    const current = readRestoreJournal(destDbPath) ?? journal
    try {
      if (current.phase === 'prepared' || current.phase === 'rolling-back') {
        rollbackRestoreJournal(current)
      } else {
        recoverRestoreIfNeeded(destDbPath)
      }
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
