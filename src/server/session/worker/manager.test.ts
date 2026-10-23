import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { Config } from '../../../shared/types.js'
import type { SessionManager } from '../manager.js'
import { SessionWorkerManager } from './manager.js'

function createDb(name: string): { db: Database.Database; namedDb: Database.Database } {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      worker_generation INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO sessions (id) VALUES ('sess-1');
  `)
  const namedDb = {
    name,
    prepare: db.prepare.bind(db),
    transaction: db.transaction.bind(db),
  } as unknown as Database.Database
  return { db, namedDb }
}

const config = {
  mode: 'test',
  llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 1000, idleTimeout: 1000 },
  context: { maxTokens: 1000, compactionThreshold: 0.85, compactionTarget: 0.6 },
  agent: { maxIterations: 1, maxConsecutiveFailures: 1, toolTimeout: 1000 },
  server: { port: 0, host: '127.0.0.1' },
  database: { path: ':memory:' },
  logging: { level: 'error' },
  workdir: process.cwd(),
  globalConfigPath: '/tmp/openfox-worker-manager-test.json',
} satisfies Config

const openDbs: Database.Database[] = []

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close()
})

describe('SessionWorkerManager', () => {
  it('fails before spawning when the child sidecar cannot be initialized', () => {
    const { db, namedDb } = createDb('/missing/openfox/sessions.db')
    openDbs.push(db)
    const manager = new SessionWorkerManager({
      db: () => namedDb,
      config,
      sessionManager: {} as SessionManager,
      isEnabled: () => true,
      broadcastForSession: () => {},
    })

    expect(() => manager.launch('sess-1', () => {})).toThrow(/sidecar|ENOENT/i)
    expect(manager.activeWorker()).toBeNull()
    const row = namedDb.prepare(`SELECT worker_id FROM sessions WHERE id = 'sess-1'`).get() as {
      worker_id: string | null
    }
    expect(row.worker_id).toBeNull()
  })
})
