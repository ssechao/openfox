import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '../../shared/types.js'
import { logger } from '../utils/logger.js'
import {
  completion,
  createHotfixFixture,
  createScriptedClient,
  pathExists,
  runHotfixTurn,
} from './turn-persistence.test.js'

describe('tool call replay protection', () => {
  it.fails('a call_id already resolved in the session is never executed again', async () => {
    const fixture = await createHotfixFixture()
    const outputPath = join(fixture.directory, 'duplicate-effect.txt')
    const toolCall: ToolCall = {
      id: 'exec-X',
      name: 'write_file',
      arguments: { path: outputPath, content: 'executed twice' },
    }
    fixture.store.append(fixture.sessionId, {
      type: 'tool.call',
      data: { messageId: 'resolved-without-parent', toolCall },
    })
    fixture.store.append(fixture.sessionId, {
      type: 'tool.result',
      data: {
        messageId: 'resolved-without-parent',
        toolCallId: toolCall.id,
        result: { success: true, output: 'already executed', durationMs: 1, truncated: false },
      },
    })
    const append = vi.spyOn(fixture.store, 'append')
    const client = createScriptedClient([completion([toolCall]), completion([], 'finished')])
    const errorLog = vi.spyOn(logger, 'error')

    await runHotfixTurn(fixture, client)

    const events = fixture.store.getEvents(fixture.sessionId)
    const matchingCalls = append.mock.calls.filter(
      ([, event]) => event.type === 'tool.call' && event.data.toolCall.id === toolCall.id,
    )
    const chatError = events.find((event) => event.type === 'chat.error')
    const loggedTurnError = errorLog.mock.calls.find(([message]) => message === 'Chat turn error')?.[1] as
      { error?: Error & { code?: string } } | undefined
    const internalError = loggedTurnError?.error

    expect.soft(internalError).toBeInstanceOf(Error)
    expect.soft(internalError?.constructor.name).toBe('DuplicateToolCallIdError')
    expect.soft(internalError?.code).toBe('DUPLICATE_TOOL_CALL_ID')
    expect.soft(internalError?.message).toEqual(expect.stringMatching(/^DUPLICATE_TOOL_CALL_ID:/))
    expect
      .soft((chatError?.data as { error?: string } | undefined)?.error)
      .toEqual(expect.stringMatching(/^DUPLICATE_TOOL_CALL_ID:/))
    expect.soft(await pathExists(outputPath)).toBe(false)
    expect.soft(matchingCalls).toHaveLength(1)
    expect.soft(client.calls()).toBe(1)
  })
})
