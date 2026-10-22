/** Child used by FTS rebuild SIGKILL tests. */
import Database from 'better-sqlite3'
import { rebuildSearchIndex } from './fts-index.js'

const dbPath = process.env['OPENFOX_DB_PATH']
if (!dbPath) {
  process.stderr.write('OPENFOX_DB_PATH is required\n')
  process.exit(2)
}

const db = new Database(dbPath)
try {
  rebuildSearchIndex(db)
  process.send?.({ done: true, pid: process.pid })
} finally {
  db.close()
}
