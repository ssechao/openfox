import type { SupervisorToGatewayMessage } from './protocol.js'

const WORKER_OUTPUT_MAX_BYTES_PER_WINDOW = 256 * 1024
const WORKER_OUTPUT_MAX_MESSAGES_PER_WINDOW = 100
const WORKER_OUTPUT_WINDOW_MS = 1_000
const WORKER_OUTPUT_TAIL_BYTES = 64 * 1024

type OutputStream = 'stdout' | 'stderr'
type OutputSend = (message: SupervisorToGatewayMessage, onDrain?: () => void) => boolean

interface WorkerOutputRelayOptions {
  workerKey: string
  send: OutputSend
  now?: () => number
}

export function createWorkerOutputRelay(options: WorkerOutputRelayOptions): {
  write: (stream: OutputStream, chunk: Buffer) => void
  close: (onFlushed?: () => void) => void
} {
  const outputStates = {
    stdout: { tail: Buffer.alloc(0), droppedBytes: 0 },
    stderr: { tail: Buffer.alloc(0), droppedBytes: 0 },
  }
  const now = options.now ?? Date.now
  let outputWindowStartedAt = now()
  let outputBytesInWindow = 0
  let outputMessagesInWindow = 0
  let outputBackpressured = false
  let outputClosed = false
  let closeCallback: (() => void) | undefined

  function appendDroppedOutput(stream: OutputStream, chunk: Buffer): void {
    const state = outputStates[stream]
    state.droppedBytes += chunk.length
    if (chunk.length >= WORKER_OUTPUT_TAIL_BYTES) {
      state.tail = Buffer.from(chunk.subarray(chunk.length - WORKER_OUTPUT_TAIL_BYTES))
      return
    }
    const retainedBytes = Math.min(state.tail.length, WORKER_OUTPUT_TAIL_BYTES - chunk.length)
    state.tail = Buffer.concat(
      [state.tail.subarray(state.tail.length - retainedBytes), chunk],
      retainedBytes + chunk.length,
    )
  }

  function resetOutputWindow(): void {
    const currentTime = now()
    if (currentTime - outputWindowStartedAt < WORKER_OUTPUT_WINDOW_MS) return
    outputWindowStartedAt = currentTime
    outputBytesInWindow = 0
    outputMessagesInWindow = 0
  }

  function finishClose(): void {
    if (
      !outputClosed ||
      outputBackpressured ||
      outputStates.stdout.droppedBytes > 0 ||
      outputStates.stderr.droppedBytes > 0
    ) {
      return
    }
    const callback = closeCallback
    closeCallback = undefined
    callback?.()
  }

  function resumeOutput(): void {
    if (!outputBackpressured) return
    outputBackpressured = false
    resetOutputWindow()
    flushDroppedOutput('stdout')
    if (!outputBackpressured) flushDroppedOutput('stderr')
    finishClose()
  }

  function sendOutput(stream: OutputStream, chunk: string): void {
    let pendingSend = false
    const delivered = options.send(
      {
        type: stream === 'stdout' ? 'worker.stdout' : 'worker.stderr',
        workerKey: options.workerKey,
        chunk,
      },
      () => {
        if (pendingSend) resumeOutput()
      },
    )
    outputBytesInWindow += Buffer.byteLength(chunk)
    outputMessagesInWindow++
    if (!delivered) {
      outputBackpressured = true
      pendingSend = true
    }
  }

  function flushDroppedOutput(stream: OutputStream): void {
    if (outputBackpressured) return
    const state = outputStates[stream]
    if (state.droppedBytes === 0) return
    const omittedBytes = Math.max(0, state.droppedBytes - state.tail.length)
    const marker = omittedBytes > 0 ? `[${omittedBytes} bytes omitted by supervisor]\n` : ''
    const chunk = `${marker}${state.tail.toString('utf8')}`
    state.tail = Buffer.alloc(0)
    state.droppedBytes = 0
    sendOutput(stream, chunk)
  }

  function refreshOutputWindow(): void {
    const previousWindow = outputWindowStartedAt
    resetOutputWindow()
    if (previousWindow === outputWindowStartedAt || outputBackpressured) return
    flushDroppedOutput('stdout')
    if (!outputBackpressured) flushDroppedOutput('stderr')
  }

  function write(stream: OutputStream, chunk: Buffer): void {
    if (outputClosed) return
    refreshOutputWindow()
    if (
      outputBackpressured ||
      outputMessagesInWindow >= WORKER_OUTPUT_MAX_MESSAGES_PER_WINDOW ||
      outputBytesInWindow + chunk.length > WORKER_OUTPUT_MAX_BYTES_PER_WINDOW
    ) {
      appendDroppedOutput(stream, chunk)
      return
    }
    sendOutput(stream, chunk.toString('utf8'))
  }

  function close(onFlushed?: () => void): void {
    if (outputClosed) return
    outputClosed = true
    closeCallback = onFlushed
    flushDroppedOutput('stdout')
    if (!outputBackpressured) flushDroppedOutput('stderr')
    finishClose()
  }

  return { write, close }
}
