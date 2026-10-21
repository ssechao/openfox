import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, initDatabase } from './index.js'
import { acquireInstanceLock, getLockOwnerInfo, InstanceLockError, releaseInstanceLock } from './instance-lock.js'
import { loadConfig } from '../config.js'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'instance-lock-child.ts')

function createDbFile(path: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE IF NOT EXISTS _openfox_probe (id INTEGER PRIMARY KEY)')
  db.close()
}

function spawnLocker(dbPath: string): ChildProcess {
  const child = fork(CHILD, [], {
    execArgv: ['--import', 'tsx/esm'],
    env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const logs: string[] = []
  const keep = (data: Buffer) => logs.push(data.toString())
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  ;(child as ChildProcess & { logs: string[] }).logs = logs
  return child
}

function waitForLockResult(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: { ok: boolean; pid?: number; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => reject(new Error('lock child timed out')), timeoutMs)
    child.once('message', (message) => finish(message as { ok: boolean; pid?: number; error?: string }))
    child.once('exit', (code) => {
      setTimeout(() => finish({ ok: false, error: `exited ${code}` }), 50)
    })
  })
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('instance lock', () => {
  let root: string
  let dbPath: string
  const children: ChildProcess[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openfox-lock-test-'))
    dbPath = join(root, 'sessions.db')
  })

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    children.length = 0
    releaseInstanceLock()
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it('acquires a lock before the database is opened', () => {
    const lock = acquireInstanceLock(dbPath)
    expect(lock.acquired).toBe(true)
    expect(getLockOwnerInfo()).toMatchObject({
      pid: process.pid,
      startedAt: expect.any(String),
    })
  })

  it('refuses a second opener on the same canonical path', () => {
    acquireInstanceLock(dbPath)
    expect(() => acquireInstanceLock(dbPath)).toThrow(InstanceLockError)
    try {
      acquireInstanceLock(dbPath)
    } catch (error) {
      expect(error).toBeInstanceOf(InstanceLockError)
      expect((error as InstanceLockError).message).toMatch(/base déjà utilisée par l'instance PID \d+/)
      expect((error as InstanceLockError).ownerPid).toBe(process.pid)
    }
  })

  it('resolves symlinks to the same canonical path and refuses', async () => {
    createDbFile(dbPath)
    const linkPath = join(root, 'link.db')
    await symlink(dbPath, linkPath)
    acquireInstanceLock(dbPath)
    expect(() => acquireInstanceLock(linkPath)).toThrow(InstanceLockError)
  })

  it('releases the lock so another process can take it', () => {
    expect(acquireInstanceLock(dbPath).acquired).toBe(true)
    releaseInstanceLock()
    expect(acquireInstanceLock(dbPath).acquired).toBe(true)
  })

  it('does not acquire a lock for in-memory databases', () => {
    expect(acquireInstanceLock(':memory:').acquired).toBe(false)
    expect(getLockOwnerInfo()).toBeNull()
    expect(acquireInstanceLock('').acquired).toBe(false)
    expect(getLockOwnerInfo()).toBeNull()
  })

  it('keeps the lock and sidecar files alongside the database', async () => {
    acquireInstanceLock(dbPath)
    await expect(realpath(`${dbPath}.instance-lock`)).resolves.toBeDefined()
    await expect(realpath(`${dbPath}.instance-lock.info`)).resolves.toBeDefined()
  })

  it('releases the lock when initDatabase fails after acquiring it', () => {
    const asDirectory = join(root, 'not-a-database')
    mkdirSync(asDirectory)
    const config = loadConfig()
    config.database.path = asDirectory
    expect(() => initDatabase(config)).toThrow()
    expect(getLockOwnerInfo()).toBeNull()
    expect(acquireInstanceLock(asDirectory).acquired).toBe(true)
  })

  it('lets only one of two concurrent processes win the lock', async () => {
    const first = spawnLocker(dbPath)
    const second = spawnLocker(dbPath)
    children.push(first, second)
    const results = await Promise.all([waitForLockResult(first), waitForLockResult(second)])
    const winners = results.filter((result) => result.ok)
    const losers = results.filter((result) => !result.ok)
    if (winners.length !== 1) {
      throw new Error(
        `expected one winner, got ${JSON.stringify(results)} logs=${JSON.stringify({
          first: (first as ChildProcess & { logs: string[] }).logs,
          second: (second as ChildProcess & { logs: string[] }).logs,
        })}`,
      )
    }
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]?.error).toMatch(/base déjà utilisée par l'instance PID/)
    expect(losers[0]?.error).toMatch(new RegExp(`PID ${winners[0]?.pid}`))
  })

  it('releases the lock on SIGKILL so one of two reclaimers can win', async () => {
    const holder = spawnLocker(dbPath)
    children.push(holder)
    const held = await waitForLockResult(holder)
    expect(held.ok).toBe(true)

    holder.kill('SIGKILL')
    await waitForExit(holder)

    const first = spawnLocker(dbPath)
    const second = spawnLocker(dbPath)
    children.push(first, second)
    const results = await Promise.all([waitForLockResult(first), waitForLockResult(second)])
    const winners = results.filter((result) => result.ok)
    const losers = results.filter((result) => !result.ok)
    if (winners.length !== 1) {
      throw new Error(
        `reclaim expected one winner, got ${JSON.stringify(results)} logs=${JSON.stringify({
          first: (first as ChildProcess & { logs: string[] }).logs,
          second: (second as ChildProcess & { logs: string[] }).logs,
        })}`,
      )
    }
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]?.error).toMatch(/base déjà utilisée par l'instance PID/)
  })
})
