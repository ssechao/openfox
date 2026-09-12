/**
 * Last-resort history shrinking.
 *
 * Compaction is the normal way to free context, but compaction itself is an LLM
 * request built on the very history the model just refused. When that request
 * does not fit, resending it verbatim can only fail again — the summary input
 * has to get smaller first.
 *
 * Only RAW TOOL RESULTS are touched, oldest first: they are bulky, largely
 * redundant once summarized, and — unlike user or assistant turns — losing
 * their tail does not erase intent or decisions. The freshest messages are
 * protected so the current turn and the trailing prompt always survive intact.
 */

import type { RequestContextMessage } from './request-context.js'
import { CHARS_PER_TOKEN, estimateMessagesTokens } from './token-budget.js'

/** Head of a truncated tool result kept verbatim, in characters. */
export const TOOL_RESULT_KEEP_CHARS = 2_000

/** Below this size a tool result cannot free enough to be worth mangling. */
export const MIN_REDUCIBLE_TOOL_RESULT_CHARS = TOOL_RESULT_KEEP_CHARS * 2

/** Messages at the end of the history kept intact while anything older can be freed. */
export const PROTECTED_TAIL_MESSAGES = 2

/** LLM-facing marker — English only, like every other model-visible string. */
export const TRUNCATED_TOOL_RESULT_MARKER = '[tool result truncated to fit the context window]'

export interface HistoryReduction {
  messages: RequestContextMessage[]
  changed: boolean
  /** Number of tool results truncated — for logging, so the rescue is traceable. */
  truncated: number
}

function truncateToolResult(content: string): string {
  const dropped = content.length - TOOL_RESULT_KEEP_CHARS
  return `${content.slice(0, TOOL_RESULT_KEEP_CHARS)}\n\n${TRUNCATED_TOOL_RESULT_MARKER} (${dropped} characters dropped)`
}

/**
 * Shrink `messages` until the estimate fits `targetTokens`, or until nothing
 * reducible is left. Returns the original array (and `changed: false`) when it
 * already fits or cannot be reduced further, which makes repeated calls safe.
 */
export function reduceHistoryForWindow(messages: RequestContextMessage[], targetTokens: number): HistoryReduction {
  let estimate = estimateMessagesTokens(messages)
  if (estimate <= targetTokens) return { messages, changed: false, truncated: 0 }

  let reduced: RequestContextMessage[] | undefined
  let truncated = 0

  const truncateUpTo = (until: number): void => {
    for (let i = 0; i < until && estimate > targetTokens; i++) {
      const message = (reduced ?? messages)[i]!
      if (message.role !== 'tool') continue
      if (message.content.length < MIN_REDUCIBLE_TOOL_RESULT_CHARS) continue

      const content = truncateToolResult(message.content)
      if (content.length >= message.content.length) continue

      estimate -= Math.ceil(message.content.length / CHARS_PER_TOKEN) - Math.ceil(content.length / CHARS_PER_TOKEN)
      reduced ??= [...messages]
      reduced[i] = { ...message, content }
      truncated += 1
    }
  }

  // Oldest first: those results are the least likely to matter to the turn in
  // flight, so they are spent before the freshest ones.
  truncateUpTo(messages.length - PROTECTED_TAIL_MESSAGES)
  // Last resort. The canonical overflow is "a huge result just landed, then a
  // prompt was appended", which puts the offender INSIDE the protected tail —
  // keeping the tail exempt would dead-end the rescue on the one shape it
  // exists for. Non-tool messages are never rewritten, so the trailing prompt
  // stays intact either way.
  if (estimate > targetTokens) truncateUpTo(messages.length)

  return reduced ? { messages: reduced, changed: true, truncated } : { messages, changed: false, truncated: 0 }
}
