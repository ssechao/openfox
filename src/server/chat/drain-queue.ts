import type { SessionManager } from '../session/index.js'
import type { QueuedMessage } from '../../shared/protocol.js'
import type { TurnEvent } from '../events/types.js'
import type { ServerMessage } from '../../shared/protocol.js'
import { createMessageStartEvent } from './stream-pure.js'
import { createQueueStateMessage, createChatMessageMessage, createChatDoneMessage } from '../ws/protocol.js'
import { getCurrentWindowMessageOptions } from '../events/index.js'

export interface DrainResult {
  messages: QueuedMessage[]
  hasMessages: boolean
}

export function drainQueue(
  sessionManager: SessionManager,
  sessionId: string,
  append: (event: TurnEvent) => void,
  onMessage?: (msg: ServerMessage) => void,
): DrainResult {
  const asapMessages = sessionManager.drainAsapMessages(sessionId)

  for (const asap of asapMessages) {
    const generated = asap.messageKind === 'background-exit'
    const asapMsgId = crypto.randomUUID()
    append(
      createMessageStartEvent(asapMsgId, 'user', asap.content, {
        ...(getCurrentWindowMessageOptions(sessionId) ?? {}),
        ...(asap.attachments ? { attachments: asap.attachments } : {}),
        ...(generated ? { isSystemGenerated: true, messageKind: 'auto-prompt' as const } : {}),
      }),
    )
    append({ type: 'message.done', data: { messageId: asapMsgId } })

    const message = {
      id: asapMsgId,
      role: 'user' as const,
      content: asap.content,
      timestamp: new Date().toISOString(),
      ...(asap.attachments ? { attachments: asap.attachments } : {}),
      ...(generated ? { isSystemGenerated: true, messageKind: 'auto-prompt' as const } : {}),
    }
    onMessage?.(createChatMessageMessage(message))
    onMessage?.(createChatDoneMessage(asapMsgId, 'complete'))
  }

  if (asapMessages.length > 0) {
    onMessage?.(createQueueStateMessage(sessionManager.getQueueState(sessionId)))
  }

  return { messages: asapMessages, hasMessages: asapMessages.length > 0 }
}
