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

export function enqueueOrderedSend(_client: SendQueueClient, _data: string, _seq: number): void {}

export function processSendQueue(_client: SendQueueClient): void {}
