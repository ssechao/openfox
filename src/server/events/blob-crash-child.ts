/**
 * Child used by blob SIGKILL tests. Parks at OPENFOX_BLOB_BARRIER so the
 * parent can kill it, then the parent reopens the same sqlite + FileBlobStore.
 */
import Database from 'better-sqlite3'
import { EventStore } from './store.js'
import { FileBlobStore } from './blob-store.js'
import { dirname, join } from 'node:path'

const dbPath = process.env['OPENFOX_DB_PATH']
const mode = process.env['OPENFOX_BLOB_CRASH_MODE']
const sessionId = process.env['OPENFOX_BLOB_SESSION'] ?? 's1'

if (!dbPath || (mode !== 'append' && mode !== 'migrate')) {
  process.stderr.write('OPENFOX_DB_PATH and OPENFOX_BLOB_CRASH_MODE=append|migrate are required\n')
  process.exit(2)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

const db = new Database(dbPath)
const blobs = new FileBlobStore(process.env['OPENFOX_BLOB_DIR'] ?? join(dirname(dbPath), 'blobs'))
const events = new EventStore(db, { blobStore: blobs })

if (mode === 'append') {
  events.append(sessionId, {
    type: 'message.start',
    data: {
      messageId: 'm1',
      role: 'user',
      content: 'see',
      attachments: [{ id: 'a', filename: 'dot.png', mimeType: 'image/png', size: PNG.length, data: PNG_URL }],
    },
  })
} else {
  events.migrateSessionBlobs(sessionId)
}

process.send?.({ done: true, mode, pid: process.pid })
setInterval(() => {}, 60_000)
