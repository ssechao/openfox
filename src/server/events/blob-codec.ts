import type { Attachment, BlobRef } from '../../shared/types.js'
import { decodeDataUrl } from '../utils/data-url.js'
import { BlobMissingError, getBlobStore, type BlobStore } from './blob-store.js'

const DATA_URL_PREFIX = /^data:(image\/[a-z0-9.+-]+|application\/pdf|application\/octet-stream)/i

export function isBinaryDataUrl(value: string): boolean {
  return value.startsWith('data:') && DATA_URL_PREFIX.test(value) && value.includes(';base64,')
}

export function isBinaryMime(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'application/pdf' || mime === 'application/octet-stream'
}

function mimeFromDataUrl(dataUrl: string, fallback: string): string {
  const match = dataUrl.match(/^data:([^;,]+)/i)
  return match?.[1] ?? fallback
}

function decodeBinaryString(value: string, mimeHint: string): { bytes: Buffer; mime: string } | null {
  if (isBinaryDataUrl(value)) {
    const bytes = decodeDataUrl(value)
    if (!bytes) return null
    return { bytes, mime: mimeFromDataUrl(value, mimeHint) }
  }
  if (isBinaryMime(mimeHint) && !value.startsWith('data:')) {
    try {
      return { bytes: Buffer.from(value, 'base64'), mime: mimeHint }
    } catch {
      return null
    }
  }
  return null
}

function payloadLooksBinary(value: unknown): boolean {
  if (typeof value === 'string') {
    return isBinaryDataUrl(value) || value.includes('data:image') || value.includes('data:application/pdf')
  }
  if (Array.isArray(value)) return value.some(payloadLooksBinary)
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'base64Data' && typeof child === 'string' && child.length > 0) return true
      if (payloadLooksBinary(child)) return true
    }
  }
  return false
}

function extractAttachment(att: Record<string, unknown>, store: BlobStore): Record<string, unknown> {
  if (att['blob'] && !att['data']) return att
  const mime = typeof att['mimeType'] === 'string' ? att['mimeType'] : 'application/octet-stream'
  const data = att['data']
  if (typeof data !== 'string' || data.length === 0) return att
  if (!isBinaryMime(mime) && !isBinaryDataUrl(data)) return att
  const decoded = decodeBinaryString(data, mime)
  if (!decoded) return att
  const blob = store.put(decoded.bytes, decoded.mime)
  const next = { ...att }
  delete next['data']
  next['blob'] = blob
  return next
}

function extractNode(value: unknown, store: BlobStore): unknown {
  if (Array.isArray(value)) return value.map((item) => extractNode(item, store))
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && isBinaryDataUrl(value)) {
      const decoded = decodeBinaryString(value, 'application/octet-stream')
      if (decoded) return store.put(decoded.bytes, decoded.mime)
    }
    return value
  }
  const obj = value as Record<string, unknown>
  if (typeof obj['mimeType'] === 'string' && 'data' in obj) {
    return extractAttachment(obj, store)
  }
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'base64Data' && typeof child === 'string' && child.length > 0) {
      const mime =
        typeof obj['mimeType'] === 'string' && isBinaryMime(obj['mimeType'])
          ? obj['mimeType']
          : 'application/octet-stream'
      const bytes = Buffer.from(child, 'base64')
      next['blob'] = store.put(bytes, mime)
      continue
    }
    if ((key === 'dataUrl' || key === 'url') && typeof child === 'string' && isBinaryDataUrl(child)) {
      const decoded = decodeBinaryString(
        child,
        typeof obj['mimeType'] === 'string' ? obj['mimeType'] : 'application/octet-stream',
      )
      if (decoded) {
        next['blob'] = store.put(decoded.bytes, decoded.mime)
        continue
      }
    }
    next[key] = extractNode(child, store)
  }
  return next
}

export function extractBinaries(data: unknown, store: BlobStore): unknown {
  if (!payloadLooksBinary(data)) return data
  return extractNode(data, store)
}

export function payloadHasInlineBinary(payload: string): boolean {
  return payload.includes('data:image') || payload.includes('data:application/pdf') || payload.includes('"base64Data"')
}

export function hydrateAttachmentData(attachment: Attachment, store?: BlobStore): string {
  if (typeof attachment.data === 'string' && attachment.data.length > 0) return attachment.data
  const blob = attachment.blob
  if (!blob) {
    throw new BlobMissingError('(attachment has neither data nor blob)')
  }
  const record = (store ?? getBlobStore()).get(blob.hash)
  return `data:${record.mime};base64,${record.bytes.toString('base64')}`
}

export function hydrateAttachment(attachment: Attachment, store?: BlobStore): Attachment {
  if (typeof attachment.data === 'string' && attachment.data.length > 0) return attachment
  return { ...attachment, data: hydrateAttachmentData(attachment, store) }
}

export function blobRefBytes(ref: BlobRef, store?: BlobStore): Buffer {
  return (store ?? getBlobStore()).get(ref.hash).bytes
}
