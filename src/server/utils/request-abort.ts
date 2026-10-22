import type { ServerResponse } from 'node:http'

/**
 * AbortSignal tied to an HTTP response: aborts when the connection closes before
 * the response has been fully sent. The request's own 'close' is not used: since
 * Node 16 it fires once the body has been read, not when the client leaves.
 */
export function requestAbortSignal(res: ServerResponse): AbortSignal {
  const ac = new AbortController()
  const abort = () => {
    if (!res.writableFinished) ac.abort()
  }
  if (res.closed) abort()
  else res.once('close', abort)
  return ac.signal
}
