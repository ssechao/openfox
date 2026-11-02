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

export function createProcess(
  sessionId: string,
  name: string,
  command: string,
  cwd: string,
  timeout?: number,
): BackgroundProcess | null {
  const process = store.createProcess(sessionId, name, command, cwd)
  if (!process) return null

  if (timeout && timeout > 0) {
    setTimeout(() => {
      const p = store.getProcess(process.id, sessionId)
      if (p && p.status === 'running') {
        stopProcess(process.id, sessionId)
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
    markExited(processId, sessionId, code ?? (signal ? 1 : null))
    emitProcessEvent(processId, {
      type: 'backgroundProcess.exited',
      payload: { processId, exitCode: code ?? (signal ? 1 : null) },
      sessionId,
    })
  })

  child.on('error', (err) => {
    flushStdout()
    flushStderr()
    store.appendLog(processId, `Error: ${err.message}\n`, 'stderr')
    markExited(processId, sessionId, 1)
    emitProcessEvent(processId, {
      type: 'backgroundProcess.exited',
      payload: { processId, exitCode: 1 },
      sessionId,
    })
  })

  return child.pid ?? null
}

export async function stopProcess(processId: string, sessionId: string): Promise<void> {
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
