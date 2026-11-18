import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  terminateProcessTreeGuarded,
  type GuardedProcessTreeOptions,
  type GuardedTreeSignal,
} from '../../utils/process-tree.js'
import {
  captureExclusiveProcessInventory,
  captureExclusiveProcessInventoryAsync,
  killTrackedChildren,
  type ProcessInventoryEntry,
} from './children.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('worker inventory capture', () => {
  it('does not record an error when the worker process is already gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openfox-inventory-'))
    roots.push(root)
    const path = join(root, 'children.jsonl')
    await writeFile(path, '')

    const inventory = captureExclusiveProcessInventory(42, path, {
      readInventory: () => ({ status: 'absent' }),
      findReservationPids: () => [],
      readGroup: () => ({ status: 'absent' }),
      now: () => 1,
    })

    expect(inventory.errors).toEqual([])
    expect(inventory.worker).toBeUndefined()
  })
})

describe('reservation inventory scan', () => {
  it('does not record a timeout when the process scan finishes after the short read budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openfox-inventory-'))
    roots.push(root)
    const path = join(root, 'children.jsonl')
    await writeFile(path, `${JSON.stringify({ type: 'reservation', id: 'r1', command: 'printf x' })}\n`)

    const inventory = await captureExclusiveProcessInventoryAsync(1, path, {
      recordedWorker: { pid: 1, startedAt: 't0', pgid: 1 },
      readInventory: () => ({ status: 'absent' }),
      findReservationPids: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return []
      },
    })

    expect(inventory.errors, 'reservation inventory scan timed out').toEqual([])
    expect(inventory.reservations).toEqual([{ id: 'r1', command: 'printf x', finalized: false, processes: [] }])
  })
})

type ProtectedProcessRole = 'sender' | 'gateway' | 'supervisor'

type GuardedCleanupDependencies = Parameters<typeof killTrackedChildren>[1] & {
  protectedProcesses: Record<ProtectedProcessRole, ProcessInventoryEntry>
  logSignalRefusal: (details: Record<string, unknown>) => void
}

function protectedProcess(pid: number): ProcessInventoryEntry {
  return { pid, pgid: pid, startedAt: `identity-${pid}` }
}

function guardedTerminator(
  sent: Array<[number, GuardedTreeSignal]>,
  descendants: number[] = [],
): (pid: number, options?: GuardedProcessTreeOptions) => Promise<void> {
  return (pid, options = {}) =>
    terminateProcessTreeGuarded(pid, {
      ...options,
      dependencies: {
        enumerate: async () => descendants,
        send: (target, signal) => sent.push([target, signal]),
        isAlive: () => false,
        sleep: async () => {},
      },
    })
}

