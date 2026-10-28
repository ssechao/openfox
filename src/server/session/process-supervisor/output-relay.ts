import type { SupervisorToGatewayMessage } from './protocol.js'

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
  const now = options.now ?? Date.now
  let backpressuredAt: number | undefined

  function write(stream: OutputStream, chunk: Buffer): void {
    if (backpressuredAt !== undefined && now() - backpressuredAt < 1_000) return
    backpressuredAt = undefined
    const delivered = options.send(
      {
        type: stream === 'stdout' ? 'worker.stdout' : 'worker.stderr',
        workerKey: options.workerKey,
        chunk: chunk.toString('utf8'),
      },
      () => {},
    )
    if (!delivered) backpressuredAt = now()
  }

  function close(onFlushed?: () => void): void {
    onFlushed?.()
  }

  return { write, close }
}
