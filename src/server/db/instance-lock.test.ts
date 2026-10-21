import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, initDatabase } from './index.js'
import {
  acquireInstanceLock,
  formatInstanceLockRefusal,
  getLockOwnerInfo,
  InstanceLockError,
  instanceLockRefusalTx,
  releaseInstanceLock,
} from './instance-lock.js'
import { loadConfig } from '../config.js'

const DIR = dirname(fileURLToPath(import.meta.url))
const CHILD = join(DIR, 'instance-lock.test-child.ts')
const PARENT = join(DIR, 'instance-lock.test-parent.ts')

function createDbFile(path: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE IF NOT EXISTS _openfox_probe (id INTEGER PRIMARY KEY)')
  db.close()
}

function spawnLocker(dbPath: string): ChildProcess {
  const child = fork(CHILD, [], {
    execArgv: ['--import', 'tsx/esm'],
    env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
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

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // gone
    }
  }
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
    for (const child of children) killTree(child)
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
      const locked = error as InstanceLockError
      expect(locked.ownerPid).toBe(process.pid)
      expect(locked.message).toMatch(new RegExp(`PID ${process.pid}`))
      expect(locked.message).toContain(dbPath)
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

  it('does not report a collision when the parent directory is missing', () => {
    const missing = join(root, 'no-such-dir', 'sessions.db')
    expect(() => acquireInstanceLock(missing)).toThrow()
    try {
      acquireInstanceLock(missing)
    } catch (error) {
      expect(error).not.toBeInstanceOf(InstanceLockError)
    }
  })

  it('lets only one of two concurrent processes win the lock', async () => {
    const first = spawnLocker(dbPath)
    const second = spawnLocker(dbPath)
    children.push(first, second)
    const results = await Promise.all([waitForLockResult(first), waitForLockResult(second)])
    const winners = results.filter((result) => result.ok)
    const losers = results.filter((result) => !result.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]?.error).toMatch(/database already in use by instance PID/)
    expect(losers[0]?.error).toMatch(new RegExp(`PID ${winners[0]?.pid}`))
  })

  it('releases the lock on SIGKILL so one of two reclaimers can win', async () => {
    const holder = spawnLocker(dbPath)
    children.push(holder)
    const held = await waitForLockResult(holder)
    expect(held.ok).toBe(true)

    killTree(holder)
    await waitForExit(holder)

    const first = spawnLocker(dbPath)
    const second = spawnLocker(dbPath)
    children.push(first, second)
    const results = await Promise.all([waitForLockResult(first), waitForLockResult(second)])
    const winners = results.filter((result) => result.ok)
    const losers = results.filter((result) => !result.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]?.error).toMatch(/database already in use by instance PID/)
  })

  it('leaves the new holder sidecar intact when the previous owner releases', async () => {
    acquireInstanceLock(dbPath)
    const waiter = spawnLocker(dbPath)
    children.push(waiter)
    const first = await waitForLockResult(waiter)
    expect(first.ok).toBe(false)
    releaseInstanceLock()
    const winner = spawnLocker(dbPath)
    children.push(winner)
    const held = await waitForLockResult(winner)
    expect(held.ok).toBe(true)
    const sidecar = readFileSync(`${dbPath}.instance-lock.info`, 'utf-8')
    expect(sidecar.startsWith(`${held.pid}\n`)).toBe(true)
  })

  it('exits the lock child within 2s when its parent is killed', async () => {
    const parent = fork(PARENT, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, OPENFOX_LOCK_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    children.push(parent)
    const message = await new Promise<{ childPid?: number; ok?: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('parent timed out')), 10_000)
      parent.once('message', (value) => {
        clearTimeout(timer)
        resolve(value as { childPid?: number; ok?: boolean })
      })
      parent.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`parent exited ${code}`))
      })
    })
    expect(message.ok).toBe(true)
    const childPid = message.childPid
    expect(childPid).toBeGreaterThan(0)
    parent.kill('SIGKILL')
    await waitForExit(parent)
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && pidAlive(childPid!)) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(pidAlive(childPid!)).toBe(false)
  })

  it('formats the refusal in English and French with path and PID', () => {
    const owner = { pid: 4242, startedAt: '2026-10-21T00:00:00.000Z' }
    const error = new InstanceLockError('/tmp/sessions.db', owner)
    const tx = instanceLockRefusalTx(error)
    expect(tx.en).toContain('/tmp/sessions.db')
    expect(tx.en).toMatch(/PID 4242/)
    expect(tx.en).toMatch(/Use that instance, or stop PID 4242/)
    expect(tx.fr).toMatch(/base déjà utilisée par l'instance PID 4242/)
    expect(tx.fr).toContain('/tmp/sessions.db')
    expect(formatInstanceLockRefusal('en', '/tmp/sessions.db')).not.toMatch(/PID 0/)
    expect(formatInstanceLockRefusal('en', '/tmp/sessions.db')).toMatch(/already in use/)
  })
})
