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

const CONTEXT_LENGTH_ERROR_PATTERN = /context\s*length|context_length|context window|prompt (?:is )?too long/i

export function isContextLengthError(message: string | undefined): boolean {
  if (!message) return false
  return CONTEXT_LENGTH_ERROR_PATTERN.test(message)
}

const NON_RETRYABLE_RESPONSES_ERROR_PATTERN = /\bno_actionable_output\b/

/** Whether retrying the same LLM request cannot make progress. */
export function isNonRetryableLLMError(message: string | undefined): boolean {
  if (!message) return false
  return NON_RETRYABLE_RESPONSES_ERROR_PATTERN.test(message)
}
