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
 */
export function estimateConversationTokens(messages: Array<Pick<RequestContextMessage, 'content'>>): number {
  return estimateToolResultTokens(messages)
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
