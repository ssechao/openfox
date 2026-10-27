import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureExclusiveProcessInventory,
  captureExclusiveProcessInventoryAsync,
  exclusiveChildReservationEnv,
  finalizeExclusiveChild,
  initChildrenTracking,
  killTrackedChildren,
  reserveExclusiveChild,
  verifyExclusiveProcessInventoryAfter,
} from './children.js'
import type { ExclusiveProcessInventory } from './children.js'

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

function killIfAlive(child: ChildProcess | undefined): void {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      return
    }
  }
}

const processes: ChildProcess[] = []
const directories: string[] = []

afterEach(() => {
  delete process.env['OPENFOX_WORKER_CHILDREN']
  for (const child of processes.splice(0)) killIfAlive(child)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('worker zero-orphan supervision', () => {
  it('slow inventory capture is bounded and does not block supervisor signals', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-supervision-slow-inventory-'))
    directories.push(directory)
    const childrenPath = join(directory, 'worker.children')
    initChildrenTracking(childrenPath)
    const startedAt = Date.now()
    let signalHandledAt = 0
    const signalHandled = new Promise<void>((resolve) => {
      setTimeout(() => {
        signalHandledAt = Date.now()
        resolve()
      }, 10)
    })

    const capture = captureExclusiveProcessInventoryAsync(42, childrenPath, {
      readInventory: (() => new Promise(() => {})) as never,
    })
    await signalHandled
    const inventory = await capture

    expect(signalHandledAt - startedAt).toBeLessThan(100)
    expect(inventory.worker).toBeUndefined()
    expect(inventory.errors).toEqual([expect.stringMatching(/inventory read timed out/i)])
  })

  it('inventories identities, groups, and reservations before proving zero orphans at T+2s', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-supervision-'))
    directories.push(directory)
    const childrenPath = join(directory, 'worker.children')
    initChildrenTracking(childrenPath)
    process.env['OPENFOX_WORKER_CHILDREN'] = childrenPath

    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    processes.push(worker)
    const reservation = reserveExclusiveChild('sleep 30')
    expect(reservation).not.toBeNull()
    const exclusive = spawn('sh', ['-c', 'sleep 0.2; sleep 30 &'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...exclusiveChildReservationEnv(reservation) },
    })
    processes.push(exclusive)
    finalizeExclusiveChild(reservation, exclusive.pid)
    const reservationPids = () => {
      try {
        process.kill(exclusive.pid!, 0)
        return [exclusive.pid!]
      } catch {
        return []
      }
    }
    const inventoryDependencies = { findReservationPids: reservationPids }

    const inventory = captureExclusiveProcessInventory(worker.pid!, childrenPath, inventoryDependencies)
    expect(inventory.errors).toEqual([])
    expect(inventory.worker).toMatchObject({ pid: worker.pid, startedAt: expect.any(String), pgid: expect.any(Number) })
    expect(inventory.children).toEqual([
      expect.objectContaining({ pid: exclusive.pid, startedAt: expect.any(String), pgid: exclusive.pid }),
    ])
    expect(inventory.reservations).toEqual([
      expect.objectContaining({ id: reservation!.id, command: 'sleep 30', finalized: true }),
    ])

    process.kill(worker.pid!, 'SIGKILL')
    await waitForExit(worker)
    await waitForExit(exclusive)
    await killTrackedChildren(childrenPath, { findReservationPids: reservationPids })

    const check = await verifyExclusiveProcessInventoryAfter(inventory, inventoryDependencies)
    expect(check.checkedAt - inventory.capturedAt).toBeGreaterThanOrEqual(2_000)
    expect(check).toMatchObject({
      clean: true,
      survivingIdentities: [],
      survivingGroups: [],
      liveReservations: [],
      errors: [],
    })
  }, 10_000)

  it('excludes a historical child whose recorded identity is already absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-supervision-stale-'))
    directories.push(directory)
    const childrenPath = join(directory, 'worker.children')
    writeFileSync(
      childrenPath,
      [
        JSON.stringify({ type: 'reservation', id: 'reservation-done', command: 'done' }),
        JSON.stringify({
          type: 'child',
          reservationId: 'reservation-done',
          pid: 20,
          startedAt: 'linux:old',
          pgid: 200,
          command: 'done',
        }),
      ].join('\n') + '\n',
    )

    const inventory = captureExclusiveProcessInventory(10, childrenPath, {
      recordedWorker: { pid: 10, startedAt: 'linux:worker', pgid: 10 },
      readInventory: () => ({ status: 'absent' }),
      findReservationPids: () => [],
    })

    expect(inventory.children).toEqual([])
    expect(inventory.groups).toEqual([])
    expect(inventory.errors).toEqual([])
  })

  it('refuses zero-orphan proof when the leader is gone but its process group survives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-supervision-reparented-'))
    directories.push(directory)
    const childrenPath = join(directory, 'worker.children')
    writeFileSync(
      childrenPath,
      [
        JSON.stringify({ type: 'reservation', id: 'reservation-empty', command: 'orphan' }),
        JSON.stringify({
          type: 'child',
          reservationId: 'reservation-empty',
          pid: 20,
          startedAt: 'linux:gone',
          pgid: 200,
          command: 'orphan',
        }),
      ].join('\n') + '\n',
    )

    const inventory = captureExclusiveProcessInventory(10, childrenPath, {
      recordedWorker: { pid: 10, startedAt: 'linux:worker', pgid: 10 },
      readInventory: () => ({ status: 'absent' }),
      readGroup: (pgid) => (pgid === 200 ? { status: 'found' } : { status: 'absent' }),
      findReservationPids: () => [],
      now: () => 100,
    })

    expect(inventory.children).toEqual([])
    expect(inventory.groups).toEqual([200])
    const check = await verifyExclusiveProcessInventoryAfter(inventory, {
      readInventory: () => ({ status: 'absent' }),
      readGroup: (pgid) => (pgid === 200 ? { status: 'found' } : { status: 'absent' }),
      findReservationPids: () => [],
      now: () => 2_100,
      sleep: async () => {},
    })

    expect(check.clean).toBe(false)
    expect(check.survivingIdentities).toEqual([])
    expect(check.survivingGroups).toEqual([200])
    expect(check.liveReservations).toEqual([])
    expect(check.errors).toEqual([])
  })

  it('fails proof on unreadable identities, live reparented groups, or unreadable reservation scans', async () => {
    const inventory: ExclusiveProcessInventory = {
      capturedAt: 100,
      worker: { pid: 10, startedAt: 'linux:10', pgid: 1 },
      children: [{ pid: 20, startedAt: 'linux:20', pgid: 200 }],
      groups: [200],
      reservations: [
        {
          id: 'reservation-1',
          finalized: false,
          processes: [{ pid: 30, startedAt: 'linux:30', pgid: 300 }],
        },
      ],
      errors: [],
    }

    const check = await verifyExclusiveProcessInventoryAfter(inventory, {
      now: () => 2_100,
      sleep: async () => {
        throw new Error('fixed deadline already elapsed')
      },
      readInventory: (pid) => {
        if (pid === 10) return { status: 'found', process: { pid, startedAt: 'linux:reused', pgid: 1 } }
        if (pid === 20) return { status: 'absent' }
        return { status: 'unreadable', error: new Error('permission denied') }
      },
      readGroup: (pgid) =>
        pgid === 200 ? { status: 'found' } : { status: 'unreadable', error: new Error('group unreadable') },
      findReservationPids: () => {
        throw new Error('reservation scan unreadable')
      },
    })

    expect(check.clean).toBe(false)
    expect(check.survivingIdentities).toEqual([])
    expect(check.survivingGroups).toEqual([200])
    expect(check.errors).toEqual(
      expect.arrayContaining([
        'pid 30: permission denied',
        'process group 300: group unreadable',
        'reservation reservation-1: reservation scan unreadable',
      ]),
    )
  })
})
