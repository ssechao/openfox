import type Database from 'better-sqlite3'
import DatabaseCtor from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { parkAtBlobBarrier } from './blob-barrier.js'
import { collectBlobRefsFromJsonStrings } from './blob-codec.js'
import { BlobStoreOwnerError, FileBlobStore, type BlobStore } from './blob-store.js'

export interface BlobGcReport {
  scanned: number
  referenced: number
  deleted: number
  keptPending: number
  staleTemps: number
}

function collectRefsFromDatabase(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT payload FROM events').all() as Array<{ payload: string }>
  return new Set(collectBlobRefsFromJsonStrings(rows.map((row) => row.payload)).map((ref) => ref.hash))
}

export function referencedBlobHashes(db: Database.Database, store: FileBlobStore): Set<string> {
  const hashes = collectRefsFromDatabase(db)
  const self = db.name
  for (const owner of store.ownerDatabases()) {
    if (!owner || owner === self || !existsSync(owner)) continue
    const extra = new DatabaseCtor(owner, { readonly: true, fileMustExist: true, timeout: 5000 })
    try {
      for (const hash of collectRefsFromDatabase(extra)) hashes.add(hash)
    } finally {
      extra.close()
    }
  }
  return hashes
}

export function gcBlobs(db: Database.Database, store: BlobStore): BlobGcReport {
  if (!(store instanceof FileBlobStore)) {
    return { scanned: 0, referenced: 0, deleted: 0, keptPending: 0, staleTemps: 0 }
  }
  store.assertOwner(db.name)
  const referenced = referencedBlobHashes(db, store)
  const livePending = store.livePendingHashes()
  const onDisk = store.listStoredHashes()
  parkAtBlobBarrier('after-gc-scan')
  let deleted = 0
  for (const hash of onDisk) {
    if (referenced.has(hash) || livePending.has(hash)) continue
    parkAtBlobBarrier('before-gc-delete')
    store.removeBlob(hash)
    deleted++
  }
  const staleTemps = store.removeStaleTempFiles()
  parkAtBlobBarrier('after-gc')
  return {
    scanned: onDisk.length,
    referenced: referenced.size,
    deleted,
    keptPending: livePending.size,
    staleTemps,
  }
}

export { BlobStoreOwnerError }
