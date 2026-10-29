import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { logger } from '../utils/logger.js'
import { enqueueOrderedSend, MAX_SEND_QUEUE_SIZE, type SendQueueClient } from './send-queue.js'

describe('enqueueOrderedSend', () => {
  it('closes the client instead of silently dropping when the send queue overflows', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const client: SendQueueClient = {
      ws: {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        terminate: vi.fn(),
      },
      activeSessionId: 'session-1',
      sendQueue: [],
      isSending: false,
      lastSentSeq: 0,
    }

    for (let seq = 1; seq <= MAX_SEND_QUEUE_SIZE + 2; seq += 1) {
      enqueueOrderedSend(client, `message-${seq}`, seq)
    }

    expect(client.ws.terminate).toHaveBeenCalledTimes(1)
    expect(client.sendQueue).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('WebSocket send queue overflow, closing client for resync', {
      queueSize: MAX_SEND_QUEUE_SIZE,
      sessionId: 'session-1',
    })
  })
})
