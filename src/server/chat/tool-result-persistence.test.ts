import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LLMCompletionRequest, LLMMessage, LLMStreamEvent } from '../llm/types.js'
import type { Tool } from '../tools/types.js'
import {
  appendUserMessage,
  cleanupDbLockFixtures,
  completion,
  createHotfixFixture,
  createRealToolRegistrySpy,
  findBusyAppendThrow,
  holdWriteLockInAnotherProcess,
  observeBusyAppend,
  runHotfixTurn,
  type ControlledWriteLock,
} from './db-lock-test-fixtures.js'

const UNKNOWN_TOOL_RESULT =
  'Tool result is unknown because execution was interrupted after the tool may have produced external effects. Do not retry automatically.'

afterEach(cleanupDbLockFixtures)

describe('tool result persistence', () => {
  it('a tool result that cannot be persisted after its effect stops the turn and the next request stays valid', async () => {
    const fixture = await createHotfixFixture(100)
    appendUserMessage(fixture, 'Run the effect once.')
    const effectPath = join(fixture.directory, 'effect-after-tool.txt')
    let effectCount = 0
    let lock: ControlledWriteLock | undefined
    let appendsAtLock = 0
    let appendCallCount = () => 0
    const tool: Tool = {
      name: 'persistence_effect',
      mcpServer: 'test',
      definition: {
        type: 'function',
        function: {
          name: 'persistence_effect',
          description: 'Produce one observable test effect',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async () => {
        effectCount += 1
        await writeFile(effectPath, String(effectCount))
        lock = await holdWriteLockInAnotherProcess(fixture.dbPath)
        appendsAtLock = appendCallCount()
        return { success: true, output: 'effect complete', durationMs: 1, truncated: false }
      },
    }
    const { setMcpTools } = await import('../tools/index.js')
    setMcpTools([tool])
    const { executeSpy } = await createRealToolRegistrySpy(fixture)
    const busy = observeBusyAppend(fixture.store, 'tool.result', () => lock)
    appendCallCount = () => busy.spy.mock.calls.length

    const requests = new Map<number, LLMMessage[][]>([
      [1, []],
      [2, []],
    ])
    let turn = 1
    let firstTurnCalls = 0
    const client = {
      complete: async () => completion([]),
      getModel: () => 'scripted-model',
      getProfile: () => ({}) as never,
      getBackend: () => 'unknown' as const,
      setBackend: () => {},
      setModel: () => {},
      stream: async function* (request: LLMCompletionRequest): AsyncGenerator<LLMStreamEvent> {
        requests.get(turn)!.push(request.messages.map((message) => structuredClone(message)))
        if (turn === 1) {
          firstTurnCalls += 1
          if (firstTurnCalls === 1) {
            const response = completion([{ id: 'exec-Y', name: tool.name, arguments: {} }])
            yield { type: 'tool_call_delta', index: 0, id: 'exec-Y', name: tool.name }
            yield { type: 'tool_call_delta', index: 0, arguments: '{}' }
            yield { type: 'done', response }
            return
          }
          if (lock) expect(await lock.exited).toBe(0)
          const response = completion([], 'unexpected follow-up')
          yield { type: 'text_delta', content: response.content }
          yield { type: 'done', response }
          return
        }
        const response = completion([], 'next turn is valid')
        yield { type: 'text_delta', content: response.content }
        yield { type: 'done', response }
      },
      calls: () => [...requests.values()].reduce((total, turnRequests) => total + turnRequests.length, 0),
    }

    await runHotfixTurn(fixture, client as never)
    expect(lock).toBeDefined()
    expect(await lock!.exited).toBe(0)

    const failedAppends = busy.spy.mock.results.filter(
      (result) => result.type === 'throw' && result.value?.code === 'EVENT_STORE_BUSY_TIMEOUT',
    )
    expect(failedAppends).toHaveLength(1)
    const failedResult = findBusyAppendThrow(busy, 'tool.result')
    expect(failedResult).toBeDefined()
    expect(failedResult?.event.type).toBe('tool.result')
    if (failedResult?.event.type !== 'tool.result') throw new Error('unexpected failed event')
    expect(failedResult.event.data.toolCallId).toBe('exec-Y')
    expect(failedResult.error.code).toBe('EVENT_STORE_BUSY_TIMEOUT')

    const firstTurnEvents = busy.spy.mock.calls.map(([, event]) => event)
    const toolCallIndex = firstTurnEvents.findIndex(
      (event) => event.type === 'tool.call' && event.data.toolCall.id === 'exec-Y',
    )
    expect(toolCallIndex).toBeGreaterThanOrEqual(0)
    const toolCallEvent = firstTurnEvents[toolCallIndex]!
    if (toolCallEvent.type !== 'tool.call') throw new Error('tool call missing')
    const messageStartIndex = firstTurnEvents.findIndex(
      (event) => event.type === 'message.start' && event.data.messageId === toolCallEvent.data.messageId,
    )
    expect(messageStartIndex).toBeGreaterThanOrEqual(0)
    expect(messageStartIndex).toBeLessThan(appendsAtLock)
    expect(toolCallIndex).toBeLessThan(appendsAtLock)
    expect(failedResult.callIndex).toBeGreaterThanOrEqual(appendsAtLock)
    expect(busy.spy.mock.results[messageStartIndex]?.type).toBe('return')
    expect(busy.spy.mock.results[toolCallIndex]?.type).toBe('return')
    expect(busy.spy.mock.results[failedResult.callIndex]?.type).toBe('throw')
    expect(firstTurnEvents.filter((event) => event.type === 'tool.output')).toHaveLength(0)
    expect(
      fixture.store
        .getEvents(fixture.sessionId)
        .filter(
          (event) => event.type === 'tool.result' && (event.data as { toolCallId: string }).toolCallId === 'exec-Y',
        ),
    ).toHaveLength(0)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(effectCount).toBe(1)
    expect(await readFile(effectPath, 'utf8')).toBe('1')

    const chatErrorIndex = firstTurnEvents.findIndex((event) => event.type === 'chat.error')
    const runningFalseIndex = firstTurnEvents.findIndex(
      (event) => event.type === 'running.changed' && event.data.isRunning === false,
    )
    const secondAssistantStarts = firstTurnEvents
      .slice(failedResult.callIndex + 1)
      .filter((event) => event.type === 'message.start' && event.data.role === 'assistant')

    turn = 2
    appendUserMessage(fixture, 'Continue without repeating the effect.')
    await runHotfixTurn(fixture, client as never)

    const secondRequest = requests.get(2)![0]!
    const calls = secondRequest.flatMap((message) => message.toolCalls ?? [])
    const outputs = secondRequest.filter(
      (message): message is LLMMessage & { toolCallId: string } =>
        message.role === 'tool' && message.toolCallId !== undefined,
    )
    const callIds = new Set(calls.map((call) => call.id))
    const matchingOutputs = outputs.filter((message) => message.toolCallId === 'exec-Y')
    const execAssistantIndexes = secondRequest.flatMap((message, index) =>
      message.toolCalls?.some((call) => call.id === 'exec-Y') ? [index] : [],
    )
    const execAssistantIndex = execAssistantIndexes[0] ?? -1
    const execAssistant = secondRequest[execAssistantIndex]
    const contiguousTool = secondRequest[execAssistantIndex + 1]
    const appendedExecY = busy.spy.mock.calls.filter(
      ([, event]) => event.type === 'tool.call' && event.data.toolCall.id === 'exec-Y',
    )

    expect.soft(firstTurnCalls).toBe(1)
    expect.soft(chatErrorIndex).toBeGreaterThanOrEqual(0)
    expect.soft(runningFalseIndex).toBeGreaterThan(chatErrorIndex)
    expect.soft(secondAssistantStarts).toEqual([])
    expect.soft(outputs).toHaveLength(calls.length)
    expect.soft(outputs.every((message) => callIds.has(message.toolCallId))).toBe(true)
    expect
      .soft(calls.every((call) => outputs.filter((message) => message.toolCallId === call.id).length === 1))
      .toBe(true)
    expect.soft(execAssistantIndexes).toHaveLength(1)
    expect.soft(execAssistant?.role).toBe('assistant')
    expect.soft(execAssistant?.toolCalls).toHaveLength(1)
    expect.soft(execAssistant?.toolCalls?.[0]?.id).toBe('exec-Y')
    expect.soft(contiguousTool).toMatchObject({
      role: 'tool',
      toolCallId: 'exec-Y',
      content: UNKNOWN_TOOL_RESULT,
    })
    expect.soft(matchingOutputs).toHaveLength(1)
    expect.soft(matchingOutputs[0]?.content).toBe(UNKNOWN_TOOL_RESULT)
    expect.soft(executeSpy).toHaveBeenCalledTimes(1)
    expect.soft(effectCount).toBe(1)
    expect.soft(appendedExecY).toHaveLength(1)
    expect.soft(client.calls()).toBe(firstTurnCalls + 1)
  })
})
