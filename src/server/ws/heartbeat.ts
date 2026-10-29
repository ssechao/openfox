export const WS_HEARTBEAT_INTERVAL_MS = 30_000

export interface HeartbeatSocket {
  ping(): void
  terminate(): void
  on(event: 'pong', listener: () => void): unknown
}

export function startWebSocketHeartbeat(
  _sockets: () => Iterable<HeartbeatSocket>,
  _options?: { intervalMs?: number },
): () => void {
  return () => {}
}
