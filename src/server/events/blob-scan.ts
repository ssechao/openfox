import type Database from 'better-sqlite3'
import type { BlobRef } from '../../shared/blob.js'
import { collectBlobRefs } from './blob-codec.js'

export type BlobScanProgress = (scanned: number, refs: number) => void

export class BlobScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlobScanError'
  }
}

/** Walk events.payload one row at a time; keep only BlobRefs, never the payload set. */
export function collectBlobRefsFromEvents(db: Database.Database, onProgress?: BlobScanProgress): Map<string, BlobRef> {
  const byHash = new Map<string, BlobRef>()
  const stmt = db.prepare('SELECT payload FROM events')
  let scanned = 0
  for (const row of stmt.iterate() as IterableIterator<{ payload: string }>) {
    scanned++
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      throw new BlobScanError('Unreadable event payload; refusing blob scan')
    }
    for (const ref of collectBlobRefs(parsed)) {
      byHash.set(ref.hash, ref)
    }
    if (onProgress && scanned % 500 === 0) onProgress(scanned, byHash.size)
  }
  onProgress?.(scanned, byHash.size)
  return byHash
}
