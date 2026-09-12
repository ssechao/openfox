import type { RequestContextMessage } from './request-context.js'

/** Rough token estimate: ~4 chars per token, matching the tool-definition estimate in mcp/manager.ts. */
export const CHARS_PER_TOKEN = 4

/** JSON framing overhead per tool message (role, tool_call_id, content key). */
export const TOOL_MESSAGE_OVERHEAD_TOKENS = 16

/**
 * Cheap size estimate for a batch of messages — a freshly executed tool batch
 * or a whole history. Only ever used to decide whether something must shrink,
 * so a coarse over-estimate is the safe direction.
 */
export function estimateMessagesTokens(messages: Array<Pick<RequestContextMessage, 'content'>>): number {
  return messages.reduce(
    (sum, message) => sum + TOOL_MESSAGE_OVERHEAD_TOKENS + Math.ceil(message.content.length / CHARS_PER_TOKEN),
    0,
  )
}

export function estimatePromptTokensForSafety(systemPrompt: string, messages: unknown[], tools: unknown[]): number {
  return Buffer.byteLength(systemPrompt + JSON.stringify(messages) + JSON.stringify(tools), 'utf8')
}

/** The context gauge as reported by the session, plus whether it is a real measurement. */
export interface ContextGauge {
  currentTokens: number
  currentTokensKnown?: boolean
}

/**
 * Tokens the NEXT request will carry.
 *
 * `currentTokens` is the last measurement reported by the provider, so anything
 * appended since (typically a tool result) is invisible to it. Deciding on the
 * raw gauge lets a single large tool result push the request past the window
 * before compaction ever fires — the unmeasured delta MUST be added back.
 *
 * When no measurement exists at all, the caller's local estimate of the
 * assembled request is the only usable number.
 */
export function effectiveContextTokens(
  gauge: ContextGauge,
  unmeasuredTokens: number,
  estimateAssembledRequest: () => number,
): number {
  if (gauge.currentTokensKnown === false) return estimateAssembledRequest()
  return gauge.currentTokens + unmeasuredTokens
}

/**
 * Providers phrase a context overflow in incompatible ways: OpenAI talks about
 * the "maximum context length", Anthropic about "input length and max_tokens",
 * llama.cpp/ollama about the "available context size". Every variant means the
 * same thing — the INPUT no longer fits, and only compaction can fix it.
 */
const CONTEXT_LENGTH_ERROR_PATTERN = /context\s*length|context_length|context window|prompt (?:is )?too long/i

/**
 * Phrases that only mean an overflow when something says so. "context size"
 * also names a load-time setting and "input length" appears in plain validation
 * errors; matching them bare would force a pointless auto-compaction (an extra
 * LLM call plus a history rewrite) on an unrelated failure.
 */
const QUALIFIED_CONTEXT_NOUN = /context limit|context size|input (?:length|token count)/i
const OVERFLOW_QUALIFIER = /exceed(?:s|ed|ing)?\b|too (?:long|large|big|many)|does(?:n't| not) fit/i

export function isContextLengthError(message: string | undefined): boolean {
  if (!message) return false
  if (CONTEXT_LENGTH_ERROR_PATTERN.test(message)) return true
  return QUALIFIED_CONTEXT_NOUN.test(message) && OVERFLOW_QUALIFIER.test(message)
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
  return NON_RETRYABLE_RESPONSES_ERROR_PATTERN.test(message)
}
