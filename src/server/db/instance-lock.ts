/**
 * Process-scoped exclusive lock for an OpenFox SQLite database.
 *
 * Gateway / worker contract (étapes 6 et 7):
 * - The gateway (this process) holds the lock for the lifetime of the instance.
 *   Future workers attach with a token issued by the gateway; they never take
 *   this lock themselves and never open the database as a second instance.
 * - Sequence numbers are assigned by the unique writer of a session. The
 *   UNIQUE(session_id, seq) constraint in `events` is the source of truth.
 * - A worker writes its own events, using the token the gateway gave it.
 * - The gateway invalidates its session caches when a worker notifies it.
 * - A worker never runs global maintenance: is_running reset, provider
 *   reconciliation, VACUUM, or schema migrations.
 *
 * The lock is a sibling file `<db>.instance-lock` opened with better-sqlite3
 * in locking_mode=EXCLUSIVE. The first write takes a kernel fcntl lock that
 * is held until this connection closes, and is released automatically when
 * the process dies. A sidecar `<db>.instance-lock.info` stores the holder PID
 * and start time so a refused opener can name the owner without reading the
 * exclusively-locked SQLite file.
 *
 * Paths are canonicalized (parent directory realpath) so aliases and symlinks
 * share one lock. If the holder's identity cannot be read, we still refuse.
 */

import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'

export class InstanceLockError extends Error {
  readonly ownerPid: number
  readonly ownerStartedAt: string

  constructor(ownerPid: number, ownerStartedAt: string) {
    super(`base déjà utilisée par l'instance PID ${ownerPid} (démarrée à ${ownerStartedAt})`)
    this.ownerPid = ownerPid
    this.ownerStartedAt = ownerStartedAt
    this.name = 'InstanceLockError'
  }
}

export interface LockOwner {
  pid: number
  startedAt: string
}

export interface LockResult {
  acquired: boolean
  owner: LockOwner | null
}

let lockDb: Database.Database | null = null
let lockPath: string | null = null
let infoPath: string | null = null
let ownerInfo: LockOwner | null = null
const lockedCanonicalPaths = new Set<string>()

function canonicalDatabasePath(dbPath: string): string {
  if (dbPath === ':memory:') return dbPath
  const resolved = resolve(dbPath)
  try {
    return realpathSync(resolved)
  } catch {
    try {
      return join(realpathSync(dirname(resolved)), basename(resolved))
    } catch {
      return resolved
    }
  }
}

function lockFilePath(dbPath: string): string {
  return `${dbPath}.instance-lock`
}

function infoFilePath(dbPath: string): string {
  return `${dbPath}.instance-lock.info`
}

function writeOwnerInfo(path: string, owner: LockOwner): void {
  try {
    writeFileSync(path, `${owner.pid}\n${owner.startedAt}\n`, 'utf-8')
  } catch {
    // Best-effort advisory metadata; the kernel lock remains the authority.
  }
}

function removeOwnerInfo(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Ignore cleanup errors.
  }
}

function readOwnerInfo(path: string): LockOwner | null {
  try {
    const content = readFileSync(path, 'utf-8').trim()
    const [pidLine, startedAtLine] = content.split('\n')
    const pid = Number(pidLine)
    if (Number.isFinite(pid) && startedAtLine) {
      return { pid, startedAt: startedAtLine }
    }
  } catch {
    // Sidecar may be absent or unreadable.
  }
  return null
}

function readOwnerInfoSoon(path: string): LockOwner | null {
  for (let attempt = 0; attempt < 15; attempt++) {
    const owner = readOwnerInfo(path)
    if (owner) return owner
    const until = Date.now() + 10
    while (Date.now() < until) {
      // The winner writes the sidecar immediately after taking the kernel lock.
    }
  }
  return null
}

