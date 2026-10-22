import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parkAtBlobBarrier } from './blob-barrier.js'
import { collectBlobRefsFromJsonStrings } from './blob-codec.js'
import { FileBlobStore, blobDirForDatabase, durableWriteFile, ownerIdForDatabase } from './blob-store.js'

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

function collectRefsFromDb(db: Database.Database): Array<{ hash: string; mime: string; size: number }> {
  const rows = db.prepare('SELECT payload FROM events').all() as Array<{ payload: string }>
  const byHash = new Map<string, { hash: string; mime: string; size: number }>()
  for (const ref of collectBlobRefsFromJsonStrings(rows.map((row) => row.payload))) {
    byHash.set(ref.hash, { hash: ref.hash, mime: ref.mime, size: ref.size })
  }
  return [...byHash.values()]
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

export async function backupDatabaseAndBlobs(dbPath: string, destDir: string): Promise<BlobBackupReport> {
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
    refs = collectRefsFromDb(snapshot)
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
      const record = liveBlobs.get(ref.hash)
      backupBlobs.put(record.bytes, record.mime)
      backupBlobs.clearPending(record.hash)
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
  mkdirSync(dirname(destDir), { recursive: true })
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
    const record = backupBlobs.get(ref.hash)
    if (record.size !== ref.size) throw new BlobBackupError(`Backup blob size mismatch: ${ref.hash}`)
  }
  mkdirSync(dirname(destDbPath), { recursive: true })
  durableWriteFile(destDbPath, readFileSync(dbFile))
  const destBlobs = new FileBlobStore(blobDirForDatabase(destDbPath), { ownerDbPath: destDbPath })
  for (const ref of manifest.blobs) {
    const record = backupBlobs.get(ref.hash)
    destBlobs.put(record.bytes, record.mime)
    destBlobs.clearPending(record.hash)
  }
  destBlobs.registerOwner(ownerIdForDatabase(destDbPath))
}
