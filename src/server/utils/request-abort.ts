import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * AbortSignal tied to the HTTP request. Aborts when the client disconnects
 * before the response has been sent. Close after a finished response is ignored.
 */
export function requestAbortSignal(req: IncomingMessage, res?: ServerResponse): AbortSignal {
  const ac = new AbortController()
  const abort = () => {
    if (res?.writableEnded) return
    if (!ac.signal.aborted) ac.abort()
  }
  req.once('aborted', abort)
  req.once('close', abort)
  return ac.signal
}
