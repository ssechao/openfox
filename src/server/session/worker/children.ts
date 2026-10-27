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

import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { killProcessTree, signalProcessGroup } from '../../utils/process-tree.js'
import { logger } from '../../utils/logger.js'

export interface TrackedChild {
  pid: number
  startedAt: string
  command?: string
}

export interface ProcessInventoryEntry extends TrackedChild {
  pgid: number
}

export interface ExclusiveReservationInventory {
  id: string
  command?: string
  finalized: boolean
  processes: ProcessInventoryEntry[]
}

export interface ExclusiveProcessInventory {
  capturedAt: number
  worker?: ProcessInventoryEntry
  children: ProcessInventoryEntry[]
  groups: number[]
  reservations: ExclusiveReservationInventory[]
  errors: string[]
}

export interface OrphanInventoryCheck {
  checkedAt: number
  clean: boolean
  survivingIdentities: ProcessInventoryEntry[]
  survivingGroups: number[]
  liveReservations: Array<{ id: string; pids: number[] }>
  errors: string[]
}

export interface ExclusiveChildReservation {
  id: string
  path: string
  command?: string
}

export const EXCLUSIVE_CHILD_RESERVATION_ENV = 'OPENFOX_CHILD_RESERVATION_ID'

export type ProcessIdentityRead =
  { status: 'found'; identity: string } | { status: 'absent' } | { status: 'unreadable'; error: Error }

export type ProcessInventoryRead =
  { status: 'found'; process: ProcessInventoryEntry } | { status: 'absent' } | { status: 'unreadable'; error: Error }

export interface ChildrenCleanupDependencies {
  readProcessIdentity?: (pid: number) => ProcessIdentityRead
  killTree?: (pid: number) => Promise<void>
  signalGroup?: (pid: number) => Promise<boolean>
  findReservationPids?: (reservationId: string) => number[] | Promise<number[]>
  retryDelay?: () => Promise<void>
}

export type ProcessGroupRead = { status: 'found' } | { status: 'absent' } | { status: 'unreadable'; error: Error }

export interface ProcessInventoryDependencies {
  readInventory?: (pid: number, command?: string) => ProcessInventoryRead
  findReservationPids?: (reservationId: string) => number[]
  readGroup?: (pgid: number) => ProcessGroupRead
  now?: () => number
  sleep?: (delayMs: number) => Promise<void>
  recordedWorker?: ProcessInventoryEntry
}

export interface AsyncProcessInventoryDependencies extends Omit<
  ProcessInventoryDependencies,
  'findReservationPids' | 'now' | 'readInventory'
> {
  readInventory?: (pid: number, command?: string) => ProcessInventoryRead | Promise<ProcessInventoryRead>
  findReservationPids?: (reservationId: string) => number[] | Promise<number[]>
  capturedAt?: number
  inventoryTimeoutMs?: number
}

const PROCESS_INVENTORY_READ_TIMEOUT_MS = 250

function processRootExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function linuxProcessStartIdentity(stat: string): string | undefined {
  const fields = stat
    .slice(stat.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/)
  const startTicks = fields[19]
  return startTicks ? `linux:${startTicks}` : undefined
}

function prefixedProcessStartIdentity(prefix: string, value: string): string | undefined {
  const identity = value.trim()
  return identity ? `${prefix}:${identity}` : undefined
}

function processIdentityFound(identity: string | undefined): Extract<ProcessIdentityRead, { status: 'found' }> {
  if (!identity) throw new Error('process start identity was empty')
  return { status: 'found', identity }
}

function processIdentityFailure(pid: number, error: unknown): Exclude<ProcessIdentityRead, { status: 'found' }> {
  if (!processRootExists(pid)) return { status: 'absent' }
  return {
    status: 'unreadable',
    error: error instanceof Error ? error : new Error(String(error)),
  }
}

function processStartIdentity(pid: number): ProcessIdentityRead {
  try {
    if (process.platform === 'linux') {
      return processIdentityFound(linuxProcessStartIdentity(readFileSync(`/proc/${pid}/stat`, 'utf-8')))
    }
    if (process.platform === 'win32') {
      const ticks = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: 'utf-8', windowsHide: true },
      )
      return processIdentityFound(prefixedProcessStartIdentity('win32', ticks))
    }
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' })
    return processIdentityFound(prefixedProcessStartIdentity(process.platform, startedAt))
  } catch (error) {
    return processIdentityFailure(pid, error)
  }
}

