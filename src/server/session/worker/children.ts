/**
 * Exclusive-child tracking for session workers (étape 6a).
 *
 * A worker's shell children spawn detached (own process group), so a
 * `kill -9` on the worker leaves them orphaned and reparented. The worker
 * therefore records every spawned child pid synchronously in a sidecar file
 * (append-only JSONL, survives SIGKILL); the gateway reads that file when the
 * worker dies and kills each recorded process group.
 *
 * Tracking is active only inside a worker process (OPENFOX_WORKER_CHILDREN
 * set); everywhere else `trackExclusiveChild` is a no-op, so the gateway's own
 * shell calls and the shared MCP/LSP servers are never recorded and never
 * touched by the cleanup.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { killProcessTree, signalProcessGroup } from '../../utils/process-tree.js'
import { logger } from '../../utils/logger.js'

export interface TrackedChild {
  pid: number
  startedAt: string
  command?: string
}

export interface ExclusiveChildReservation {
  id: string
  path: string
  command?: string
}

export const EXCLUSIVE_CHILD_RESERVATION_ENV = 'OPENFOX_CHILD_RESERVATION_ID'

export type ProcessIdentityRead =
  { status: 'found'; identity: string } | { status: 'absent' } | { status: 'unreadable'; error: Error }

export interface ChildrenCleanupDependencies {
  readProcessIdentity?: (pid: number) => ProcessIdentityRead
  killTree?: (pid: number) => Promise<void>
  signalGroup?: (pid: number) => Promise<boolean>
  retryDelay?: () => Promise<void>
}

function processRootExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function processStartIdentity(pid: number): ProcessIdentityRead {
  try {
    let identity: string | undefined
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/)
      const startTicks = fields[19]
      identity = startTicks ? `linux:${startTicks}` : undefined
    } else if (process.platform === 'win32') {
      const ticks = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: 'utf-8', windowsHide: true },
      ).trim()
      identity = ticks ? `win32:${ticks}` : undefined
    } else {
      const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
      identity = startedAt ? `${process.platform}:${startedAt}` : undefined
    }
    if (!identity) throw new Error('process start identity was empty')
    return { status: 'found', identity }
  } catch (error) {
    if (!processRootExists(pid)) return { status: 'absent' }
    return {
      status: 'unreadable',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export function childrenFilePath(dbPath: string, workerId: string): string {
  return `${dbPath}.worker-${workerId}.children`
}

function activeFilePath(): string | null {
  const path = process.env['OPENFOX_WORKER_CHILDREN']
  return path && path.length > 0 ? path : null
}

export function initChildrenTracking(path: string): void {
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 })
}

export function reserveExclusiveChild(command?: string): ExclusiveChildReservation | null {
  const path = activeFilePath()
  if (!path) return null
  const reservation: ExclusiveChildReservation = {
    id: randomUUID(),
    path,
    ...(command ? { command: command.slice(0, 200) } : {}),
  }
  appendFileSync(
    path,
    `${JSON.stringify({ type: 'reservation', id: reservation.id, ...(reservation.command ? { command: reservation.command } : {}) })}\n`,
    'utf-8',
  )
  return reservation
}

export function exclusiveChildReservationEnv(reservation: ExclusiveChildReservation | null): NodeJS.ProcessEnv {
  return reservation ? { [EXCLUSIVE_CHILD_RESERVATION_ENV]: reservation.id } : {}
}

export function finalizeExclusiveChild(reservation: ExclusiveChildReservation | null, pid: number | undefined): void {
  if (!reservation) return
  if (!pid || !Number.isFinite(pid) || pid <= 0) throw new Error('spawned child pid unavailable')
  const identity = processStartIdentity(pid)
  if (identity.status !== 'found') throw new Error('process start identity unavailable')
  const entry = {
    type: 'child',
    reservationId: reservation.id,
    pid,
    startedAt: identity.identity,
    ...(reservation.command ? { command: reservation.command } : {}),
  }
  appendFileSync(reservation.path, `${JSON.stringify(entry)}\n`, 'utf-8')
}

export function trackExclusiveChild(pid: number | undefined, command?: string): void {
  finalizeExclusiveChild(reserveExclusiveChild(command), pid)
}

interface ChildrenState {
  children: TrackedChild[]
  pendingReservationIds: string[]
}

function readChildrenState(path: string): ChildrenState {
  if (!existsSync(path)) return { children: [], pendingReservationIds: [] }
  const children: TrackedChild[] = []
  const seen = new Set<string>()
  const reservations = new Set<string>()
  const finalizedReservations = new Set<string>()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as TrackedChild & { type?: string; id?: string; reservationId?: string }
      if (entry.type === 'reservation' && entry.id) reservations.add(entry.id)
      if (entry.type === 'child' && entry.reservationId) finalizedReservations.add(entry.reservationId)
      if (
        Number.isFinite(entry.pid) &&
        entry.pid > 0 &&
        typeof entry.startedAt === 'string' &&
        entry.startedAt.length > 0 &&
        !seen.has(`${entry.pid}:${entry.startedAt}`)
      ) {
        seen.add(`${entry.pid}:${entry.startedAt}`)
        children.push({
          pid: entry.pid,
          startedAt: entry.startedAt,
          ...(entry.command ? { command: entry.command } : {}),
        })
      }
    } catch {
      continue
    }
  }
  return {
    children,
    pendingReservationIds: [...reservations].filter((id) => !finalizedReservations.has(id)),
  }
}

export function readTrackedChildren(path: string): TrackedChild[] {
  return readChildrenState(path).children
}

function findReservationProcesses(reservationId: string): number[] {
  const marker = `${EXCLUSIVE_CHILD_RESERVATION_ENV}=${reservationId}`
  if (process.platform === 'linux') {
    const pids: number[] = []
    for (const entry of readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      try {
        if (readFileSync(`/proc/${entry.name}/environ`, 'utf-8').split('\0').includes(marker)) {
          pids.push(Number(entry.name))
        }
      } catch {
        continue
      }
    }
    return pids
  }
  if (process.platform === 'darwin') {
    const output = execFileSync('ps', ['-Eww', '-axo', 'pid=,pgid=,command='], { encoding: 'utf-8' })
    const groupRoots = new Map<number, number>()
    for (const line of output.split('\n')) {
      if (!line.includes(marker)) continue
      const match = /^\s*(\d+)\s+(\d+)\s+/.exec(line)
      if (!match) continue
      const pid = Number(match[1])
      const pgid = Number(match[2])
      if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(pgid) || pgid <= 0) continue
      const current = groupRoots.get(pgid)
      if (current === undefined || pid === pgid) groupRoots.set(pgid, pid)
    }
    return [...groupRoots.values()]
  }
  throw new Error(`Cannot recover exclusive child reservation on ${process.platform}`)
}

/**
 * Kill every recorded child's process group, then unlink the file. Returns
 * the pids that were signaled (the cleanup proof). Missing processes are
 * fine — they may have exited on their own before the worker died.
 */
