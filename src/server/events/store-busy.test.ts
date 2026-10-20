import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { createSession } from '../db/sessions.js'
import { logger } from '../utils/logger.js'
import { EventStore } from './store.js'

const SID = 'session-1'
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')

async function holdWriteLockInAnotherProcess(path: string, holdMs: number): Promise<Promise<number | null>> {
  const code = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)})`,
    `const db = new Database(${JSON.stringify(path)})`,
    `db.exec('BEGIN IMMEDIATE')`,
    `process.stdout.write('locked\\n')`,
    `setTimeout(() => { db.exec('COMMIT'); db.close() }, ${holdMs})`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  await new Promise((resolve) => child.stdout.once('data', resolve))
  return exited
}

function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
}

describe('database busy handling', () => {
  let directory: string
  let path: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'openfox-busy-'))
    path = join(directory, 'sessions.db')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  })

  it('opens the application database with a busy timeout of at least 5 s', () => {
    const db = initDatabase({ ...loadConfig(), database: { path } })
    expect(db.pragma('busy_timeout', { simple: true })).toBeGreaterThanOrEqual(5000)
  })

  it('appends once another process releases the write lock it was holding', async () => {
    const db = initDatabase({ ...loadConfig(), database: { path } })
    const store = new EventStore(db)
    const sessionId = createSession(createProject('Busy', directory).id, directory).id
    store.append(sessionId, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error')

    const holder = await holdWriteLockInAnotherProcess(path, 300)
    const stored = store.append(sessionId, { type: 'message.done', data: { messageId: 'u1' } })

    expect(await holder).toBe(0)
    expect(stored.seq).toBe(2)
    expect(store.getEvents(sessionId).map((event) => event.type)).toEqual(['message.start', 'message.done'])
    expect(error).not.toHaveBeenCalled()
  })

  it('retries an append that hits SQLITE_BUSY a bounded number of times', () => {
    const db = new Database(path)
    const store = new EventStore(db)
    store.append(SID, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const prepare = db.prepare.bind(db)
    let failures = 2
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('INSERT INTO events')) return statement
      return {
        run: (...args: unknown[]) => {
          if (failures-- > 0) throw busyError()
          return statement.run(...args)
        },
      }
    }) as never)

    expect(store.append(SID, { type: 'message.done', data: { messageId: 'u1' } }).seq).toBe(2)
    expect(error).not.toHaveBeenCalled()

    failures = Number.POSITIVE_INFINITY
    expect(() => store.append(SID, { type: 'message.done', data: { messageId: 'u1' } })).toThrow('database is locked')
    expect(error).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('logs and reports an append that stays locked, then keeps working once the lock is released', () => {
    const db = new Database(path, { timeout: 20 })
    db.pragma('journal_mode = WAL')
    const store = new EventStore(db)
    store.append(SID, { type: 'message.start', data: { messageId: 'u1', role: 'user', content: 'hi' } })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const holder = new Database(path)
    holder.exec('BEGIN IMMEDIATE')

    expect(() => store.append(SID, { type: 'message.done', data: { messageId: 'u1' } })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^SQLITE_BUSY/) }),
    )
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toMatch(/locked/)
    expect(error.mock.calls[0]?.[1]).toMatchObject({ sessionId: SID, type: 'message.done' })

    holder.exec('ROLLBACK')
    holder.close()
    expect(store.append(SID, { type: 'message.done', data: { messageId: 'u1' } }).seq).toBe(2)
    db.close()
  })
})
