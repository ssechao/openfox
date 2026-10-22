import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import {
  isSearchIndexReady,
  rebuildSearchIndex,
  searchSessionIds,
  getSearchIndexReadyState,
  SEARCH_INDEX_SCHEMA_VERSION,
} from './fts-index.js'
import { initDatabase, closeDatabase } from '../db/index.js'
import { loadConfig } from '../config.js'
import type { SessionSnapshot, StoredEvent } from '../events/types.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const LOCK_CHILD = join(REPO_ROOT, 'src/server/db/instance-lock.test-child.ts')
const CRASH_CHILD = join(dirname(fileURLToPath(import.meta.url)), 'rebuild-crash-child.ts')

function snapshot(messages: SessionSnapshot['messages']): SessionSnapshot {
  return {
    mode: 'planner',
    phase: 'plan',
    isRunning: false,
    messages,
    criteria: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 0,
      maxTokens: 1000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId: 'w1',
    todos: [],
    snapshotSeq: 1,
    snapshotAt: Date.now(),
  }
}

function openFileDb(dir: string): { db: Database.Database; store: EventStore; dbPath: string } {
  const dbPath = join(dir, 'sessions.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      project_id TEXT,
      workdir TEXT DEFAULT '',
      phase TEXT DEFAULT 'idle',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )
  `)
  const store = new EventStore(db)
  return { db, store, dbPath }
}

describe('C3 FTS rebuild', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-fts-rebuild-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebuilds from snapshots and post-snapshot deltas, twice, after cleanup', () => {
    const { db, store } = openFileDb(dir)
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES ('s1', 'T', 'p')`).run()
    store.append('s1', {
      type: 'session.initialized',
      data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1', title: 'T' },
    })
    store.append('s1', {
      type: 'message.start',
      data: { messageId: 'old', role: 'user', content: 'ancient-keep-me' },
    })
    store.append('s1', {
      type: 'turn.snapshot',
      data: snapshot([{ id: 'old', role: 'user', content: 'ancient-keep-me', timestamp: Date.now() }]),
    })
    store.append('s1', {
      type: 'message.start',
      data: { messageId: 'new', role: 'user', content: 'post-' },
    })
    store.append('s1', { type: 'message.delta', data: { messageId: 'new', content: 'snapshot-delta' } })
    store.append('s1', { type: 'message.done', data: { messageId: 'new' } })
    store.cleanupOldEvents('s1')
    expect(
      store
        .getEvents('s1')
        .some((e) => e.type === 'message.start' && (e.data as { messageId?: string }).messageId === 'old'),
    ).toBe(false)

    rebuildSearchIndex(db)
    expect(isSearchIndexReady(db)).toBe(true)
    expect(searchSessionIds(db, 'ancient-keep-me').sessionIds).toEqual(['s1'])
    expect(searchSessionIds(db, 'snapshot-delta').sessionIds).toEqual(['s1'])
    rebuildSearchIndex(db)
    expect(searchSessionIds(db, 'ancient-keep-me').sessionIds).toEqual(['s1'])
    expect(searchSessionIds(db, 'snapshot-delta').sessionIds).toEqual(['s1'])
    db.close()
  })

  it('indexes snapshot-only prompts on explicit import', () => {
    const { db, store } = openFileDb(dir)
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES ('imp', 'Imported', 'p')`).run()
    const events: StoredEvent[] = [
      {
        seq: 1,
        timestamp: Date.now(),
        sessionId: 'imp',
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1', title: 'Imported' },
      },
      {
        seq: 2,
        timestamp: Date.now(),
        sessionId: 'imp',
        type: 'turn.snapshot',
        data: snapshot([{ id: 'only-snap', role: 'user', content: 'imported-snapshot-term', timestamp: Date.now() }]),
      },
    ]
    store.importEvents('imp', events)
    expect(searchSessionIds(db, 'imported-snapshot-term').sessionIds).toEqual(['imp'])
    db.close()
  })

  it('does not rebuild on initDatabase / initEventStore', () => {
    const dbPath = join(dir, 'boot.db')
    const seed = new Database(dbPath)
    seed.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, project_id TEXT, workdir TEXT, phase TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER, timestamp INTEGER, event_type TEXT, payload TEXT, UNIQUE(session_id, seq));
    `)
    seed
      .prepare(
        `INSERT INTO sessions (id, title, project_id, workdir, phase, created_at, updated_at) VALUES ('s1','Boot','p','/tmp','idle','t','t')`,
      )
      .run()
    seed
      .prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES ('s1', 1, 1, 'message.start', ?)`,
      )
      .run(JSON.stringify({ messageId: 'm1', role: 'user', content: 'boot-term' }))
    seed.close()

    closeDatabase()
    const config = loadConfig()
    config.database.path = dbPath
    const db = initDatabase(config)
    expect(isSearchIndexReady(db)).toBe(false)
    expect(searchSessionIds(db, 'boot-term').sessionIds).toEqual([])
    closeDatabase()
  })

  it('stays not-ready after new writes until an explicit rebuild', () => {
    const { db, store } = openFileDb(dir)
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES ('s1', 'T', 'p')`).run()
    store.append('s1', {
      type: 'message.start',
      data: { messageId: 'm1', role: 'user', content: 'live-term' },
    })
    expect(isSearchIndexReady(db)).toBe(false)
    expect(getSearchIndexReadyState(db)).toEqual({ version: SEARCH_INDEX_SCHEMA_VERSION, ready: false })
    db.close()
  })

  it('rebuilds a corrupted index', () => {
    const { db, store } = openFileDb(dir)
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES ('s1', 'T', 'p')`).run()
    store.append('s1', {
      type: 'message.start',
      data: { messageId: 'm1', role: 'user', content: 'recover-me' },
    })
    db.exec('DELETE FROM search_index')
    rebuildSearchIndex(db)
    expect(searchSessionIds(db, 'recover-me').sessionIds).toEqual(['s1'])
    db.close()
  })

  it('SIGKILL mid-rebuild leaves the previous index or not-ready, never a partial ready index', async () => {
    const { db, store, dbPath } = openFileDb(dir)
    db.prepare(`INSERT INTO sessions (id, title, project_id) VALUES ('s1', 'T', 'p')`).run()
    store.append('s1', {
      type: 'message.start',
      data: { messageId: 'm1', role: 'user', content: 'original-term' },
    })
    rebuildSearchIndex(db)
    expect(isSearchIndexReady(db)).toBe(true)
    db.close()

    const barrier = join(dir, 'barrier')
    const child = fork(CRASH_CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: {
        ...process.env,
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_BLOB_BARRIER: 'before-search-rebuild-swap',
        OPENFOX_BLOB_BARRIER_FILE: barrier,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rebuild barrier not reached')), 15_000)
      const poll = setInterval(() => {
        if (existsSync(barrier) && readFileSync(barrier, 'utf8') === 'before-search-rebuild-swap') {
          clearTimeout(timer)
          clearInterval(poll)
          resolve()
        }
      }, 20)
      child.once('exit', (code) => {
        clearTimeout(timer)
        clearInterval(poll)
        reject(new Error(`rebuild child exited ${code}`))
      })
    })
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    const reopened = new Database(dbPath)
    const ready = isSearchIndexReady(reopened)
    if (ready) {
      expect(searchSessionIds(reopened, 'original-term').sessionIds).toEqual(['s1'])
    } else {
      expect(getSearchIndexReadyState(reopened).ready).toBe(false)
    }
    rebuildSearchIndex(reopened)
    expect(isSearchIndexReady(reopened)).toBe(true)
    expect(searchSessionIds(reopened, 'original-term').sessionIds).toEqual(['s1'])
    reopened.close()
  })

  it('CLI refuses a locked database', async () => {
    const { db, dbPath } = openFileDb(dir)
    db.close()
    const child = fork(LOCK_CHILD, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock child timed out')), 10_000)
      child.once('message', (message) => {
        clearTimeout(timer)
        if ((message as { ok?: boolean }).ok) resolve()
        else reject(new Error(`lock failed ${JSON.stringify(message)}`))
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`lock child exited ${code}`))
      })
    })
    let status = 0
    let stderr = ''
    try {
      execFileSync(
        join(REPO_ROOT, 'node_modules/.bin/tsx'),
        ['scripts/rebuild-search-index.ts', '--yes', '--db', dbPath],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (error) {
      const err = error as { status?: number; stderr?: string; stdout?: string }
      status = err.status ?? 0
      stderr = `${err.stderr ?? ''}${err.stdout ?? ''}`
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    expect(status).toBe(1)
    expect(stderr).toMatch(/database already in use/)
    expect(existsSync(dbPath)).toBe(true)
  }, 60_000)
})