function execFileText(file: string, args: string[], timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf-8', windowsHide: true, ...(timeout !== undefined ? { timeout } : {}) },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

export async function readProcessStartIdentityAsync(pid: number): Promise<ProcessIdentityRead> {
  try {
    if (process.platform === 'linux') {
      return processIdentityFound(linuxProcessStartIdentity(await readFile(`/proc/${pid}/stat`, 'utf-8')))
    }
    if (process.platform === 'win32') {
      const ticks = await execFileText('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ])
      return processIdentityFound(prefixedProcessStartIdentity('win32', ticks))
    }
    const startedAt = await execFileText('ps', ['-o', 'lstart=', '-p', String(pid)])
    return processIdentityFound(prefixedProcessStartIdentity(process.platform, startedAt))
  } catch (error) {
    return processIdentityFailure(pid, error)
  }
}

function linuxProcessGroupId(stat: string): number {
  const fields = stat
    .slice(stat.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/)
  const pgid = Number(fields[2])
  if (Number.isFinite(pgid) && pgid > 0) return pgid
  throw new Error('process group identity was empty')
}

function processGroupId(pid: number): number {
  if (process.platform === 'linux') return linuxProcessGroupId(readFileSync(`/proc/${pid}/stat`, 'utf-8'))
  if (process.platform === 'win32') return pid
  const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf-8' }).trim())
  if (Number.isFinite(pgid) && pgid > 0) return pgid
  throw new Error('process group identity was empty')
}

export function readProcessInventory(pid: number, command?: string): ProcessInventoryRead {
  const identity = processStartIdentity(pid)
  if (identity.status !== 'found') return identity
  try {
    return {
      status: 'found',
      process: {
        pid,
        startedAt: identity.identity,
        pgid: processGroupId(pid),
        ...(command ? { command } : {}),
      },
    }
  } catch (error) {
    if (!processRootExists(pid)) return { status: 'absent' }
    return { status: 'unreadable', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

async function readProcessInventoryUnboundedAsync(pid: number, command?: string): Promise<ProcessInventoryRead> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf-8')
      return {
        status: 'found',
        process: {
          pid,
          startedAt: processIdentityFound(linuxProcessStartIdentity(stat)).identity,
          pgid: linuxProcessGroupId(stat),
          ...(command ? { command } : {}),
        },
      }
    }
    if (process.platform === 'win32') {
      const ticks = await execFileText(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        PROCESS_INVENTORY_READ_TIMEOUT_MS,
      )
      return {
        status: 'found',
        process: {
          pid,
          startedAt: processIdentityFound(prefixedProcessStartIdentity('win32', ticks)).identity,
          pgid: pid,
          ...(command ? { command } : {}),
        },
      }
    }
    const [startedAt, group] = await Promise.all([
      execFileText('ps', ['-o', 'lstart=', '-p', String(pid)], PROCESS_INVENTORY_READ_TIMEOUT_MS),
      execFileText('ps', ['-o', 'pgid=', '-p', String(pid)], PROCESS_INVENTORY_READ_TIMEOUT_MS),
    ])
    const pgid = Number(group.trim())
    if (!Number.isFinite(pgid) || pgid <= 0) throw new Error('process group identity was empty')
    return {
      status: 'found',
      process: {
        pid,
        startedAt: processIdentityFound(prefixedProcessStartIdentity(process.platform, startedAt)).identity,
        pgid,
        ...(command ? { command } : {}),
      },
    }
  } catch (error) {
    return processIdentityFailure(pid, error)
  }
}

async function boundedOperation<T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
  timeoutError: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutError)), timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function boundedInventoryRead(
  readInventory: (pid: number, command?: string) => ProcessInventoryRead | Promise<ProcessInventoryRead>,
  pid: number,
  command: string | undefined,
  timeoutMs: number,
): Promise<ProcessInventoryRead> {
  try {
    return await boundedOperation(() => readInventory(pid, command), timeoutMs, 'process inventory read timed out')
  } catch (error) {
    return {
      status: 'unreadable',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export function readProcessInventoryAsync(
  pid: number,
  command?: string,
  timeoutMs = PROCESS_INVENTORY_READ_TIMEOUT_MS,
): Promise<ProcessInventoryRead> {
  return boundedInventoryRead(readProcessInventoryUnboundedAsync, pid, command, timeoutMs)
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
  const inventory = readProcessInventory(pid)
  if (inventory.status !== 'found') throw new Error('process identity unavailable')
  const entry = {
    type: 'child',
    reservationId: reservation.id,
    ...inventory.process,
    ...(reservation.command ? { command: reservation.command } : {}),
  }
  appendFileSync(reservation.path, `${JSON.stringify(entry)}\n`, 'utf-8')
}

export function trackExclusiveChild(pid: number | undefined, command?: string): void {
  finalizeExclusiveChild(reserveExclusiveChild(command), pid)
}

interface RecordedChild extends TrackedChild {
  pgid?: number
  reservationId?: string
}

interface ChildrenState {
  children: RecordedChild[]
  reservations: Map<string, string | undefined>
  finalizedReservations: Set<string>
}

function readChildrenState(path: string): ChildrenState {
  if (!existsSync(path)) {
    return { children: [], reservations: new Map(), finalizedReservations: new Set() }
  }
  const children: RecordedChild[] = []
  const seen = new Set<string>()
  const reservations = new Map<string, string | undefined>()
  const finalizedReservations = new Set<string>()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as TrackedChild & {
        type?: string
        id?: string
        reservationId?: string
        pgid?: number
      }
      if (entry.type === 'reservation' && entry.id) reservations.set(entry.id, entry.command)
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
          ...(Number.isFinite(entry.pgid) && entry.pgid! > 0 ? { pgid: entry.pgid } : {}),
          ...(entry.reservationId ? { reservationId: entry.reservationId } : {}),
          ...(entry.command ? { command: entry.command } : {}),
        })
      }
    } catch {
      continue
    }
  }
  return { children, reservations, finalizedReservations }
}

