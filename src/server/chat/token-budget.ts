import type { RequestContextMessage } from './request-context.js'

/** Rough token estimate: ~4 chars per token, matching the tool-definition estimate in mcp/manager.ts. */
export const CHARS_PER_TOKEN = 4

/** JSON framing overhead per tool message (role, tool_call_id, content key). */
export const TOOL_MESSAGE_OVERHEAD_TOKENS = 16

export function estimateToolResultTokens(toolMessages: Array<Pick<RequestContextMessage, 'content'>>): number {
  return toolMessages.reduce(
    (sum, message) => sum + TOOL_MESSAGE_OVERHEAD_TOKENS + Math.ceil(message.content.length / CHARS_PER_TOKEN),
    0,
  )
}

/**
 * Local estimate of the conversation size, used only when the provider does
 * not report prompt usage (e.g. a wrapper that strips `usage`). Without it
 * the recorded context size stays at 0 and auto-compaction never fires, so
 * the full history keeps being sent after compactions.
 *
 * Counts everything that ends up on the wire — content, thinking, tool-call
 * names and arguments — not just message content: on a real tool-heavy
 * history, tool calls and thinking account for roughly half of the request
 * body, and a content-only estimate lands just under the compaction
 * threshold (measured on session 450/0fd8a855: 220k estimated vs ~291k
 * reported by the provider for the same body). The estimate deliberately
 * errs on the high side: underestimating reproduces the unbounded-growth
 * incident, overestimating only compacts slightly early.
 */
export function estimateConversationTokens(
  messages: Array<Pick<RequestContextMessage, 'content' | 'thinkingContent' | 'toolCalls' | 'toolCallId'>>,
): number {
  let chars = 0
  for (const message of messages) {
    chars += message.content.length
    if (message.thinkingContent) chars += message.thinkingContent.length
    if (message.toolCallId) chars += message.toolCallId.length
    for (const toolCall of message.toolCalls ?? []) {
      chars += toolCall.id.length + toolCall.name.length + JSON.stringify(toolCall.arguments).length
    }
  }
  return messages.length * TOOL_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN)
}

const CONTEXT_LENGTH_ERROR_PATTERN = /context\s*length|context_length|context window|prompt (?:is )?too long/i

export function isContextLengthError(message: string | undefined): boolean {
  if (!message) return false
  return CONTEXT_LENGTH_ERROR_PATTERN.test(message)
}

const INPUT_OVERFLOW_ERROR_PATTERN =
  /cold_replay_context_exceeded|input_tokens=\d+|your messages resulted in|prompt (?:is )?too long/i

/**
 * The prompt ALONE exceeds the model window: reducing maxTokens cannot help,
 * so the maxTokens/2 retry loop must not run. The caller compacts or fails
 * visibly instead.
 */
export function isInputOverflowError(message: string | undefined): boolean {
  if (!message) return false
  return INPUT_OVERFLOW_ERROR_PATTERN.test(message)
}
