import type { BackgroundProcess, LogLine } from './types.js'
import { killProcessTree } from '../../utils/process-tree.js'

const MAX_PER_SESSION = 5

export const MAX_LOG_BYTES_PER_PROCESS = 4 * 1024 * 1024
export const MAX_EXITED_PER_SESSION = 20
export const BACKGROUND_SHUTDOWN_BUDGET_MS = 2_000

interface ProcessLog {
  lines: LogLine[]
  head: number
  bytes: number
  nextOffset: number
}

const processesBySession = new Map<string, Map<string, BackgroundProcess>>()
const logsByProcess = new Map<string, ProcessLog>()

export function closeBackgroundAdmission(): void {}

export function reopenBackgroundAdmission(): void {}

export function closeSessionAdmission(_sessionId: string): void {}

export function isAdmissionClosed(_sessionId: string): boolean {
  return false
}

function emptyProcessLog(): ProcessLog {
  return { lines: [], head: 0, bytes: 0, nextOffset: 0 }
}

export function getMaxPerSession(): number {
  return MAX_PER_SESSION
}

export function getProcess(processId: string, sessionId: string): BackgroundProcess | undefined {
  return processesBySession.get(sessionId)?.get(processId)
}

export function getSessionProcesses(sessionId: string): BackgroundProcess[] {
  const sessionProcesses = processesBySession.get(sessionId)
  if (!sessionProcesses) return []
  return Array.from(sessionProcesses.values())
}

export function getSessionProcessCount(sessionId: string): number {
  return getSessionProcesses(sessionId).filter((p) => p.status !== 'exited').length
}

export function createProcess(sessionId: string, name: string, command: string, cwd: string): BackgroundProcess | null {
  const count = getSessionProcessCount(sessionId)
  if (count >= MAX_PER_SESSION) {
    return null
  }

  const process: BackgroundProcess = {
    id: crypto.randomUUID(),
    sessionId,
    name,
    command,
    cwd,
    pid: null,
    status: 'pending',
    exitCode: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
  }

  if (!processesBySession.has(sessionId)) {
    processesBySession.set(sessionId, new Map())
  }
  processesBySession.get(sessionId)!.set(process.id, process)
  logsByProcess.set(process.id, emptyProcessLog())

  return process
}

export function startProcess(processId: string, sessionId: string, pid: number): BackgroundProcess | undefined {
  const process = getProcess(processId, sessionId)
  if (!process) return undefined

  process.pid = pid
  process.status = 'running'
  process.startedAt = Date.now()
  return process
}

export function updateStatus(
  processId: string,
  sessionId: string,
  status: BackgroundProcess['status'],
  exitCode?: number | null,
): BackgroundProcess | undefined {
  const process = getProcess(processId, sessionId)
  if (!process) return undefined

  process.status = status
  if (exitCode !== undefined) {
    process.exitCode = exitCode
  }
  if (status === 'exited' || status === 'stopping') {
    process.endedAt = Date.now()
  }
  if (status === 'exited') {
    const exited = getSessionProcesses(sessionId)
      .filter((candidate) => candidate.status === 'exited')
      .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
    for (const candidate of exited.slice(0, -MAX_EXITED_PER_SESSION)) {
      removeProcess(candidate.id, sessionId)
    }
  }
  return process
}

export function removeProcess(processId: string, sessionId: string): boolean {
  const sessionProcesses = processesBySession.get(sessionId)
  if (!sessionProcesses) return false

  const deleted = sessionProcesses.delete(processId)
  logsByProcess.delete(processId)
  return deleted
}

export function appendLog(processId: string, content: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  const log = logsByProcess.get(processId)
  if (!log) return

  log.lines.push({
    offset: log.nextOffset++,
    content,
    timestamp: Date.now(),
    stream,
  })
  log.bytes += Buffer.byteLength(content)

  while (log.bytes > MAX_LOG_BYTES_PER_PROCESS && log.lines.length - log.head > 1) {
    log.bytes -= Buffer.byteLength(log.lines[log.head]!.content)
    log.head += 1
  }

  if (log.head >= 1024 && log.head * 2 >= log.lines.length) {
    log.lines = log.lines.slice(log.head)
    log.head = 0
  }
}

export function getLogs(processId: string, offset = 0, limit?: number): LogLine[] {
  const log = logsByProcess.get(processId)
  if (!log) return []

  const first = log.lines[log.head]
  const start = first ? log.head + Math.max(0, offset - first.offset) : log.head
  const retained = log.lines.slice(start)
  return limit === undefined ? retained : retained.slice(0, limit)
}

export interface PaginatedLogs {
  lines: LogLine[]
  totalLines: number
  nextOffset: number
  hasMore: boolean
}

export function getLogsPaginated(processId: string, since = 0, maxLines = 500): PaginatedLogs {
  const log = logsByProcess.get(processId)
  if (!log) {
    return { lines: [], totalLines: 0, nextOffset: 0, hasMore: false }
  }

  const first = log.lines[log.head]
  const start = first ? log.head + Math.max(0, since - first.offset) : log.head
  const lines = log.lines.slice(start, start + maxLines)
  const lastLine = lines[lines.length - 1]
  const nextOffset = lastLine ? lastLine.offset + 1 : log.nextOffset

  return {
    lines,
    totalLines: log.nextOffset,
    nextOffset,
    hasMore: start + lines.length < log.lines.length,
  }
}

export function getRetainedLogLineCount(processId: string): number {
  return logsByProcess.get(processId)?.lines.length ?? 0
}

export function clearLogs(processId: string): void {
  logsByProcess.set(processId, emptyProcessLog())
}

export function getProcessById(processId: string): BackgroundProcess | undefined {
  for (const sessionProcesses of processesBySession.values()) {
    const proc = sessionProcesses.get(processId)
    if (proc) return proc
  }
  return undefined
}

export async function cleanupAllProcesses(): Promise<void> {
  const pids: number[] = []
  for (const sessionProcesses of processesBySession.values()) {
    for (const proc of sessionProcesses.values()) {
      if (proc.status === 'running' && proc.pid) {
        pids.push(proc.pid)
      }
    }
  }
  processesBySession.clear()
  logsByProcess.clear()

  const destroyed = Promise.all(pids.map((pid) => killProcessTree(pid).catch(() => undefined)))
  let timer: NodeJS.Timeout | undefined
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BACKGROUND_SHUTDOWN_BUDGET_MS)
  })
  await Promise.race([destroyed, budget])
  clearTimeout(timer)
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      continue
    }
  }
}
