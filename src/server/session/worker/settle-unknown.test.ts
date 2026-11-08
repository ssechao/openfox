import { describe, expect, it, vi } from 'vitest'
import type { StoredEvent, TurnEvent } from '../../events/types.js'
import { foldPendingToolReconciliations } from '../../events/fold-state.js'
import { buildContextMessagesFromStoredEvents } from '../../events/fold-messages.js'
import { prepareSessionInterruptionEvents } from './crash.js'
import { runBootAutoContinuations, type BootAutoContinueDeps } from '../auto-continue.js'
import { executeTools } from '../../chat/execute-tools.js'
import { attachToolResultToMessage } from '../../events/apply-events.js'
import { sessionResumeAllowed, settleOneUnknownToolOutcome, syntheticUnknownToolResult } from './settle-unknown.js'
import type { ToolCall } from '../../../shared/types.js'
import type { ToolRegistry } from '../../tools/types.js'
import type { TurnMetrics } from '../../chat/stream-pure.js'

vi.mock('../../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(),
  findAgentById: vi.fn(),
}))

vi.mock('../../db/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/settings.js')>()
  return {
    ...actual,
    getSetting: (key: string) => (key === actual.SETTINGS_KEYS.DISPLAY_LOCALE ? 'fr' : 'false'),
  }
})

function stored(seq: number, type: string, data: unknown, timestamp = seq): StoredEvent {
  return { seq, timestamp, sessionId: 's-1', type, data } as StoredEvent
}

function memoryStore(initial: StoredEvent[]) {
  const events = [...initial]
  return {
    events,
    invalidateExternalSession: () => {},
    getEvents: () => events,
    append: (_sessionId: string, event: TurnEvent) => {
      const row = stored(events.length + 1, event.type, event.data, 1_000 + events.length)
      events.push(row)
      return row
    },
  }
}

const openCall = [
  stored(1, 'running.changed', { isRunning: true }, 1),
  stored(2, 'message.start', { messageId: 'a1', role: 'assistant' }, 2),
  stored(
    3,
    'tool.call',
    {
      messageId: 'a1',
      toolCall: { id: 'call-1', name: 'run_command', arguments: { command: 'printf x' } },
    },
    3,
  ),
]