export function readTrackedChildren(path: string): TrackedChild[] {
  return readChildrenState(path).children.map(({ pid, startedAt, command }) => ({
    pid,
    startedAt,
    ...(command ? { command } : {}),
  }))
}

function parseReservationProcesses(output: string, marker: string): number[] {
  const pids = new Set<number>()
  for (const line of output.split('\n')) {
    if (!line.includes(marker)) continue
    const match = /^\s*(\d+)\s+(\d+)\s+/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(pgid) || pgid <= 0) continue
    pids.add(pid)
  }
  return [...pids]
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
    const output = execFileSync('ps', ['-Eww', '-axo', 'pid=,pgid=,command='], {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parseReservationProcesses(output, marker)
  }
  throw new Error(`Cannot recover exclusive child reservation on ${process.platform}`)
}

async function findReservationProcessesAsync(reservationId: string): Promise<number[]> {
  if (process.platform !== 'darwin') return findReservationProcesses(reservationId)
  const marker = `${EXCLUSIVE_CHILD_RESERVATION_ENV}=${reservationId}`
  const { execFile } = await import('node:child_process')
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'ps',
      ['-Eww', '-axo', 'pid=,pgid=,command='],
      { encoding: 'utf-8', timeout: 1_000, maxBuffer: 16 * 1024 * 1024 },
      (error, output) => (error ? reject(error) : resolve(output)),
    )
  })
  return parseReservationProcesses(stdout, marker)
}

