import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCall } from '../../shared/types.js'
import {
  appendUserMessage,
  cleanupDbLockFixtures,
  completion,
  createHotfixFixture,
  createRealToolRegistrySpy,
  createScriptedClient,
  findBusyAppendThrow,
  holdWriteLockInAnotherProcess,
  observeBusyAppend,
  pathExists,
  runHotfixTurn,
  type ControlledWriteLock,
} from './db-lock-test-fixtures.js'

afterEach(cleanupDbLockFixtures)

describe('turn event persistence', () => {
  it.fails('a turn stops with an explicit error when a turn event cannot be persisted', async () => {
    const fixture = await createHotfixFixture(100)
    appendUserMessage(fixture, 'Write the result.')
    const outputPath = join(fixture.directory, 'effect.txt')
    const toolCall: ToolCall = {
      id: 'exec-lock',
      name: 'write_file',
      arguments: { path: outputPath, content: 'executed' },
    }
    let lock: ControlledWriteLock | undefined
    const client = createScriptedClient([completion([toolCall]), completion([], 'finished')], async (call) => {
      if (call === 0) lock = await holdWriteLockInAnotherProcess(fixture.dbPath)
    })
    const { executeSpy } = await createRealToolRegistrySpy(fixture)
    const busy = observeBusyAppend(fixture.store, 'message.start', () => lock)

    await runHotfixTurn(fixture, client)
    expect(lock).toBeDefined()
    expect(await lock!.exited).toBe(0)

    const failedStart = findBusyAppendThrow(busy, 'message.start')
    expect(failedStart).toBeDefined()
    expect(failedStart?.event.type).toBe('message.start')
    if (failedStart?.event.type !== 'message.start') throw new Error('assistant message.start did not fail')
    expect(failedStart.event.data.role).toBe('assistant')
    expect(failedStart.error.code).toBe('EVENT_STORE_BUSY_TIMEOUT')
    const failedOrder = busy.spy.mock.invocationCallOrder[failedStart!.callIndex]!
    const executionOrder = executeSpy.mock.invocationCallOrder[0]
    expect(executionOrder === undefined || failedOrder < executionOrder).toBe(true)

    const appendedEvents = busy.spy.mock.calls.map(([, event]) => event)
    const chatErrorIndex = appendedEvents.findIndex((event) => event.type === 'chat.error')
    const runningFalseIndex = appendedEvents.findIndex(
      (event) => event.type === 'running.changed' && event.data.isRunning === false,
    )
    const secondAssistantStarts = appendedEvents
      .slice(failedStart!.callIndex + 1)
      .filter((event) => event.type === 'message.start' && event.data.role === 'assistant')
    const storedEvents = fixture.store.getEvents(fixture.sessionId)
    const messageIds = new Set(
      storedEvents
        .filter((event) => event.type === 'message.start')
        .map((event) => (event.data as { messageId: string }).messageId),
    )
    const orphaned = storedEvents.filter(
      (event) =>
        (event.type === 'tool.call' || event.type === 'tool.result') &&
        !messageIds.has((event.data as { messageId: string }).messageId),
    )

    expect.soft(executeSpy).toHaveBeenCalledTimes(0)
    expect.soft(await pathExists(outputPath)).toBe(false)
    expect.soft(client.calls()).toBe(1)
    expect.soft(chatErrorIndex).toBeGreaterThanOrEqual(0)
    expect.soft(runningFalseIndex).toBeGreaterThan(chatErrorIndex)
    expect.soft(secondAssistantStarts).toEqual([])
    expect.soft(orphaned).toEqual([])
  })
})
