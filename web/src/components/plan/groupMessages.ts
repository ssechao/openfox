import type { Message, ToolCall } from '@shared/types.js'

export type { Message, ToolCall }

// Display item: either a single message, a grouped sub-agent run, or a context window divider
export type DisplayItem =
  | { type: 'message'; message: Message }
  | { type: 'subagent'; subAgentId: string; subAgentType: string; messages: Message[] }
  | { type: 'context-divider'; windowSequence: number }

/**
 * Group messages into display items, collecting sub-agent messages by
 * subAgentId within each context window and emitting complete groups
 * in order of first occurrence.
 *
 * Unlike the previous adjacency-based approach, this correctly handles
 * interleaved messages from parallel sub-agent executions — all messages
 * for one sub-agent within a context window end up in a single group
 * regardless of interleaving.
 *
 * Context window boundaries split sub-agent groups: messages before and
 * after a compaction are in fundamentally different contexts and belong
 * in separate groups.
 *
 * This function preserves object identity for unchanged display items when given
 * a previousItems array, allowing React's memo() to skip unnecessary re-renders.
 */
// Exposed for tests: grouping runs on every streaming flush over the whole
// history, so the number of messages it walks per call is the thing to bound.
let scannedMessages = 0

export function getGroupScanCountForTest(): number {
  return scannedMessages
}

export function resetGroupScanCountForTest(): void {
  scannedMessages = 0
}

export function groupMessages(messages: Message[], previousItems: DisplayItem[] = []): DisplayItem[] {
  // Create identity maps from previous items
  const previousItemsByMessageId = new Map<string, DisplayItem>()
  const previousItemsBySubAgentId = new Map<string, DisplayItem>()

  for (const item of previousItems) {
    if (item.type === 'message') {
      previousItemsByMessageId.set(item.message.id, item)
    } else if (item.type === 'subagent') {
      previousItemsBySubAgentId.set(item.subAgentId, item)
    }
  }

  const items: DisplayItem[] = []
  let lastContextWindowId: string | undefined
  let windowSequence = 1

  // Per-window sub-agent buckets: subAgentId → { subAgentType, messages }
  // Reset at each context window boundary so groups don't span compactions.
  let windowBuckets: Map<string, { subAgentType: string; messages: Message[] }> | null = null

  const flushWindowBuckets = () => {
    if (!windowBuckets || windowBuckets.size === 0) return

    // Buckets are created when a sub-agent's first message of the window is
    // reached, so map insertion order already is first-occurrence order. The
    // previous re-scan of the whole history on every flush made grouping
    // quadratic in the number of messages for interleaved sub-agent runs.
    for (const [subAgentId, bucket] of windowBuckets) {
      const previousItem = previousItemsBySubAgentId.get(subAgentId)
      const messagesMatch =
        previousItem?.type === 'subagent' &&
        previousItem.messages.length === bucket.messages.length &&
        previousItem.messages.every((m, j) => m === bucket.messages[j])

      if (messagesMatch) {
        items.push(previousItem)
      } else {
        items.push({
          type: 'subagent',
          subAgentId,
          subAgentType: bucket.subAgentType,
          messages: bucket.messages,
        })
      }
    }

    windowBuckets = null
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    scannedMessages++
    if (msg.role === 'tool') continue

    // Detect context window boundary
    if (msg.contextWindowId && lastContextWindowId && msg.contextWindowId !== lastContextWindowId) {
      flushWindowBuckets()
      windowSequence++
      items.push({ type: 'context-divider', windowSequence })
    }
    lastContextWindowId = msg.contextWindowId

    if (msg.subAgentId && msg.subAgentType) {
      // Collect into per-window bucket
      if (!windowBuckets) windowBuckets = new Map()
      let bucket = windowBuckets.get(msg.subAgentId)
      if (!bucket) {
        bucket = { subAgentType: msg.subAgentType, messages: [] }
        windowBuckets.set(msg.subAgentId, bucket)
      }
      bucket.messages.push(msg)
    } else {
      // Regular message — flush pending buckets first so groups appear
      // before the next non-sub-agent message
      flushWindowBuckets()

      const previousItem = previousItemsByMessageId.get(msg.id)
      if (previousItem?.type === 'message' && previousItem.message === msg) {
        items.push(previousItem)
      } else {
        items.push({ type: 'message', message: msg })
      }
    }
  }

  // Flush remaining buckets
  flushWindowBuckets()

  return items
}