function refuse(owner: LockOwner | null): never {
  if (owner && Number.isFinite(owner.pid) && owner.startedAt) {
    throw new InstanceLockError(owner.pid, owner.startedAt)
  }
  throw new InstanceLockError(0, 'inconnue')
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function closeLockConnection(): void {
  if (!lockDb) return
  try {
    lockDb.close()
  } catch {
    // Ignore close errors.
  }
  lockDb = null
}

/**
 * Acquire an exclusive, process-scoped lock on a database file.
 *
 * Must be called before `new Database` on the main file, migrations, the
 * is_running reset, and provider reconciliation.
 */
export function acquireInstanceLock(dbPath: string): LockResult {
  if (dbPath === ':memory:' || dbPath === '') {
    logger.debug('Skipping instance lock for in-memory database')
    return { acquired: false, owner: null }
  }

  const canonical = canonicalDatabasePath(dbPath)
  const path = lockFilePath(canonical)
  const info = infoFilePath(canonical)

  // Kernel fcntl locks are per-process; a second connection in this process
  // would succeed. Track canonical paths so we refuse that too.
  if (lockedCanonicalPaths.has(canonical)) {
    refuse(ownerInfo ?? readOwnerInfo(info))
  }

  const startedAt = new Date().toISOString()
  const holdingPid = process.pid

  const takeLock = (): LockResult => {
    try {
      closeSync(openSync(path, 'a'))
    } catch {
      // Directory should already exist next to the database file.
    }
    // A short busy timeout lets a concurrent creator lose cleanly after the
    // winner has taken the kernel lock, instead of both failing on a new file.
    lockDb = new Database(path, { timeout: 100 })
    lockDb.pragma('busy_timeout = 100')
    lockDb.pragma('journal_mode = DELETE')
    lockDb.pragma('synchronous = NORMAL')
    // EXCLUSIVE locking mode takes a kernel file lock on the first write and
    // holds it until this connection closes (or the process dies). No open
    // transaction, so a crash does not leave a hot journal.
    lockDb.pragma('locking_mode = EXCLUSIVE')
    lockDb.exec(`
      CREATE TABLE IF NOT EXISTS instance_lock (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    lockDb
      .prepare(`INSERT OR REPLACE INTO instance_lock (key, value) VALUES ('pid', ?), ('startedAt', ?)`)
      .run(String(holdingPid), startedAt)
    writeOwnerInfo(info, { pid: holdingPid, startedAt })

    lockPath = path
    infoPath = info
    ownerInfo = { pid: holdingPid, startedAt }
    lockedCanonicalPaths.add(canonical)
    logger.info('Acquired instance lock', { path, pid: holdingPid, startedAt })
    return { acquired: true, owner: ownerInfo }
  }

  try {
    return takeLock()
  } catch {
    closeLockConnection()
    const owner = readOwnerInfoSoon(info)
    if (owner && pidIsAlive(owner.pid)) {
      refuse(owner)
    }
    // No live owner: the file may still be settling after a crash or a create
    // race. Retry a few times, then refuse if identity is still unknown.
    for (let attempt = 0; attempt < 5; attempt++) {
      const until = Date.now() + 20
      while (Date.now() < until) {
        /* wait */
      }
      try {
        return takeLock()
      } catch {
        closeLockConnection()
        const again = readOwnerInfo(info)
        if (again && pidIsAlive(again.pid)) {
          refuse(again)
        }
      }
    }
    refuse(readOwnerInfo(info))
  }
}

/**
 * Release the instance lock. Safe to call multiple times. Only the owner
 * should call this, and only after closing the main SQLite connection.
 */
export function releaseInstanceLock(): void {
  if (lockDb || lockPath) {
    logger.info('Released instance lock', { path: lockPath })
  }
  closeLockConnection()
  if (infoPath) {
    removeOwnerInfo(infoPath)
  }
  lockDb = null
  lockPath = null
  infoPath = null
  ownerInfo = null
  lockedCanonicalPaths.clear()
}

export function getLockOwnerInfo(): LockOwner | null {
  return ownerInfo
}
