import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { BlobRef } from '../../shared/blob.js'
import { isBlobHash } from '../../shared/blob.js'
import { pidIsAlive } from '../db/instance-lock.js'

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

export class BlobStoreOwnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlobStoreOwnerError'
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
  clearPending?(hash: string): void
}

export const BLOB_DIR_MARKER = '.openfox-db'

export function blobDirForDatabase(dbPath: string): string {
  return `${dbPath}.blobs`
}

export function ownerIdForDatabase(dbPath: string): string {
  try {
    return realpathSync(dbPath)
  } catch {
    return resolve(dbPath)
  }
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

export function durableWriteFile(finalPath: string, bytes: Buffer): void {
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

interface BlobDirMarker {
  owner: string
}

export class FileBlobStore implements BlobStore {
  constructor(
    readonly root: string,
    options: { ownerDbPath?: string } = {},
  ) {
    mkdirSync(root, { recursive: true })
    if (options.ownerDbPath) this.registerOwner(options.ownerDbPath)
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

  private pendingPath(hash: string): string {
    return join(this.root, '.pending', hash)
  }

  private markerPath(): string {
    return join(this.root, BLOB_DIR_MARKER)
  }

  readMarker(): BlobDirMarker | null {
    const path = this.markerPath()
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { owner?: string; owners?: string[] }
      if (typeof parsed.owner === 'string' && parsed.owner.length > 0) {
        return { owner: parsed.owner }
      }
      if (Array.isArray(parsed.owners) && parsed.owners.length === 1 && typeof parsed.owners[0] === 'string') {
        return { owner: parsed.owners[0] }
      }
    } catch {
      return null
    }
    return null
  }

  registerOwner(dbPath: string): void {
    const owner = ownerIdForDatabase(dbPath)
    const current = this.readMarker()
    if (current && current.owner !== owner && current.owner !== resolve(dbPath)) {
      throw new BlobStoreOwnerError(`Blob store ${this.root} is owned by ${current.owner}, not ${owner}`)
    }
    if (!current) {
      durableWriteFile(this.markerPath(), Buffer.from(JSON.stringify({ owner }, null, 2), 'utf8'))
    }
  }

  assertOwner(dbPath: string): void {
    const marker = this.readMarker()
    if (!marker) {
      throw new BlobStoreOwnerError(`Blob store marker missing in ${this.root}`)
    }
    const owner = ownerIdForDatabase(dbPath)
    if (marker.owner !== owner && marker.owner !== resolve(dbPath)) {
      throw new BlobStoreOwnerError(`Blob store marker does not match ${owner} (owner: ${marker.owner})`)
    }
  }

  private writePending(hash: string): void {
    mkdirSync(join(this.root, '.pending'), { recursive: true })
    durableWriteFile(this.pendingPath(hash), Buffer.from(String(process.pid), 'utf8'))
  }

  clearPending(hash: string): void {
    if (!isBlobHash(hash)) return
    unlinkQuiet(this.pendingPath(hash))
  }

  livePendingHashes(): Set<string> {
    const pendingDir = join(this.root, '.pending')
    const live = new Set<string>()
    if (!existsSync(pendingDir)) return live
    for (const name of readdirSync(pendingDir)) {
      if (!isBlobHash(name)) continue
      const raw = readFileSync(join(pendingDir, name), 'utf8').trim()
      const pid = Number(raw)
      if (pidIsAlive(pid)) live.add(name)
    }
    return live
  }

  listStoredHashes(): string[] {
    if (!existsSync(this.root)) return []
    const hashes: string[] = []
    for (const ent of readdirSync(this.root, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^[a-f0-9]{2}$/.test(ent.name)) continue
      for (const file of readdirSync(join(this.root, ent.name))) {
        if (isBlobHash(file)) hashes.push(file)
      }
    }
    return hashes
  }

  removeBlob(hash: string): void {
    assertHash(hash)
    unlinkQuiet(this.bodyPath(hash))
    unlinkQuiet(this.mimePath(hash))
    unlinkQuiet(this.pendingPath(hash))
  }

  removeStaleTempFiles(): number {
    if (this.livePendingHashes().size > 0) return 0
    if (!existsSync(this.root)) return 0
    let removed = 0
    for (const ent of readdirSync(this.root, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^[a-f0-9]{2}$/.test(ent.name)) continue
      const dir = join(this.root, ent.name)
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('.tmp-')) continue
        unlinkQuiet(join(dir, file))
        removed++
      }
    }
    return removed
  }

  copyBlobFrom(source: FileBlobStore, hash: string): void {
    assertHash(hash)
    mkdirSync(this.dirFor(hash), { recursive: true })
    copyFileSync(source.bodyPath(hash), this.bodyPath(hash))
    const mimeSrc = source.mimePath(hash)
    if (existsSync(mimeSrc)) copyFileSync(mimeSrc, this.mimePath(hash))
  }

  put(bytes: Buffer, mime: string, options: { overwrite?: boolean } = {}): BlobRef {
    const hash = hashBytes(bytes)
    this.writePending(hash)
    const body = this.bodyPath(hash)
    if (options.overwrite || !existsSync(body)) {
      durableWriteFile(body, bytes)
    }
    const mimeFile = this.mimePath(hash)
    if (options.overwrite || !existsSync(mimeFile)) {
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

  clearPending(_hash: string): void {}

  corruptForTest(hash: string): void {
    const entry = this.files.get(hash)
    if (!entry) throw new BlobMissingError(hash)
    this.files.set(hash, { bytes: Buffer.concat([entry.bytes, Buffer.from([0xff])]), mime: entry.mime })
  }
}

export function blobStoreForDatabase(dbPath: string | undefined): BlobStore {
  if (!dbPath || dbPath === ':memory:') return new MemoryBlobStore()
  return new FileBlobStore(blobDirForDatabase(dbPath), { ownerDbPath: dbPath })
}

export function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // missing is fine
  }
}