export async function killTrackedChildren(
  path: string,
  dependencies: ChildrenCleanupDependencies = {},
): Promise<number[]> {
  const readProcessIdentity = dependencies.readProcessIdentity ?? processStartIdentity
  const killTree = dependencies.killTree ?? killProcessTree
  const signalGroup = dependencies.signalGroup ?? signalProcessGroup
  const retryDelay = dependencies.retryDelay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
  const state = readChildrenState(path)
  const killed: number[] = []
  const killedSet = new Set<number>()
  let hasUnreadableIdentity = false
  for (const reservationId of state.pendingReservationIds) {
    for (const pid of findReservationProcesses(reservationId)) {
      if (killedSet.has(pid)) continue
      await killTree(pid)
      killedSet.add(pid)
      killed.push(pid)
    }
  }
  for (const child of state.children) {
    try {
      let identity = readProcessIdentity(child.pid)
      if (identity.status === 'unreadable') {
        logger.error('Unable to read worker child process identity; retrying cleanup', {
          pid: child.pid,
          error: identity.error.message,
        })
        await retryDelay()
        identity = readProcessIdentity(child.pid)
      }
      if (identity.status === 'found' && identity.identity === child.startedAt) {
        await killTree(child.pid)
        killed.push(child.pid)
      } else if (identity.status === 'absent' && (await signalGroup(child.pid))) {
        killed.push(child.pid)
      } else if (identity.status === 'unreadable') {
        hasUnreadableIdentity = true
        logger.error('Unable to read worker child process identity; process group left untouched', {
          pid: child.pid,
          error: identity.error.message,
        })
      }
    } catch (error) {
      logger.debug('Worker child already gone', {
        pid: child.pid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (!hasUnreadableIdentity) removeChildrenFile(path)
  return killed
}

export function removeChildrenFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone
  }
}
