/**
 * Tool-call settling.
 *
 * A tool call is a question the provider expects an answer to. Whenever the
 * agent injects a user message outside the plain assistant → tool → assistant
 * flow — a continuation after an interrupted stream, the compaction prompt, a
 * drained queue message — an assistant turn whose calls were never answered can
 * end up directly followed by that user message. Providers reject the shape
 * rather than guess ("unconfirmed tool call, replay is refused", "tool output
 * cannot be followed by queued user messages"), and the turn dies on a 4xx.
 *
 * Rather than forbid those injections, close the question: every unanswered
 * call gets an explicit "interrupted" result, so the history is always a valid
 * conversation and the model is told plainly that the tool never ran.
 */

import type { RequestContextMessage } from './request-context.js'

/** LLM-facing marker — English only, like every other model-visible string. */
export const INTERRUPTED_TOOL_RESULT =
  'Tool call interrupted before it produced a result — treat it as never executed. Call the tool again if you still need it.'

export interface ToolCallSettlement {
  messages: RequestContextMessage[]
  settled: number
  /**
   * Ids that were answered synthetically. The repair lives in the request only
   * — the stored history stays unpaired — so callers need the ids to tell a NEW
   * break from the one they already reacted to.
   */
  settledCallIds: string[]
}

/**
 * Insert a synthetic result for every tool call left unanswered, immediately
 * after the results the call already collected. Returns the original array
 * (and `settled: 0`) when the history is already valid, which makes repeated
 * calls safe.
 */
export function settleUnpairedToolCalls(messages: RequestContextMessage[]): ToolCallSettlement {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) answered.add(message.toolCallId)
  }

  const settledMessages: RequestContextMessage[] = []
  const settledCallIds: string[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    settledMessages.push(message)
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue

    const missing = message.toolCalls.filter((call) => !answered.has(call.id))
    if (missing.length === 0) continue

    // Real results already recorded for this batch keep their place ahead of
    // the synthetic ones — only the gap is filled.
    while (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
      settledMessages.push(messages[++i]!)
    }
    for (const call of missing) {
      settledMessages.push({
        role: 'tool',
        content: INTERRUPTED_TOOL_RESULT,
        source: 'runtime',
        toolCallId: call.id,
      })
      settledCallIds.push(call.id)
    }
  }

  return settledCallIds.length > 0
    ? { messages: settledMessages, settled: settledCallIds.length, settledCallIds }
    : { messages, settled: 0, settledCallIds: [] }
}
