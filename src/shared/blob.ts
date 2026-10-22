import type { Attachment, BlobRef } from './types.js'

export type { BlobRef }

export const BLOB_HASH_RE = /^[a-f0-9]{64}$/

export function isBlobHash(value: string): boolean {
  return BLOB_HASH_RE.test(value)
}

export function blobUrl(hash: string, token?: string): string {
  const path = `/api/blobs/${hash}`
  return token ? `${path}?token=${encodeURIComponent(token)}` : path
}

export function isBlobRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return (
    typeof ref['hash'] === 'string' &&
    isBlobHash(ref['hash']) &&
    typeof ref['mime'] === 'string' &&
    ref['mime'].length > 0 &&
    typeof ref['size'] === 'number' &&
    Number.isInteger(ref['size']) &&
    ref['size'] >= 0
  )
}

export function attachmentDisplaySrc(attachment: Attachment, token?: string): string {
  if (attachment.blob) return blobUrl(attachment.blob.hash, token)
  return attachment.data ?? ''
}
