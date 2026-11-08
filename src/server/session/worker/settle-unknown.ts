import type { ToolResult } from '../../../shared/types.js'
import type { PendingToolReconciliation, SessionSnapshot, StoredEvent, TurnEvent } from '../../events/types.js'
import { foldPendingToolReconciliations } from '../../events/fold-state.js'
import { createToolResultEvent } from '../../chat/stream-pure.js'

export const UNKNOWN_TOOL_OUTCOME_ERROR =
  'Tool result is unknown because execution was interrupted after the tool may have produced external effects. Do not retry this call automatically.'

export function syntheticUnknownToolResult(): ToolResult {
  return {
    success: false,
    outcomeUnknown: true,
    error: UNKNOWN_TOOL_OUTCOME_ERROR,
    durationMs: 0,
    truncated: false,
  }
}

export function findPendingToolReconciliations(events: StoredEvent[]): PendingToolReconciliation[] {
  let turnStartedAt = -Infinity
  for (const event of events) {
    if (event.type === 'running.changed' && (event.data as { isRunning: boolean }).isRunning) {
      turnStartedAt = event.timestamp
    } else if (event.type === 'message.start' && (event.data as { role?: string }).role === 'user') {
      turnStartedAt = Math.max(turnStartedAt, event.timestamp)
    } else if (event.type === 'turn.snapshot') {
      for (const message of (event.data as SessionSnapshot).messages) {
        if (message.role === 'user') turnStartedAt = Math.max(turnStartedAt, message.timestamp)
      }
    }
  }

  const pending = new Map<string, PendingToolReconciliation>()
  for (const event of events) {
    if (event.type === 'turn.snapshot') {
      const snapshot = event.data as SessionSnapshot
      for (const message of snapshot.messages) {
        for (const toolCall of message.toolCalls ?? []) {
          if (!toolCall.result && (toolCall.startedAt ?? message.timestamp) >= turnStartedAt) {
            pending.set(toolCall.id, {
              messageId: message.id,
              toolCallId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            })
          }
        }
      }
    } else if (event.type === 'tool.call' && event.timestamp >= turnStartedAt) {
      const data = event.data as Extract<TurnEvent, { type: 'tool.call' }>['data']
      pending.set(data.toolCall.id, {
        messageId: data.messageId,
        toolCallId: data.toolCall.id,
        name: data.toolCall.name,
        arguments: data.toolCall.arguments,
      })
    } else if (event.type === 'tool.result') {
      pending.delete((event.data as { toolCallId: string }).toolCallId)
    }
  }
  return [...pending.values()]
}

export function settleOneUnknownToolOutcome(
  events: readonly StoredEvent[],
  pending: { messageId: string; toolCallId: string },
  append: (event: TurnEvent) => void,
): void {
  const settled = events.some(
    (event) => event.type === 'tool.result' && (event.data as { toolCallId: string }).toolCallId === pending.toolCallId,
  )
  if (settled) return
  append(createToolResultEvent(pending.messageId, pending.toolCallId, syntheticUnknownToolResult()))
}

export function sessionResumeAllowed(events: readonly StoredEvent[], interruptedAt: string): boolean {
  return events.some(
    (event) =>
      event.type === 'worker.recovery_clean' &&
      (event.data as { interruptedAt?: string }).interruptedAt === interruptedAt,
  )
}

export function settleUnknownToolOutcomes(events: readonly StoredEvent[], append: (event: TurnEvent) => void): void {
  const snapshot = events.slice()
  const resulted = new Set<string>()
  for (const event of snapshot) {
    if (event.type === 'tool.result') {
      resulted.add((event.data as { toolCallId: string }).toolCallId)
    }
  }

  for (const pending of findPendingToolReconciliations(snapshot)) {
    if (resulted.has(pending.toolCallId)) continue
    append(createToolResultEvent(pending.messageId, pending.toolCallId, syntheticUnknownToolResult()))
    resulted.add(pending.toolCallId)
  }

  for (const item of foldPendingToolReconciliations(snapshot)) {
    if (!resulted.has(item.toolCallId)) {
      append(createToolResultEvent(item.messageId, item.toolCallId, syntheticUnknownToolResult()))
      resulted.add(item.toolCallId)
    }
    append({ type: 'tool.reconciliation_resolved', data: { toolCallId: item.toolCallId } })
  }
}
