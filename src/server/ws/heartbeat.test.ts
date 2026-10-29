import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWebSocketHeartbeat, type HeartbeatSocket } from './heartbeat.js'

class TestHeartbeatSocket extends EventEmitter implements HeartbeatSocket {
  ping = vi.fn()
  terminate = vi.fn()
}

describe('startWebSocketHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminates a socket that did not answer the previous heartbeat ping', async () => {
    vi.useFakeTimers()
    const socket = new TestHeartbeatSocket()
    const stop = startWebSocketHeartbeat(() => [socket], { intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    expect(socket.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps a socket that answered the heartbeat with pong', async () => {
    vi.useFakeTimers()
    const socket = new TestHeartbeatSocket()
    const stop = startWebSocketHeartbeat(() => [socket], { intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    socket.emit('pong')
    await vi.advanceTimersByTimeAsync(1000)

    expect(socket.terminate).not.toHaveBeenCalled()
    expect(socket.ping).toHaveBeenCalledTimes(2)
    stop()
  })
})
