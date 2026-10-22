import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BlobRef } from '../../shared/blob.js'
import { isBlobHash } from '../../shared/blob.js'

export class BlobMissingError extends Error {
  readonly hash: string
  constructor(hash: string) {
    super(`Blob not found: ${hash}`)
    this.name = 'BlobMissingError'
    this.hash = hash
  }
}

export class BlobCorruptError extends Error {
  readonly hash: string
  constructor(hash: string) {
    super(`Blob corrupt: ${hash}`)
    this.name = 'BlobCorruptError'
    this.hash = hash
  }
}

export class BlobHashError extends Error {
  constructor(value: string) {
    super(`Invalid blob hash: ${value}`)
    this.name = 'BlobHashError'
  }
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface BlobRecord {
  bytes: Buffer
  mime: string
  size: number
  hash: string
}

export interface BlobStore {
  put(bytes: Buffer, mime: string): BlobRef
  get(hash: string): BlobRecord
  has(hash: string): boolean
}

let singleton: BlobStore | null = null

export function setBlobStore(store: BlobStore | null): void {
  singleton = store
}

export function getBlobStore(): BlobStore {
  if (!singleton) {
    throw new BlobMissingError('(uninitialized)')
  }
  return singleton
}

function assertHash(hash: string): void {
  if (!isBlobHash(hash)) throw new BlobHashError(hash)
}

function durableWriteFile(finalPath: string, bytes: Buffer): void {
  const dir = dirname(finalPath)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${randomUUID()}`)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, finalPath)
  if (process.platform !== 'win32') {
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  }
}

export class FileBlobStore implements BlobStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  private dirFor(hash: string): string {
    return join(this.root, hash.slice(0, 2))
  }

  private bodyPath(hash: string): string {
    return join(this.dirFor(hash), hash)
  }

  private mimePath(hash: string): string {
    return `${this.bodyPath(hash)}.mime`
  }

  put(bytes: Buffer, mime: string): BlobRef {
    const hash = hashBytes(bytes)
    const body = this.bodyPath(hash)
    if (!existsSync(body)) {
      durableWriteFile(body, bytes)
    }
    const mimeFile = this.mimePath(hash)
    if (!existsSync(mimeFile)) {
      durableWriteFile(mimeFile, Buffer.from(mime, 'utf8'))
    }
    return { hash, mime, size: bytes.length }
  }

  has(hash: string): boolean {
    if (!isBlobHash(hash)) return false
    return existsSync(this.bodyPath(hash))
  }

  get(hash: string): BlobRecord {
    assertHash(hash)
    const body = this.bodyPath(hash)
    if (!existsSync(body)) throw new BlobMissingError(hash)
    const bytes = readFileSync(body)
    if (hashBytes(bytes) !== hash) throw new BlobCorruptError(hash)
    let mime = 'application/octet-stream'
    const mimeFile = this.mimePath(hash)
    if (existsSync(mimeFile)) {
      mime = readFileSync(mimeFile, 'utf8')
    }
    return { bytes, mime, size: bytes.length, hash }
  }

  /** Test helper: overwrite stored bytes without updating the hash name. */
  corruptForTest(hash: string): void {
    assertHash(hash)
    const body = this.bodyPath(hash)
    writeFileSync(body, Buffer.concat([readFileSync(body), Buffer.from([0xff])]))
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly files = new Map<string, { bytes: Buffer; mime: string }>()

  put(bytes: Buffer, mime: string): BlobRef {
    const hash = hashBytes(bytes)
    if (!this.files.has(hash)) {
      this.files.set(hash, { bytes: Buffer.from(bytes), mime })
    }
    return { hash, mime, size: bytes.length }
  }

  has(hash: string): boolean {
    return isBlobHash(hash) && this.files.has(hash)
  }

  get(hash: string): BlobRecord {
    assertHash(hash)
    const entry = this.files.get(hash)
    if (!entry) throw new BlobMissingError(hash)
    if (hashBytes(entry.bytes) !== hash) throw new BlobCorruptError(hash)
    return { bytes: entry.bytes, mime: entry.mime, size: entry.bytes.length, hash }
  }

  corruptForTest(hash: string): void {
    const entry = this.files.get(hash)
    if (!entry) throw new BlobMissingError(hash)
    this.files.set(hash, { bytes: Buffer.concat([entry.bytes, Buffer.from([0xff])]), mime: entry.mime })
  }
}

export function blobStoreForDatabase(dbPath: string | undefined): BlobStore {
  if (!dbPath || dbPath === ':memory:') return new MemoryBlobStore()
  return new FileBlobStore(join(dirname(dbPath), 'blobs'))
}

export function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // missing is fine
  }
}
