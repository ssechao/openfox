import type { ServerMessage, BackgroundProcess } from '../../../shared/protocol.js'
import * as store from './store.js'
import { spawnShell } from '../../utils/shell.js'
import { killProcessTree } from '../../utils/process-tree.js'
import { createUtf8StreamDecoder } from '../../utils/utf8.js'

export const OUTPUT_WINDOW_MS = 100
export const MAX_OUTPUT_BYTES_PER_WINDOW = 128 * 1024

type ProcessEventListener = (processId: string, msg: ServerMessage) => void
const listeners = new Set<ProcessEventListener>()

export function onProcessEvent(callback: ProcessEventListener): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function emitProcessEvent(processId: string, msg: ServerMessage): void {
  for (const listener of listeners) {
    listener(processId, msg)
  }
}

export interface ExitNotice {
  sessionId: string
  processId: string
  name: string
  exitCode: number | null
  timedOut: boolean
  output: string
}

type ExitNotifier = (notice: ExitNotice) => void
let exitNotifier: ExitNotifier | null = null
// Processes started with notifyOnExit, until their single notice is sent or an
// explicit stop cancels it.
const pendingExitNotices = new Map<string, { sessionId: string; name: string }>()
const EXIT_NOTICE_MAX_LINES = 20
const EXIT_NOTICE_MAX_CHARS = 4000

export function setExitNotifier(notifier: ExitNotifier | null): void {
  exitNotifier = notifier
}

export function formatExitNotice(notice: ExitNotice): string {
  const outcome = notice.timedOut
    ? 'was stopped by its timeout'
    : `exited with code ${notice.exitCode === null ? 'unknown' : String(notice.exitCode)}`
  const output = notice.output === '' ? '(no output)' : notice.output
  return `Background process "${notice.name}" (${notice.processId}) ${outcome}.\nLast output lines:\n${output}`
}

function lastOutput(processId: string): string {
  const lines = store
    .getLogs(processId)
    .map((line) => line.content)
    .join('')
    .split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-EXIT_NOTICE_MAX_LINES).join('\n')
  return tail.length > EXIT_NOTICE_MAX_CHARS ? tail.slice(-EXIT_NOTICE_MAX_CHARS) : tail
}

function notifyExit(processId: string, exitCode: number | null, timedOut: boolean, output: string): void {
  const pending = pendingExitNotices.get(processId)
  if (!pending) return
  pendingExitNotices.delete(processId)
  exitNotifier?.({ sessionId: pending.sessionId, processId, name: pending.name, exitCode, timedOut, output })
}

export function createProcess(
  sessionId: string,
  name: string,
  command: string,
  cwd: string,
  timeout?: number,
  notifyOnExit = false,
): BackgroundProcess | null {
  const process = store.createProcess(sessionId, name, command, cwd)
  if (!process) return null
  if (notifyOnExit) pendingExitNotices.set(process.id, { sessionId, name: process.name })

  if (timeout && timeout > 0) {
    setTimeout(() => {
      const p = store.getProcess(process.id, sessionId)
      if (p && p.status === 'running') {
        const output = lastOutput(process.id)
        void terminateProcess(process.id, sessionId).then(() => notifyExit(process.id, null, true, output))
      }
    }, timeout).unref()
  }

  return process
}

// A stop in flight owns the entry until killProcessTree is done: the leader
// exiting first must not hide a TERM-resistant descendant from cleanup.
function markExited(processId: string, sessionId: string, exitCode: number | null): void {
  if (store.getProcess(processId, sessionId)?.status === 'stopping') return
  store.updateStatus(processId, sessionId, 'exited', exitCode)
}