function readProcessGroup(pgid: number): ProcessGroupRead {
  if (process.platform === 'win32')
    return { status: 'unreadable', error: new Error('Process groups unavailable on win32') }
  try {
    process.kill(-pgid, 0)
    return { status: 'found' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { status: 'absent' }
    if (code === 'EPERM') return { status: 'found' }
    return { status: 'unreadable', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

function captureExclusiveProcessInventoryFromState(
  workerPid: number,
  state: ChildrenState,
  dependencies: ProcessInventoryDependencies,
): ExclusiveProcessInventory {
  const readInventory = dependencies.readInventory ?? readProcessInventory
  const findReservationPids = dependencies.findReservationPids ?? findReservationProcesses
  const readGroup = dependencies.readGroup ?? readProcessGroup
  const now = dependencies.now ?? Date.now
  const errors: string[] = []
  const workerRead = dependencies.recordedWorker
    ? ({ status: 'found', process: dependencies.recordedWorker } as const)
    : readInventory(workerPid)
  let worker: ProcessInventoryEntry | undefined
  if (workerRead.status === 'found') worker = workerRead.process
  else if (workerRead.status === 'unreadable') errors.push(`worker ${workerPid}: ${workerRead.error.message}`)
  else errors.push(`worker ${workerPid}: identity unavailable before cleanup`)

  const children: ProcessInventoryEntry[] = []
  const groups = new Set<number>()
  for (const child of state.children) {
    const childRead = readInventory(child.pid, child.command)
    if (childRead.status === 'found' && childRead.process.startedAt === child.startedAt) {
      children.push(childRead.process)
      groups.add(childRead.process.pgid)
      if (child.pgid) groups.add(child.pgid)
    } else {
      if (childRead.status === 'unreadable') errors.push(`child ${child.pid}: ${childRead.error.message}`)
      if (child.pgid) {
        const groupRead = readGroup(child.pgid)
        if (groupRead.status === 'found') groups.add(child.pgid)
        else if (groupRead.status === 'unreadable')
          errors.push(`process group ${child.pgid}: ${groupRead.error.message}`)
      } else {
        errors.push(`child ${child.pid}: process group unavailable before cleanup`)
      }
    }
  }

  const reservations: ExclusiveReservationInventory[] = []
  for (const [id, command] of state.reservations) {
    const processes: ProcessInventoryEntry[] = []
    try {
      for (const pid of findReservationPids(id)) {
        const processRead = readInventory(pid, command)
        if (processRead.status === 'found') processes.push(processRead.process)
        else if (processRead.status === 'unreadable')
          errors.push(`reservation ${id} pid ${pid}: ${processRead.error.message}`)
        else errors.push(`reservation ${id} pid ${pid}: identity unavailable before cleanup`)
      }
    } catch (error) {
      errors.push(`reservation ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    reservations.push({
      id,
      ...(command ? { command } : {}),
      finalized: state.finalizedReservations.has(id),
      processes,
    })
  }

  return {
    capturedAt: now(),
    ...(worker ? { worker } : {}),
    children,
    groups: [...groups],
    reservations,
    errors,
  }
}

export function captureExclusiveProcessInventory(
  workerPid: number,
  path: string,
  dependencies: ProcessInventoryDependencies = {},
): ExclusiveProcessInventory {
  return captureExclusiveProcessInventoryFromState(workerPid, readChildrenState(path), dependencies)
}

export async function captureExclusiveProcessInventoryAsync(
  workerPid: number,
  path: string,
  dependencies: AsyncProcessInventoryDependencies = {},
): Promise<ExclusiveProcessInventory> {
  const state = readChildrenState(path)
  const timeoutMs = dependencies.inventoryTimeoutMs ?? PROCESS_INVENTORY_READ_TIMEOUT_MS
  const readInventory = dependencies.readInventory ?? readProcessInventoryAsync
  const findReservationPids = dependencies.findReservationPids ?? findReservationProcessesAsync
  const reservationScans = new Map<string, number[] | Error>()
  const inventoryReads = new Map<string, Promise<ProcessInventoryRead>>()
  const inventoryResults = new Map<string, ProcessInventoryRead>()
  const inventoryKey = (pid: number, command?: string) => `${pid}:\0${command ?? ''}`
  const queueInventoryRead = (pid: number, command?: string) => {
    const key = inventoryKey(pid, command)
    if (!inventoryReads.has(key)) {
      inventoryReads.set(
        key,
        boundedInventoryRead(readInventory, pid, command, timeoutMs).then((result) => {
          inventoryResults.set(key, result)
          return result
        }),
      )
    }
  }

  if (!dependencies.recordedWorker) queueInventoryRead(workerPid)
  for (const child of state.children) queueInventoryRead(child.pid, child.command)
  await Promise.all(
    [...state.reservations].map(async ([id, command]) => {
      try {
        const pids = await boundedOperation(
          () => findReservationPids(id),
          timeoutMs,
          'reservation inventory scan timed out',
        )
        reservationScans.set(id, pids)
        for (const pid of pids) queueInventoryRead(pid, command)
      } catch (error) {
        reservationScans.set(id, error instanceof Error ? error : new Error(String(error)))
      }
    }),
  )
  await Promise.all(inventoryReads.values())

  return captureExclusiveProcessInventoryFromState(workerPid, state, {
    readInventory: (pid, command) =>
      inventoryResults.get(inventoryKey(pid, command)) ?? {
        status: 'unreadable',
        error: new Error('process inventory read result unavailable'),
      },
    ...(dependencies.readGroup ? { readGroup: dependencies.readGroup } : {}),
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    ...(dependencies.recordedWorker ? { recordedWorker: dependencies.recordedWorker } : {}),
    ...(dependencies.capturedAt !== undefined ? { now: () => dependencies.capturedAt! } : {}),
    findReservationPids: (id) => {
      const result = reservationScans.get(id)
      if (result instanceof Error) throw result
      return result ?? []
    },
  })
}

export async function verifyExclusiveProcessInventoryAfter(
  inventory: ExclusiveProcessInventory,
  dependencies: ProcessInventoryDependencies = {},
): Promise<OrphanInventoryCheck> {
  const readInventory = dependencies.readInventory ?? readProcessInventory
  const findReservationPids = dependencies.findReservationPids ?? findReservationProcesses
  const readGroup = dependencies.readGroup ?? readProcessGroup
  const now = dependencies.now ?? Date.now
  const sleep =
    dependencies.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const proofAt = inventory.capturedAt + 2_000
  while (now() < proofAt) await sleep(proofAt - now())

  const checkedAt = now()
  const errors = [...inventory.errors]
  const survivingIdentities: ProcessInventoryEntry[] = []
  const identities = [
    ...(inventory.worker ? [inventory.worker] : []),
    ...inventory.children,
    ...inventory.reservations.flatMap((reservation) => reservation.processes),
  ]
  const seenIdentities = new Set<string>()
  for (const entry of identities) {
    const key = `${entry.pid}:${entry.startedAt}`
    if (seenIdentities.has(key)) continue
    seenIdentities.add(key)
    const processRead = readInventory(entry.pid, entry.command)
    if (processRead.status === 'found' && processRead.process.startedAt === entry.startedAt) {
      survivingIdentities.push(entry)
    } else if (processRead.status === 'unreadable') {
      errors.push(`pid ${entry.pid}: ${processRead.error.message}`)
    }
  }

  const survivingGroups: number[] = []
  const groups = new Set([
    ...inventory.groups,
    ...inventory.children.map((entry) => entry.pgid),
    ...inventory.reservations.flatMap((reservation) => reservation.processes.map((entry) => entry.pgid)),
  ])
  for (const pgid of groups) {
    const groupRead = readGroup(pgid)
    if (groupRead.status === 'found') survivingGroups.push(pgid)
    else if (groupRead.status === 'unreadable') errors.push(`process group ${pgid}: ${groupRead.error.message}`)
  }

  const liveReservations: Array<{ id: string; pids: number[] }> = []
  for (const reservation of inventory.reservations) {
    try {
      const pids = findReservationPids(reservation.id)
      if (pids.length > 0) liveReservations.push({ id: reservation.id, pids })
    } catch (error) {
      errors.push(`reservation ${reservation.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    checkedAt,
    clean:
      survivingIdentities.length === 0 &&
      survivingGroups.length === 0 &&
      liveReservations.length === 0 &&
      errors.length === 0,
    survivingIdentities,
    survivingGroups,
    liveReservations,
    errors,
  }
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
  const findReservationPids = dependencies.findReservationPids ?? findReservationProcesses
  const retryDelay = dependencies.retryDelay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
  const state = readChildrenState(path)
  const killed: number[] = []
  const killedSet = new Set<number>()
  let hasUnreadableIdentity = false
  for (const reservationId of state.reservations.keys()) {
    for (const pid of await findReservationPids(reservationId)) {
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
  let hasMarkedReservationProcesses = false
  for (const reservationId of state.reservations.keys()) {
    if ((await findReservationPids(reservationId)).length > 0) {
      hasMarkedReservationProcesses = true
      break
    }
  }
  if (!hasUnreadableIdentity && !hasMarkedReservationProcesses) removeChildrenFile(path)
  return killed
}

export function removeChildrenFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone
  }
}
