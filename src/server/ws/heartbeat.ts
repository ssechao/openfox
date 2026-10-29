import { logger } from '../utils/logger.js'

export const WS_HEARTBEAT_INTERVAL_MS = 30_000

export interface HeartbeatSocket {
  ping(): void
  terminate(): void
  on(event: 'pong', listener: () => void): unknown
}

export function startWebSocketHeartbeat(
  sockets: () => Iterable<HeartbeatSocket>,
  options?: { intervalMs?: number },
): () => void {
  const states = new WeakMap<HeartbeatSocket, { awaitingPong: boolean }>()
  const interval = setInterval(() => {
    for (const socket of sockets()) {
      let state = states.get(socket)
      if (!state) {
        const newState = { awaitingPong: false }
        state = newState
        states.set(socket, newState)
        socket.on('pong', () => {
          newState.awaitingPong = false
        })
      }

      if (state.awaitingPong) {
        logger.warn('WebSocket client missed heartbeat, terminating')
        socket.terminate()
        continue
      }

      state.awaitingPong = true
      try {
        socket.ping()
      } catch {
        logger.warn('WebSocket client missed heartbeat, terminating')
        socket.terminate()
      }
    }
  }, options?.intervalMs ?? WS_HEARTBEAT_INTERVAL_MS)
  interval.unref?.()

  return () => clearInterval(interval)
}
