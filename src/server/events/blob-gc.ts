import type Database from 'better-sqlite3'
import { parkAtBlobBarrier } from './blob-barrier.js'
import { collectBlobRefsFromEvents, type BlobScanProgress } from './blob-scan.js'
import { BlobStoreOwnerError, FileBlobStore, type BlobStore } from './blob-store.js'

export interface BlobGcReport {
  scanned: number
  referenced: number
  deleted: number
  keptPending: number
  staleTemps: number
}

export function referencedBlobHashes(
  db: Database.Database,
  store: FileBlobStore,
  onProgress?: BlobScanProgress,
): Set<string> {
  store.assertOwner(db.name)
  return new Set(collectBlobRefsFromEvents(db, onProgress).keys())
}

export function gcBlobs(
  db: Database.Database,
  store: BlobStore,
  options: { onProgress?: BlobScanProgress } = {},
): BlobGcReport {
  if (!(store instanceof FileBlobStore)) {
    return { scanned: 0, referenced: 0, deleted: 0, keptPending: 0, staleTemps: 0 }
  }
  store.assertOwner(db.name)
  const referenced = referencedBlobHashes(db, store, options.onProgress)
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
