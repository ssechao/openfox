import type { SessionManager } from '../session/index.js'
import type { QueuedMessage } from '../../shared/protocol.js'
import type { TurnEvent } from '../events/types.js'
import type { ServerMessage } from '../../shared/protocol.js'
import { createQueueStateMessage, createChatMessageMessage, createChatDoneMessage } from '../ws/protocol.js'
import { getCurrentWindowMessageOptions, getEventStore } from '../events/index.js'

const CARRIED_MESSAGE_KINDS = [
  'correction',
  'auto-prompt',
  'context-reset',
  'task-completed',
  'workflow-started',
  'command',
] as const

type CarriedMessageKind = (typeof CARRIED_MESSAGE_KINDS)[number]

export interface AsapDrainBatch {
  messages: QueuedMessage[]
  queueState: QueuedMessage[]
  commit: () => void
  abort: () => void
}

export type AsapQueueDrain = (sessionId: string) => AsapDrainBatch | Promise<AsapDrainBatch>

export interface DrainResult {
  messages: QueuedMessage[]
  hasMessages: boolean
}

let asapQueueDrain: AsapQueueDrain | null = null

export function setAsapQueueDrain(drain: AsapQueueDrain | null): void {
  asapQueueDrain = drain
}

function carriedFields(messageKind: string | undefined):
  | {
      messageKind: CarriedMessageKind
      isSystemGenerated?: true
    }
  | undefined {
  if (messageKind === 'background-exit') return { messageKind: 'auto-prompt', isSystemGenerated: true }
  if (messageKind && (CARRIED_MESSAGE_KINDS as readonly string[]).includes(messageKind)) {
    return { messageKind: messageKind as CarriedMessageKind }
  }
  return undefined
}

function knownMessageIds(sessionId: string): Set<string> {
  const ids = new Set<string>()
  for (const event of getEventStore().getEvents(sessionId)) {
    if (event.type !== 'message.start') continue
    const messageId = (event.data as { messageId?: unknown }).messageId
    if (typeof messageId === 'string') ids.add(messageId)
  }
  return ids
}

export async function drainQueue(
  sessionManager: SessionManager,
  sessionId: string,
  append: (event: TurnEvent) => void,
  onMessage?: (msg: ServerMessage) => void,
): Promise<DrainResult> {
  const localMessages = asapQueueDrain ? null : sessionManager.drainAsapMessages(sessionId)
  const batch = asapQueueDrain
    ? await asapQueueDrain(sessionId)
    : {
        messages: localMessages ?? [],
        queueState: localMessages && localMessages.length > 0 ? sessionManager.getQueueState(sessionId) : [],
        commit() {},
        abort() {},
      }

  try {
    const known = batch.messages.length > 0 ? knownMessageIds(sessionId) : new Set<string>()
    const delivered: QueuedMessage[] = []
    for (const asap of batch.messages) {
      if (known.has(asap.queueId)) continue
      known.add(asap.queueId)
      delivered.push(asap)
      const carried = carriedFields(asap.messageKind)
      const windowOptions = getCurrentWindowMessageOptions(sessionId)
      append({
        type: 'message.start',
        data: {
          messageId: asap.queueId,
          role: 'user',
          content: asap.content,
          ...(windowOptions !== undefined && { contextWindowId: windowOptions.contextWindowId }),
          ...(carried?.isSystemGenerated !== undefined && { isSystemGenerated: carried.isSystemGenerated }),
          ...(carried !== undefined && { messageKind: carried.messageKind }),
          ...(asap.attachments !== undefined && { attachments: asap.attachments }),
        },
      })
      append({ type: 'message.done', data: { messageId: asap.queueId } })

      const message = {
        id: asap.queueId,
        role: 'user' as const,
        content: asap.content,
        timestamp: new Date().toISOString(),
        ...(asap.attachments ? { attachments: asap.attachments } : {}),
        ...(carried?.isSystemGenerated ? { isSystemGenerated: true } : {}),
        ...(carried ? { messageKind: carried.messageKind } : {}),
      }
      onMessage?.(createChatMessageMessage(message))
      onMessage?.(createChatDoneMessage(asap.queueId, 'complete'))
    }

    if (batch.messages.length > 0) {
      onMessage?.(createQueueStateMessage(batch.queueState))
    }
    batch.commit()
    return { messages: delivered, hasMessages: delivered.length > 0 }
  } catch (error) {
    batch.abort()
    throw error
  }
}
