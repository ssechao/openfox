import WebSocket from 'ws'
import { logger } from '../utils/logger.js'

export const MAX_SEND_QUEUE_SIZE = 1000

export interface SendQueueClient {
  ws: {
    readyState: number
    send(data: string, cb: (err?: Error) => void): void
    terminate(): void
  }
  activeSessionId: string | null
  sendQueue: Array<{ data: string; seq: number }>
  isSending: boolean
  lastSentSeq: number
}

export function enqueueOrderedSend(client: SendQueueClient, data: string, seq: number): void {
  if (client.ws.readyState !== WebSocket.OPEN) {
    return
  }
  if (client.sendQueue.length >= MAX_SEND_QUEUE_SIZE) {
    logger.warn('WebSocket send queue overflow, closing client for resync', {
      queueSize: client.sendQueue.length,
      sessionId: client.activeSessionId,
    })
    client.sendQueue.length = 0
    client.ws.terminate()
    return
  }
  client.sendQueue.push({ data, seq })
  processSendQueue(client)
}

export function processSendQueue(client: SendQueueClient): void {
  if (client.isSending || client.sendQueue.length === 0) {
    return
  }

  client.isSending = true
  const item = client.sendQueue.shift()!

  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(item.data, (err) => {
      if (err) {
        logger.debug('WebSocket send error', { error: err })
      }
      client.isSending = false
      client.lastSentSeq = item.seq
      processSendQueue(client)
    })
  } else {
    client.isSending = false
    processSendQueue(client)
  }
}
