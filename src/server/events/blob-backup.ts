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

function unlinkSqliteSidecars(dbPath: string): void {
  unlinkQuiet(`${dbPath}-wal`)
  unlinkQuiet(`${dbPath}-shm`)
  unlinkQuiet(`${dbPath}-journal`)
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
  const manifest = readManifest(backupDir)
  const dbFile = join(backupDir, manifest.dbFile)
  if (!existsSync(dbFile)) throw new BlobBackupError(`Backup database missing: ${dbFile}`)
  const backupBlobs = new FileBlobStore(join(backupDir, 'blobs'))
  for (const ref of manifest.blobs) {
    if (!backupBlobs.has(ref.hash)) {
      throw new BlobBackupError(`Backup blob missing: ${ref.hash}`)
    }
  }

  const staging = `${destDbPath}.restoring-${randomUUID()}`
  mkdirSync(staging, { recursive: true })
  try {
    copyFileSync(dbFile, join(staging, 'sessions.db'))
    const stagedBlobs = new FileBlobStore(join(staging, 'blobs'))
    for (const ref of manifest.blobs) {
      stagedBlobs.copyBlobFrom(backupBlobs, ref.hash)
    }
    parkAtBlobBarrier('before-restore-publish')

    const destBlobsDir = blobDirForDatabase(destDbPath)
    unlinkSqliteSidecars(destDbPath)
    const bakDb = `${destDbPath}.pre-restore`
    const bakBlobs = `${destBlobsDir}.pre-restore`
    rmSync(bakDb, { force: true })
    rmSync(bakBlobs, { recursive: true, force: true })
    if (existsSync(destDbPath)) renameSync(destDbPath, bakDb)
    if (existsSync(destBlobsDir)) renameSync(destBlobsDir, bakBlobs)
    try {
      mkdirSync(dirname(destDbPath), { recursive: true })
      renameSync(join(staging, 'sessions.db'), destDbPath)
      renameSync(join(staging, 'blobs'), destBlobsDir)
    } catch (error) {
      if (!existsSync(destDbPath) && existsSync(bakDb)) renameSync(bakDb, destDbPath)
      if (!existsSync(destBlobsDir) && existsSync(bakBlobs)) renameSync(bakBlobs, destBlobsDir)
      throw error
    }
    rmSync(bakDb, { force: true })
    rmSync(bakBlobs, { recursive: true, force: true })
    new FileBlobStore(destBlobsDir, { ownerDbPath: destDbPath })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
