/**
 * Child used by blob SIGKILL tests. Parks at OPENFOX_BLOB_BARRIER so the
 * parent can kill it, then the parent reopens the same sqlite + FileBlobStore.
 */
import Database from 'better-sqlite3'
import { EventStore } from './store.js'
import { FileBlobStore, blobDirForDatabase } from './blob-store.js'
import { backupDatabaseAndBlobs, recoverRestoreIfNeeded, restoreDatabaseAndBlobs } from './blob-backup.js'
import { acquireInstanceLock, releaseInstanceLock } from '../db/instance-lock.js'

const dbPath = process.env['OPENFOX_DB_PATH']
const mode = process.env['OPENFOX_BLOB_CRASH_MODE']
const sessionId = process.env['OPENFOX_BLOB_SESSION'] ?? 's1'

if (!dbPath || !mode) {
  process.stderr.write('OPENFOX_DB_PATH and OPENFOX_BLOB_CRASH_MODE are required\n')
  process.exit(2)
}
const resolvedDbPath = dbPath as string
const resolvedMode = mode as string

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

async function main(): Promise<void> {
  if (resolvedMode === 'backup') {
    const dest = process.env['OPENFOX_BLOB_BACKUP_DEST']
    if (!dest) {
      process.stderr.write('OPENFOX_BLOB_BACKUP_DEST is required\n')
      process.exit(2)
    }
    await backupDatabaseAndBlobs(resolvedDbPath, dest)
    process.send?.({ done: true, mode: resolvedMode, pid: process.pid })
    setInterval(() => {}, 60_000)
    return
  }

  if (resolvedMode === 'restore') {
    const from = process.env['OPENFOX_BLOB_BACKUP_FROM']
    if (!from) {
      process.stderr.write('OPENFOX_BLOB_BACKUP_FROM is required\n')
      process.exit(2)
    }
    restoreDatabaseAndBlobs(from, resolvedDbPath)
    process.send?.({ done: true, mode: resolvedMode, pid: process.pid })
    setInterval(() => {}, 60_000)
    return
  }

  if (resolvedMode === 'restore-recover') {
    acquireInstanceLock(resolvedDbPath)
    try {
      recoverRestoreIfNeeded(resolvedDbPath)
    } finally {
      releaseInstanceLock()
    }
    process.send?.({ done: true, mode: resolvedMode, pid: process.pid })
    setInterval(() => {}, 60_000)
    return
  }

  const db = new Database(resolvedDbPath)
  const blobs = new FileBlobStore(process.env['OPENFOX_BLOB_DIR'] ?? blobDirForDatabase(resolvedDbPath), {
    ownerDbPath: resolvedDbPath,
  })
  const events = new EventStore(db, { blobStore: blobs })

  if (resolvedMode === 'append') {
    events.append(sessionId, {
      type: 'message.start',
      data: {
        messageId: 'm1',
        role: 'user',
        content: 'see',
        attachments: [{ id: 'a', filename: 'dot.png', mimeType: 'image/png', size: PNG.length, data: PNG_URL }],
      },
    })
  } else if (resolvedMode === 'migrate') {
    events.migrateSessionBlobs(sessionId)
  } else if (resolvedMode === 'gc') {
    events.gcBlobs()
  } else if (resolvedMode === 'rollback') {
    events.rollbackSessionBlobs(sessionId)
  } else if (resolvedMode === 'append-loop') {
    let n = 0
    const tick = () => {
      n++
      events.append(sessionId, {
        type: 'message.start',
        data: {
          messageId: `w${n}`,
          role: 'user',
          content: `n${n}`,
          attachments: [{ id: 'a', filename: 'dot.png', mimeType: 'image/png', size: PNG.length, data: PNG_URL }],
        },
      })
      process.send?.({ wrote: n, pid: process.pid })
    }
    tick()
    setInterval(tick, 30)
    return
  } else {
    process.stderr.write(`unknown OPENFOX_BLOB_CRASH_MODE=${resolvedMode}\n`)
    process.exit(2)
  }

  process.send?.({ done: true, mode: resolvedMode, pid: process.pid })
  setInterval(() => {}, 60_000)
}

void main().catch((error) => {
  process.stderr.write(String(error) + '\n')
  process.exit(1)
})
