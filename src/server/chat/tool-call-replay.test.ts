import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '../../shared/types.js'
import { logger } from '../utils/logger.js'
import {
  cleanupDbLockFixtures,
  completion,
  createHotfixFixture,
  createRealToolRegistrySpy,
  createScriptedClient,
  pathExists,
  runHotfixTurn,
  type HotfixFixture,
} from './db-lock-test-fixtures.js'

afterEach(cleanupDbLockFixtures)

function writeCall(id: string, path: string): ToolCall {
  return { id, name: 'write_file', arguments: { path, content: 'effect ' + id } }
}

function storedToolCallId(event: { type: string; data: unknown }): string | undefined {
  return event.type === 'tool.call' ? (event.data as { toolCall: ToolCall }).toolCall.id : undefined
}

function storedToolResultId(event: { type: string; data: unknown }): string | undefined {
  return event.type === 'tool.result' ? (event.data as { toolCallId: string }).toolCallId : undefined
}

async function expectDuplicateBatchRejected(
  fixture: HotfixFixture,
  toolCalls: ToolCall[],
  replayId: string,
  effectPaths: string[],
): Promise<void> {
  const append = vi.spyOn(fixture.store, 'append')
  const { executeSpy } = await createRealToolRegistrySpy(fixture)
  const client = createScriptedClient([completion(toolCalls), completion([], 'finished')])
  const errorLog = vi.spyOn(logger, 'error')

  await runHotfixTurn(fixture, client)

  const appendedCalls = append.mock.calls.filter(
    ([, event]) => event.type === 'tool.call' && event.data.toolCall.id === replayId,
  )
  const chatError = fixture.store.getEvents(fixture.sessionId).find((event) => event.type === 'chat.error')
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
  expect.soft(executeSpy).toHaveBeenCalledTimes(0)
  for (const path of effectPaths) expect.soft(await pathExists(path)).toBe(false)
  expect.soft(appendedCalls).toHaveLength(0)
  expect.soft(client.calls()).toBe(1)
}

describe('tool call replay protection', () => {
  it('a call_id already resolved in the session is never executed again', async () => {
    const fixture = await createHotfixFixture()
    const effectPath = join(fixture.directory, 'resolved-effect.txt')
    const toolCall = writeCall('exec-X', effectPath)
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
    const seeded = fixture.store.getEvents(fixture.sessionId).filter((event) => storedToolCallId(event) === toolCall.id)
    expect(seeded).toHaveLength(1)

    await expectDuplicateBatchRejected(fixture, [toolCall], toolCall.id, [effectPath])

    const stored = fixture.store.getEvents(fixture.sessionId).filter((event) => storedToolCallId(event) === toolCall.id)
    expect.soft(stored).toHaveLength(1)
  })

  it('a call_id already called but never resolved is never executed again', async () => {
    const fixture = await createHotfixFixture()
    const effectPath = join(fixture.directory, 'unresolved-effect.txt')
    const toolCall = writeCall('exec-Z', effectPath)
    fixture.store.append(fixture.sessionId, {
      type: 'tool.call',
      data: { messageId: 'called-without-parent', toolCall },
    })
    const seeded = fixture.store.getEvents(fixture.sessionId)
    expect(seeded.filter((event) => storedToolCallId(event) === toolCall.id)).toHaveLength(1)
    expect(seeded.filter((event) => storedToolResultId(event) === toolCall.id)).toHaveLength(0)

    await expectDuplicateBatchRejected(fixture, [toolCall], toolCall.id, [effectPath])

    const stored = fixture.store.getEvents(fixture.sessionId).filter((event) => storedToolCallId(event) === toolCall.id)
    expect.soft(stored).toHaveLength(1)
  })

  it('a call_id recorded in the last snapshot is never executed again', async () => {
    const fixture = await createHotfixFixture()
    const effectPath = join(fixture.directory, 'snapshot-effect.txt')
    const toolCall = writeCall('exec-S', effectPath)
    fixture.store.append(fixture.sessionId, {
      type: 'message.start',
      data: { messageId: 'snapshot-assistant', role: 'assistant', content: '' },
    })
    fixture.store.append(fixture.sessionId, {
      type: 'tool.call',
      data: { messageId: 'snapshot-assistant', toolCall },
    })
    expect(fixture.store.consolidateSession(fixture.sessionId)).not.toBeNull()
    const before = fixture.store.getEventsSinceSnapshot(fixture.sessionId)
    const snapshotCalls = before.snapshot?.messages.flatMap((message) => message.toolCalls ?? []) ?? []
    expect(snapshotCalls.filter((call) => call.id === toolCall.id)).toHaveLength(1)
    expect(before.events.filter((event) => storedToolCallId(event) === toolCall.id)).toHaveLength(0)

    await expectDuplicateBatchRejected(fixture, [toolCall], toolCall.id, [effectPath])

    const after = fixture.store.getEventsSinceSnapshot(fixture.sessionId)
    const retainedCalls = after.snapshot?.messages.flatMap((message) => message.toolCalls ?? []) ?? []
    expect.soft(retainedCalls.filter((call) => call.id === toolCall.id)).toHaveLength(1)
  })

  it('a model response repeating the same call_id is refused before any execution', async () => {
    const fixture = await createHotfixFixture()
    const firstPath = join(fixture.directory, 'duplicate-batch-first.txt')
    const secondPath = join(fixture.directory, 'duplicate-batch-second.txt')
    const first = writeCall('exec-D', firstPath)
    const second = writeCall('exec-D', secondPath)

    await expectDuplicateBatchRejected(fixture, [first, second], first.id, [firstPath, secondPath])

    const stored = fixture.store.getEvents(fixture.sessionId).filter((event) => storedToolCallId(event) === first.id)
    expect.soft(stored).toHaveLength(0)
  })
})
