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

/**
 * Whether an LLM error is a NON-transient HTTP status (400/404/409) — i.e.
 * retrying the identical request cannot succeed. The error text is the
 * `HTTP <status>: <body>` string surfaced by the HTTP client. Transient errors
 * (network failures, 429 rate limits, 5xx) are NOT matched and keep the
 * existing backoff retry policy.
 *
 * 401/403 are deliberately EXCLUDED: OAuth-style auth adapters legitimately
 * return them on an expired token, and it is the retry that lets the refreshed
 * credentials through.
 */
const NON_TRANSIENT_HTTP_PATTERN = /HTTP (?:400|404|409)(?!\d)/

/**
 * A 400 that only refuses server-side conversation storage is recoverable: the
 * LLM client disables chaining on it and the retry goes out as a plain
 * full-history request. Mirrors RESPONSES_STORE_REJECTION in llm/client.ts.
 */
const RECOVERABLE_STORE_REJECTION =
  /(zero data retention|\bzdr\b|previous_response_id|['"`]?store['"`]?\s*(is|must|not|cannot|unsupported))/i

export function isNonTransientHttpError(message: string | undefined): boolean {
  if (!message) return false
  if (RECOVERABLE_STORE_REJECTION.test(message)) return false
  return NON_TRANSIENT_HTTP_PATTERN.test(message)
}

const NON_RETRYABLE_RESPONSES_ERROR_PATTERN = /\bno_actionable_output\b/

/** Whether retrying the same LLM request cannot make progress. */
export function isNonRetryableLLMError(message: string | undefined): boolean {
  if (!message) return false
  return isNonTransientHttpError(message) || NON_RETRYABLE_RESPONSES_ERROR_PATTERN.test(message)
}
