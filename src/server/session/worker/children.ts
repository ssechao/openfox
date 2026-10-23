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

function processStartIdentity(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/)
      const startTicks = fields[19]
      return startTicks ? `linux:${startTicks}` : null
    }
    if (process.platform === 'win32') {
      const ticks = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: 'utf-8', windowsHide: true },
      ).trim()
      return ticks ? `win32:${ticks}` : null
    }
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
    return startedAt ? `${process.platform}:${startedAt}` : null
  } catch {
    return null
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
  const startedAt = processStartIdentity(pid)
  if (!startedAt) throw new Error('process start identity unavailable')
  const entry = {
    type: 'child',
    reservationId: reservation.id,
    pid,
    startedAt,
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
    const output = execFileSync('ps', ['eww', '-axo', 'pid=,command='], { encoding: 'utf-8' })
    return output
      .split('\n')
      .filter((line) => line.includes(marker))
      .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
      .filter((pid) => Number.isFinite(pid) && pid > 0)
  }
  throw new Error(`Cannot recover exclusive child reservation on ${process.platform}`)
}

/**
 * Kill every recorded child's process group, then unlink the file. Returns
 * the pids that were signaled (the cleanup proof). Missing processes are
 * fine — they may have exited on their own before the worker died.
 */
export async function killTrackedChildren(path: string): Promise<number[]> {
  const state = readChildrenState(path)
  const killed: number[] = []
  const killedSet = new Set<number>()
  for (const reservationId of state.pendingReservationIds) {
    for (const pid of findReservationProcesses(reservationId)) {
      if (killedSet.has(pid)) continue
      await killProcessTree(pid)
      killedSet.add(pid)
      killed.push(pid)
    }
  }
  for (const child of state.children) {
    try {
      const currentIdentity = processStartIdentity(child.pid)
      if (currentIdentity === child.startedAt) {
        await killProcessTree(child.pid)
        killed.push(child.pid)
      } else if (currentIdentity === null && (await signalProcessGroup(child.pid))) {
        killed.push(child.pid)
      }
    } catch (error) {
      logger.debug('Worker child already gone', {
        pid: child.pid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  removeChildrenFile(path)
  return killed
}

export function removeChildrenFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone
  }
}