describe('exclusive process group signal guard', () => {
  it('refuses an unproven or protected process group with structured evidence', async () => {
    const protectedProcesses: Record<ProtectedProcessRole, ProcessInventoryEntry> = {
      sender: protectedProcess(100),
      gateway: protectedProcess(200),
      supervisor: protectedProcess(300),
    }
    const cases: Array<{
      name: string
      pid: number
      identity: { status: 'absent' } | { status: 'found'; identity: string }
      reason: string
      positiveOnly: boolean
    }> = [
      {
        name: 'identity',
        pid: 400,
        identity: { status: 'absent' },
        reason: 'target_identity_unavailable',
        positiveOnly: false,
      },
      {
        name: 'sender',
        pid: protectedProcesses.sender.pgid,
        identity: { status: 'found', identity: 'stable' },
        reason: 'protected_sender_process_group',
        positiveOnly: true,
      },
      {
        name: 'gateway',
        pid: protectedProcesses.gateway.pgid,
        identity: { status: 'found', identity: 'stable' },
        reason: 'protected_gateway_process_group',
        positiveOnly: true,
      },
      {
        name: 'supervisor',
        pid: protectedProcesses.supervisor.pgid,
        identity: { status: 'found', identity: 'stable' },
        reason: 'protected_supervisor_process_group',
        positiveOnly: true,
      },
    ]

    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), `openfox-signal-guard-${testCase.name}-`))
      roots.push(root)
      const path = join(root, 'children.jsonl')
      await writeFile(
        path,
        `${JSON.stringify({ type: 'child', pid: testCase.pid, pgid: testCase.pid, startedAt: 'stable' })}\n`,
      )
      const sent: Array<[number, GuardedTreeSignal]> = []
      const terminateTree = vi.fn(guardedTerminator(sent, [testCase.pid + 1_000]))
      const logSignalRefusal = vi.fn()
      const dependencies: GuardedCleanupDependencies = {
        readProcessIdentity: () => testCase.identity,
        readGroup: () => ({ status: 'found' }),
        terminateTree,
        findReservationPids: () => [],
        retryDelay: async () => {},
        protectedProcesses,
        logSignalRefusal,
      }

      expect(await killTrackedChildren(path, dependencies)).toEqual(testCase.positiveOnly ? [testCase.pid] : [])
      if (testCase.positiveOnly) {
        expect(terminateTree).toHaveBeenCalledWith(testCase.pid)
        expect(sent.some(([pid]) => pid < 0)).toBe(false)
        expect(new Set(sent.map(([pid]) => pid))).toEqual(new Set([testCase.pid, testCase.pid + 1_000]))
      } else {
        expect(terminateTree).not.toHaveBeenCalled()
        expect(sent).toEqual([])
      }
      expect(existsSync(path)).toBe(!testCase.positiveOnly)
      expect(logSignalRefusal).toHaveBeenCalledWith(
        expect.objectContaining({
          senderPid: protectedProcesses.sender.pid,
          senderPgid: protectedProcesses.sender.pgid,
          targetPid: testCase.pid,
          targetPgid: testCase.pid,
          signal: 'SIGKILL',
          reason: testCase.reason,
        }),
      )
    }

    const root = await mkdtemp(join(tmpdir(), 'openfox-signal-guard-reservation-'))
    roots.push(root)
    const path = join(root, 'children.jsonl')
    await writeFile(path, `${JSON.stringify({ type: 'reservation', id: 'r1', command: 'printf x' })}\n`)
    const sent: Array<[number, GuardedTreeSignal]> = []
    const terminateTree = vi.fn(guardedTerminator(sent, [1_401]))
    const logSignalRefusal = vi.fn()
    const protectedReservationPids = vi.fn().mockReturnValueOnce([401]).mockReturnValue([])
    const dependencies: GuardedCleanupDependencies = {
      readInventory: () => ({
        status: 'found',
        process: { pid: 401, pgid: protectedProcesses.gateway.pgid, startedAt: 'stable' },
      }),
      readProcessIdentity: () => ({ status: 'found', identity: 'stable' }),
      terminateTree,
      findReservationPids: protectedReservationPids,
      retryDelay: async () => {},
      protectedProcesses,
      logSignalRefusal,
    }

    expect(await killTrackedChildren(path, dependencies)).toEqual([401])
    expect(terminateTree).toHaveBeenCalledWith(401)
    expect(sent.some(([pid]) => pid < 0)).toBe(false)
    expect(new Set(sent.map(([pid]) => pid))).toEqual(new Set([401, 1_401]))
    expect(existsSync(path)).toBe(false)
    expect(logSignalRefusal).toHaveBeenCalledWith(
      expect.objectContaining({
        senderPid: protectedProcesses.sender.pid,
        senderPgid: protectedProcesses.sender.pgid,
        targetPid: 401,
        targetPgid: protectedProcesses.gateway.pgid,
        signal: 'SIGKILL',
        reason: 'protected_gateway_process_group',
      }),
    )

    const liveRoot = await mkdtemp(join(tmpdir(), 'openfox-signal-guard-reservation-live-'))
    roots.push(liveRoot)
    const livePath = join(liveRoot, 'children.jsonl')
    await writeFile(livePath, `${JSON.stringify({ type: 'reservation', id: 'r-live' })}\n`)
    const liveSent: Array<[number, GuardedTreeSignal]> = []
    const liveTerminateTree = vi.fn(guardedTerminator(liveSent))
    const liveLogSignalRefusal = vi.fn()
    const liveDependencies: GuardedCleanupDependencies = {
      readInventory: () => ({ status: 'absent' }),
      readGroup: () => ({ status: 'found' }),
      terminateTree: liveTerminateTree,
      findReservationPids: () => [402],
      retryDelay: async () => {},
      protectedProcesses,
      logSignalRefusal: liveLogSignalRefusal,
    }

    expect(await killTrackedChildren(livePath, liveDependencies)).toEqual([])
    expect(liveTerminateTree).not.toHaveBeenCalled()
    expect(liveSent).toEqual([])
    expect(existsSync(livePath)).toBe(true)
    expect(liveLogSignalRefusal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPid: 402,
        targetPgid: 402,
        signal: 'SIGKILL',
        reason: 'target_identity_unavailable',
      }),
    )

    const protectedAbsentRoot = await mkdtemp(join(tmpdir(), 'openfox-signal-guard-protected-absent-'))
    roots.push(protectedAbsentRoot)
    const protectedAbsentPath = join(protectedAbsentRoot, 'children.jsonl')
    await writeFile(protectedAbsentPath, `${JSON.stringify({ type: 'reservation', id: 'r-protected-absent' })}\n`)
    const protectedAbsentSent: Array<[number, GuardedTreeSignal]> = []
    const protectedAbsentTerminateTree = vi.fn(guardedTerminator(protectedAbsentSent))
    const protectedAbsentLogSignalRefusal = vi.fn()
    const protectedAbsentReadGroup = vi.fn(() => ({ status: 'found' }) as const)
    const protectedAbsentReservationPids = vi
      .fn()
      .mockReturnValueOnce([protectedProcesses.gateway.pgid])
      .mockReturnValue([])
    const protectedAbsentDependencies: GuardedCleanupDependencies = {
      readInventory: () => ({ status: 'absent' }),
      readGroup: protectedAbsentReadGroup,
      terminateTree: protectedAbsentTerminateTree,
      findReservationPids: protectedAbsentReservationPids,
      retryDelay: async () => {},
      protectedProcesses,
      logSignalRefusal: protectedAbsentLogSignalRefusal,
    }

    expect(await killTrackedChildren(protectedAbsentPath, protectedAbsentDependencies)).toEqual([])
    expect(protectedAbsentReadGroup).not.toHaveBeenCalled()
    expect(protectedAbsentTerminateTree).not.toHaveBeenCalled()
    expect(protectedAbsentSent).toEqual([])
    expect(protectedAbsentLogSignalRefusal).not.toHaveBeenCalled()
    expect(existsSync(protectedAbsentPath)).toBe(false)

    const absentRoot = await mkdtemp(join(tmpdir(), 'openfox-signal-guard-reservation-absent-'))
    roots.push(absentRoot)
    const absentPath = join(absentRoot, 'children.jsonl')
    await writeFile(absentPath, `${JSON.stringify({ type: 'reservation', id: 'r-absent' })}\n`)
    const absentSent: Array<[number, GuardedTreeSignal]> = []
    const absentTerminateTree = vi.fn(guardedTerminator(absentSent))
    const absentLogSignalRefusal = vi.fn()
    const absentReservationPids = vi.fn().mockReturnValueOnce([403]).mockReturnValue([])
    const absentDependencies: GuardedCleanupDependencies = {
      readInventory: () => ({ status: 'absent' }),
      readGroup: () => ({ status: 'absent' }),
      terminateTree: absentTerminateTree,
      findReservationPids: absentReservationPids,
      retryDelay: async () => {},
      protectedProcesses,
      logSignalRefusal: absentLogSignalRefusal,
    }

    expect(await killTrackedChildren(absentPath, absentDependencies)).toEqual([])
    expect(absentTerminateTree).not.toHaveBeenCalled()
    expect(absentSent).toEqual([])
    expect(absentLogSignalRefusal).not.toHaveBeenCalled()
    expect(existsSync(absentPath)).toBe(false)
  })

  it('signals only a stable distinct pid-equals-pgid group and clears its reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openfox-signal-guard-stable-'))
    roots.push(root)
    const path = join(root, 'children.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'reservation', id: 'r1', command: 'printf x' }),
        JSON.stringify({
          type: 'child',
          reservationId: 'r1',
          pid: 400,
          pgid: 400,
          startedAt: 'stable',
        }),
      ].join('\n') + '\n',
    )
    const sent: Array<[number, GuardedTreeSignal]> = []
    const terminateTree = vi.fn(guardedTerminator(sent, [1_400]))
    const logSignalRefusal = vi.fn()
    const reservationPids = vi.fn().mockReturnValueOnce([400]).mockReturnValue([])
    const dependencies: GuardedCleanupDependencies = {
      readInventory: () => ({
        status: 'found',
        process: { pid: 400, pgid: 400, startedAt: 'stable' },
      }),
      readProcessIdentity: () => ({ status: 'found', identity: 'stable' }),
      terminateTree,
      findReservationPids: reservationPids,
      retryDelay: async () => {},
      protectedProcesses: {
        sender: protectedProcess(100),
        gateway: protectedProcess(200),
        supervisor: protectedProcess(300),
      },
      logSignalRefusal,
    }

    expect(await killTrackedChildren(path, dependencies)).toEqual([400])
    expect(terminateTree).toHaveBeenCalledWith(400, { allowedRootPgid: 400 })
    expect(sent.filter(([pid]) => pid < 0)).toEqual([
      [-400, 'SIGTERM'],
      [-400, 'SIGKILL'],
    ])
    expect(new Set(sent.filter(([pid]) => pid > 0).map(([pid]) => pid))).toEqual(new Set([400, 1_400]))
    expect(logSignalRefusal).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })
})