export function startProcessCommand(processId: string, sessionId: string, command: string, cwd: string): number | null {
  const proc = store.startProcess(processId, sessionId, 0)
  if (!proc) return null

  const child = spawnShell(command, {
    cwd,
    detached: true,
  })

  proc.pid = child.pid ?? null
  store.updateStatus(processId, sessionId, 'running')

  emitProcessEvent(processId, {
    type: 'backgroundProcess.started',
    payload: {
      processId,
      name: proc.name,
      command: proc.command,
      cwd: proc.cwd,
      pid: child.pid ?? null,
      status: 'running',
    },
    sessionId,
  })

  const attachOutput = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): (() => void) => {
    const decoder = createUtf8StreamDecoder()
    let pending = ''
    let windowBytes = 0
    let timer: NodeJS.Timeout | null = null

    const flush = () => {
      if (!pending) return
      emitProcessEvent(processId, {
        type: 'backgroundProcess.output',
        payload: { processId, stream: name, content: pending },
        sessionId,
      })
      pending = ''
    }

    const endWindow = () => {
      timer = null
      windowBytes = 0
      flush()
      stream?.resume()
    }

    stream?.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk)
      store.appendLog(processId, text, name)
      if (Buffer.byteLength(pending) < MAX_OUTPUT_BYTES_PER_WINDOW) {
        pending += text
      }
      windowBytes += chunk.length
      if (windowBytes >= MAX_OUTPUT_BYTES_PER_WINDOW) {
        stream.pause()
      }
      if (timer === null) {
        timer = setTimeout(endWindow, OUTPUT_WINDOW_MS)
        timer.unref()
      }
    })

    stream?.on('close', () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      const rest = decoder.end()
      if (rest) {
        store.appendLog(processId, rest, name)
        pending += rest
      }
      flush()
    })

    return flush
  }

  const flushStdout = attachOutput(child.stdout, 'stdout')
  const flushStderr = attachOutput(child.stderr, 'stderr')

  child.on('exit', (code, signal) => {
    flushStdout()
    flushStderr()
    const exitCode = code ?? (signal ? 1 : null)
    // Only a process ending on its own notifies here: a stop in flight (explicit
    // or by timeout) and a shutdown (entry already cleared) are handled elsewhere.
    const endedOnItsOwn = store.getProcess(processId, sessionId)?.status === 'running'
    markExited(processId, sessionId, exitCode)
    emitProcessEvent(processId, {
      type: 'backgroundProcess.exited',
      payload: { processId, exitCode },
      sessionId,
    })
    if (endedOnItsOwn) notifyExit(processId, exitCode, false, lastOutput(processId))
  })

  child.on('error', (err) => {
    flushStdout()
    flushStderr()
    store.appendLog(processId, `Error: ${err.message}\n`, 'stderr')
    const endedOnItsOwn = store.getProcess(processId, sessionId)?.status === 'running'
    markExited(processId, sessionId, 1)
    emitProcessEvent(processId, {
      type: 'backgroundProcess.exited',
      payload: { processId, exitCode: 1 },
      sessionId,
    })
    if (endedOnItsOwn) notifyExit(processId, 1, false, lastOutput(processId))
  })

  return child.pid ?? null
}

export async function stopProcess(processId: string, sessionId: string): Promise<void> {
  // An explicit stop is the caller's own decision: no exit notice.
  pendingExitNotices.delete(processId)
  await terminateProcess(processId, sessionId)
}

async function terminateProcess(processId: string, sessionId: string): Promise<void> {
  const proc = store.getProcess(processId, sessionId)

  if (!proc || proc.status !== 'running' || !proc.pid) {
    return
  }

  store.updateStatus(processId, sessionId, 'stopping')

  await killProcessTree(proc.pid!)

  store.updateStatus(processId, sessionId, 'exited', null)
  emitProcessEvent(processId, {
    type: 'backgroundProcess.removed',
    payload: { processId },
    sessionId,
  })
  store.removeProcess(processId, sessionId)
}

export async function destroySessionProcesses(sessionId: string): Promise<void> {
  store.closeSessionAdmission(sessionId)
  for (const proc of store.getSessionProcesses(sessionId)) {
    if (proc.status === 'running') {
      await stopProcess(proc.id, sessionId)
    } else if (proc.status === 'stopping' && proc.pid) {
      // A stop already in flight: keep the entry until the tree is dead so a
      // shutdown racing this deletion still finds and kills it.
      await killProcessTree(proc.pid)
      store.removeProcess(proc.id, sessionId)
    } else {
      store.removeProcess(proc.id, sessionId)
    }
  }
}

export function getProcessStatus(processId: string, sessionId: string): BackgroundProcess | undefined {
  return store.getProcess(processId, sessionId)
}

export function getSessionProcesses(sessionId: string): BackgroundProcess[] {
  return store.getSessionProcesses(sessionId)
}

export function getProcessLogs(processId: string, since = 0, maxLines?: number) {
  return store.getLogsPaginated(processId, since, maxLines)
}
