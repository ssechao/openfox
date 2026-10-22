import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { FileBlobStore, blobDirForDatabase, hashBytes } from './blob-store.js'
import { EventStore } from './store.js'
import { getBlobMigrationStatus } from './blob-migrate.js'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'blob-crash-child.ts')

export const CRASH_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
export const CRASH_PNG_URL = `data:image/png;base64,${CRASH_PNG.toString('base64')}`
export const CRASH_HASH = hashBytes(CRASH_PNG)

export function seedCrashDatabase(dbPath: string, sessionId: string, withInline: boolean): string {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );
  `)
  db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run(sessionId)
  let payload = ''
  if (withInline) {
    payload = JSON.stringify({
      messageId: 'm1',
      role: 'user',
      content: 'see',
      attachments: [
        { id: 'a', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL },
      ],
    })
    db.prepare(
      `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'message.start', ?)`,
    ).run(sessionId, Date.now(), payload)
  }
  db.close()
  return payload
}

function spawnCrashChild(env: Record<string, string>): ChildProcess {
  const child = fork(CHILD, [], {
    execArgv: ['--import', 'tsx/esm'],
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: true,
  })
  const logs: string[] = []
  const keep = (data: Buffer) => logs.push(data.toString())
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  ;(child as ChildProcess & { logs: string[] }).logs = logs
  return child
}

export async function parkAtBarrier(
  env: Record<string, string>,
  barrier: string,
  barrierFile: string,
  timeoutMs = 15_000,
): Promise<ChildProcess> {
  const child = spawnCrashChild({ ...env, OPENFOX_BLOB_BARRIER: barrier, OPENFOX_BLOB_BARRIER_FILE: barrierFile })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      const logs = (child as ChildProcess & { logs?: string[] }).logs?.join('') ?? ''
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(new Error(`barrier ${barrier} not reached\n${logs}`))
    }, timeoutMs)
    child.on('message', (message) => {
      if ((message as { parked?: string } | null)?.parked === barrier) finish()
    })
    const poll = setInterval(() => {
      if (existsSync(barrierFile) && readFileSync(barrierFile, 'utf8') === barrier) finish()
    }, 20)
    child.once('exit', (code) => {
      finish(new Error(`child exited ${code} before barrier ${barrier}`))
    })
  })
  return child
}

export async function killAtBarrier(
  env: Record<string, string>,
  barrier: string,
  barrierFile: string,
  timeoutMs = 15_000,
): Promise<void> {
  const child = await parkAtBarrier(env, barrier, barrierFile, timeoutMs)
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function reopenCrashStore(dbPath: string): { db: Database.Database; events: EventStore; blobs: FileBlobStore } {
  const db = new Database(dbPath)
  const blobs = new FileBlobStore(blobDirForDatabase(dbPath), { ownerDbPath: dbPath })
  const events = new EventStore(db, { blobStore: blobs })
  return { db, events, blobs }
}

export function eventPayloads(db: Database.Database, sessionId: string): string[] {
  return (
    db.prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{
      payload: string
    }>
  ).map((row) => row.payload)
}

export function assertResolvablePng(blobs: FileBlobStore): void {
  const rec = blobs.get(CRASH_HASH)
  if (!rec.bytes.equals(CRASH_PNG)) throw new Error('blob bytes mismatch')
  if (rec.mime !== 'image/png') throw new Error(`blob mime ${rec.mime}`)
  if (rec.size !== CRASH_PNG.length) throw new Error(`blob size ${rec.size}`)
}

export function migrationStatus(db: Database.Database, sessionId: string): string | null {
  return getBlobMigrationStatus(db, sessionId)
}
