import type { Attachment, BlobRef, BlobRefOrigin } from '../../shared/types.js'
import { isBlobRef } from '../../shared/blob.js'
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
  next['blob'] = { ...blob, origin: 'data' satisfies BlobRefOrigin }
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
      next['blob'] = { ...store.put(bytes, mime), origin: 'base64Data' satisfies BlobRefOrigin }
      continue
    }
    if ((key === 'dataUrl' || key === 'url') && typeof child === 'string' && isBinaryDataUrl(child)) {
      if (isBlobRef(next['blob'])) continue
      const decoded = decodeBinaryString(
        child,
        typeof obj['mimeType'] === 'string' ? obj['mimeType'] : 'application/octet-stream',
      )
      if (decoded) {
        const origin: BlobRefOrigin = key === 'url' ? 'url' : 'dataUrl'
        next['blob'] = { ...store.put(decoded.bytes, decoded.mime), origin }
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

export function collectBlobRefs(value: unknown, out: BlobRef[] = []): BlobRef[] {
  if (isBlobRef(value)) {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectBlobRefs(child, out)
  }
  return out
}

export function payloadHasBlobRef(payload: string): boolean {
  try {
    return collectBlobRefs(JSON.parse(payload)).length > 0
  } catch {
    return false
  }
}

export class BlobRollbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlobRollbackError'
  }
}

function dataUrlFromRecord(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function resolveBlobOrigin(obj: Record<string, unknown>, blob: BlobRef): BlobRefOrigin {
  if (blob.origin === 'url' || blob.origin === 'data') return blob.origin
  if (typeof obj['filename'] === 'string' || typeof obj['id'] === 'string') return 'data'
  if (typeof obj['mimeType'] === 'string') return 'base64Data'
  if (blob.origin === 'dataUrl' || blob.origin === 'base64Data') return blob.origin
  if (obj['type'] === 'image_url') return 'url'
  throw new BlobRollbackError('Ambiguous blob origin; refusing rollback before switch')
}

function applyBlobOrigin(next: Record<string, unknown>, origin: BlobRefOrigin, mime: string, bytes: Buffer): void {
  const dataUrl = dataUrlFromRecord(mime, bytes)
  if (origin === 'data') {
    next['data'] = dataUrl
    return
  }
  if (origin === 'url') {
    next['url'] = dataUrl
    return
  }
  if (origin === 'dataUrl') {
    next['dataUrl'] = dataUrl
    return
  }
  next['base64Data'] = bytes.toString('base64')
  next['dataUrl'] = dataUrl
}

function reinlineNode(value: unknown, store: BlobStore): unknown {
  if (Array.isArray(value)) return value.map((item) => reinlineNode(item, store))
  if (isBlobRef(value)) {
    const record = store.get(value.hash)
    return dataUrlFromRecord(record.mime, record.bytes)
  }
  if (!value || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  const blob = obj['blob']
  const base: Record<string, unknown> = { ...obj }
  if (isBlobRef(blob)) {
    const record = store.get(blob.hash)
    delete base['blob']
    applyBlobOrigin(base, resolveBlobOrigin(obj, blob), record.mime, record.bytes)
  }
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(base)) {
    next[key] = reinlineNode(child, store)
  }
  return next
}

export function reinlineBinaries(data: unknown, store: BlobStore): unknown {
  return reinlineNode(data, store)
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

export function attachmentFromToolImageMetadata(metadata: Record<string, unknown> | undefined): Attachment | undefined {
  if (!metadata) return undefined
  const mime = typeof metadata['mimeType'] === 'string' ? metadata['mimeType'] : ''
  if (!mime.startsWith('image/')) return undefined
  const filename = typeof metadata['path'] === 'string' && metadata['path'] ? metadata['path'] : 'image'
  const size = typeof metadata['size'] === 'number' ? metadata['size'] : 0
  const description = typeof metadata['description'] === 'string' ? metadata['description'] : undefined
  const base = {
    id: 'tool-image',
    filename,
    mimeType: mime,
    size,
    ...(description ? { description } : {}),
  }
  const blob = metadata['blob']
  if (isBlobRef(blob)) {
    return { ...base, size: blob.size, blob }
  }
  const dataUrl = metadata['dataUrl']
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
    return { ...base, data: dataUrl }
  }
  const base64Data = metadata['base64Data']
  if (typeof base64Data === 'string' && base64Data.length > 0) {
    return { ...base, data: `data:${mime};base64,${base64Data}` }
  }
  return undefined
}

export function collectBlobRefsFromJsonStrings(payloads: Iterable<string>): BlobRef[] {
  const out: BlobRef[] = []
  for (const payload of payloads) {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new Error('Unreadable event payload; refusing blob scan')
    }
    collectBlobRefs(parsed, out)
  }
  return out
}