describe('automatic unknown tool outcomes', () => {
  it('persists one correlated outcomeUnknown result and leaves no pending reconciliation', () => {
    const store = memoryStore(openCall)
    const after = prepareSessionInterruptionEvents(store, 's-1')

    const results = after.filter((event) => event.type === 'tool.result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({
      messageId: 'a1',
      toolCallId: 'call-1',
      result: { success: false, outcomeUnknown: true },
    })
    expect(after.some((event) => event.type === 'tool.reconciliation_required')).toBe(false)
    expect(foldPendingToolReconciliations(after)).toEqual([])

    const again = prepareSessionInterruptionEvents(store, 's-1')
    expect(again.filter((event) => event.type === 'tool.result')).toHaveLength(1)

    store.append('s-1', {
      type: 'tool.result',
      data: {
        messageId: 'a1',
        toolCallId: 'call-1',
        result: { success: true, output: 'late', durationMs: 1, truncated: false },
      },
    })
    const folded = buildContextMessagesFromStoredEvents(store.events)
    expect(folded.filter((message) => message.role === 'tool')).toHaveLength(1)
    expect(folded.find((message) => message.role === 'tool')?.content).toContain('Do not retry this call automatically')
    expect(foldPendingToolReconciliations(store.events)).toEqual([])

    const attached = {
      toolCalls: [
        {
          id: 'call-1',
          name: 'run_command',
          arguments: { command: 'printf x' },
          result: syntheticUnknownToolResult(),
        },
      ],
    }
    attachToolResultToMessage(attached, 'call-1', {
      success: true,
      output: 'late',
      durationMs: 1,
      truncated: false,
    })
    expect(attached.toolCalls).toHaveLength(1)
    expect(attached.toolCalls[0]?.result).toMatchObject({ success: false, outcomeUnknown: true })
  })

  it('auto-continues an old pending reconciliation without a user decision', () => {
    const queued: string[] = []
    const appended: TurnEvent[] = []
    const deps: BootAutoContinueDeps = {
      getEvents: () => [
        stored(1, 'message.start', { messageId: 'u1', role: 'user' }),
        stored(2, 'message.start', { messageId: 'a1', role: 'assistant' }),
        stored(3, 'tool.reconciliation_required', {
          messageId: 'a1',
          toolCallId: 'tool-1',
          name: 'run_command',
          arguments: { command: 'side-effect' },
        }),
      ],
      hasActiveWorkflow: () => false,
      appendEvent: (_sessionId, event) => appended.push(event),
      queueMessage: (sessionId) => queued.push(sessionId),
    }

    expect(runBootAutoContinuations(['s-1'], deps)).toBe(1)
    expect(queued).toEqual(['s-1'])
    expect(appended.some((event) => event.type === 'tool.reconciliation_required')).toBe(false)
    expect(appended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.result',
          data: expect.objectContaining({
            toolCallId: 'tool-1',
            result: expect.objectContaining({ success: false, outcomeUnknown: true }),
          }),
        }),
        expect.objectContaining({
          type: 'tool.reconciliation_resolved',
          data: { toolCallId: 'tool-1' },
        }),
      ]),
    )
  })

  it('does not block a new effectful tool while a stale reconciliation list is still passed', async () => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      output: 'ran',
      durationMs: 1,
      truncated: false,
    })
    const registry = { tools: [], execute, definitions: [] } as unknown as ToolRegistry
    const append = vi.fn()
    const result = await executeTools(
      'msg-1',
      [{ id: 'call-1', name: 'run_command', arguments: { command: 'touch x' } } satisfies ToolCall],
      {
        toolRegistry: registry,
        sessionManager: {
          getLspManager: vi.fn(),
          getEffectiveWorkdir: vi.fn().mockReturnValue('/test'),
          getProjectWorkdir: vi.fn().mockReturnValue('/test'),
        } as never,
        sessionId: 'test-session',
        workdir: '/test',
        turnMetrics: { addToolTime: vi.fn() } as unknown as TurnMetrics,
        pendingToolReconciliations: [
          {
            messageId: 'old-message',
            toolCallId: 'unknown-call',
            name: 'run_command',
            arguments: { command: 'touch x' },
          },
        ],
      },
      append,
    )

    expect(execute).toHaveBeenCalledOnce()
    expect(result.reconciliationRequired).toBe(false)
    expect(result.toolMessages[0]?.content).toBe('ran')
  })

  it('settles only the timed-out call and leaves its sibling open', () => {
    const events = [
      stored(1, 'running.changed', { isRunning: true }),
      stored(2, 'message.start', { messageId: 'a1', role: 'assistant' }),
      stored(3, 'tool.call', { messageId: 'a1', toolCall: { id: 'slow', name: 'mcp', arguments: {} } }),
      stored(4, 'tool.call', { messageId: 'a1', toolCall: { id: 'live', name: 'mcp', arguments: {} } }),
    ]
    const appended: TurnEvent[] = []
    settleOneUnknownToolOutcome(events, { messageId: 'a1', toolCallId: 'slow' }, (event) => appended.push(event))
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ type: 'tool.result', data: { toolCallId: 'slow' } })
  })

  it('allows boot resume only when the clean orphan proof was persisted', () => {
    const missing = [stored(1, 'worker.recovery_blocked', { interruptedAt: 't-new', reason: 'orphan_proof' })]
    const clean = [stored(1, 'worker.recovery_clean', { interruptedAt: 't-new' })]
    expect(sessionResumeAllowed(missing, 't-new')).toBe(false)
    expect(sessionResumeAllowed([], 't-new')).toBe(false)
    expect(sessionResumeAllowed(clean, 't-new')).toBe(true)
    expect(sessionResumeAllowed(clean, 't-later')).toBe(false)
  })
})
