/**
 * Tool streaming utilities
 *
 * Handles conversion of tool onProgress callbacks to tool.output events.
 * Used for streaming shell command output to the client in real-time.
 */

import type { TurnEvent } from '../events/types.js'
import { logger } from '../utils/logger.js'

export interface ParsedProgress {
  stream: 'stdout' | 'stderr'
  content: string
}

export const MAX_PERSISTED_TOOL_OUTPUT_BYTES = 256 * 1024
export const TOOL_OUTPUT_TRUNCATED_MESSAGE = '\n[Streaming output truncated after 256 KiB]\n'

function utf8Prefix(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content)
  if (bytes.length <= maxBytes) return content
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = maxBytes; end > Math.max(0, maxBytes - 4); end--) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      continue
    }
  }
  return ''
}

/**
 * Parse a progress message from the shell tool.
 * Shell tool emits messages in format: "[stdout] content" or "[stderr] content"
 *
 * @returns Parsed progress or null if format doesn't match
 */
export function parseProgressMessage(message: string): ParsedProgress | null {
  const match = message.match(/^\[(stdout|stderr)\] (.*)$/s)
  if (!match) return null

  return {
    stream: match[1] as 'stdout' | 'stderr',
    content: match[2]!,
  }
}

/**
 * Create an onProgress handler that emits tool.output events.
 *
 * @param append - Function to append events (e.g., eventStore.append(sessionId, event))
 * @param messageId - The assistant message ID this tool call belongs to
 * @param callId - The tool call ID
 * @param sessionId - The session ID
 * @returns Progress handler function to pass to tool context
 */
export function createToolProgressHandler(
  append: (event: TurnEvent) => void,
  messageId: string,
  callId: string,
  _sessionId: string,
): (message: string) => void {
  let persistedBytes = 0
  let truncated = false
  return (message: string) => {
    const parsed = parseProgressMessage(message)
    if (!parsed || truncated) return

    const remainingBytes = MAX_PERSISTED_TOOL_OUTPUT_BYTES - persistedBytes
    const contentBytes = Buffer.byteLength(parsed.content)
    const content = contentBytes <= remainingBytes ? parsed.content : utf8Prefix(parsed.content, remainingBytes)

    try {
      if (content.length > 0) {
        append({
          type: 'tool.output',
          data: { messageId, toolCallId: callId, stream: parsed.stream, content },
        })
        persistedBytes += Buffer.byteLength(content)
      }
      if (contentBytes > remainingBytes) {
        append({
          type: 'tool.output',
          data: {
            messageId,
            toolCallId: callId,
            stream: parsed.stream,
            content: TOOL_OUTPUT_TRUNCATED_MESSAGE,
          },
        })
        truncated = true
      }
    } catch (error) {
      logger.warn('Dropped streamed tool output', {
        toolCallId: callId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
