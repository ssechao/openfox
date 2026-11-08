import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { StoredEvent, TurnEvent } from '../../events/types.js'
import { foldPendingToolReconciliations } from '../../events/fold-state.js'
import { buildContextMessagesFromStoredEvents } from '../../events/fold-messages.js'
import { attachToolResultToMessage } from '../../events/apply-events.js'
import { prepareSessionInterruptionEvents } from './crash.js'
import { runBootAutoContinuations, type BootAutoContinueDeps } from '../auto-continue.js'
import { executeTools } from '../../chat/execute-tools.js'
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

const HEAD_BLOBS: Record<string, string> = {
  'src/server/session/worker/crash.ts': 'b23f67768a4b2a4ba1f516ffb9f3a4ca17c8d290e9e6911c7571869c79a724b9',
  'src/server/session/auto-continue.ts': '41846a73c669e4cf4bbe588cf16798ca21207bf55515e3714095bb4ebcf38952',
  'src/server/chat/execute-tools.ts': '4e9392f517cd181683eb3821ba83a43c627e065c34d9ddbad7f3908f932def57',
  'src/server/events/fold-messages.ts': '6d7418c1584e639ad4bad8e3b757b63dec829ae54ff2ca4799fbf746e0c94046',
  'src/server/events/apply-events.ts': 'e2a1ac9bd9e5f364254d95b990c6d244384da1d70b25822e333bff1069f694fe',
}

const FIXTURES: Record<string, string> = {
  'src/server/session/worker/crash.ts': 'crash.ts',
  'src/server/session/auto-continue.ts': 'auto-continue.ts',
  'src/server/chat/execute-tools.ts': 'execute-tools.ts',
  'src/server/events/fold-messages.ts': 'fold-messages.ts',
  'src/server/events/apply-events.ts': 'apply-events.ts',
}

interface HeadRun {
  blobs: Record<string, string>
  pending: Array<{ messageId: string; toolCallId: string; name: string }>
  blockedBoot: number
  decisionBoot: number
  reconciliationRequired: boolean
  executed: boolean
  toolMessages: number
  replaced: { success: boolean; output?: string; outcomeUnknown?: boolean }
}

let head: HeadRun

beforeAll(() => {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/server/session/worker/reconcile-red-head.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  const line = output.split('\n').find((entry) => entry.startsWith('HEAD_RESULT '))
  if (!line) throw new Error(`98ad75d runner produced no result:\n${output}`)
  head = JSON.parse(line.slice('HEAD_RESULT '.length)) as HeadRun
}, 70_000)

function stored(seq: number, type: string, data: unknown, timestamp = seq): StoredEvent {
  return { seq, timestamp, sessionId: 's-1', type, data } as StoredEvent
}

function memoryStore(initial: StoredEvent[]) {
  const events = [...initial]
  return {
    events,
    invalidateExternalSession: () => {},
    getEvents: () => events,
    append: (_sessionId: string, event: TurnEvent): StoredEvent => {
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

const unknownResult = {
  success: false,
  outcomeUnknown: true,
  error:
    'Tool result is unknown because execution was interrupted after the tool may have produced external effects. Do not retry this call automatically.',
  durationMs: 0,
  truncated: false,
}

function fixtureHash(rel: string): string {
  const name = FIXTURES[rel]
  if (!name) throw new Error(rel)
  return createHash('sha256')
    .update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'head-98ad75d', name)))
    .digest('hex')
}

describe('reconcile RED contracts', () => {
  it('loads the 98ad75d modules', () => {
    const files = Object.fromEntries(Object.keys(HEAD_BLOBS).map((rel) => [rel, fixtureHash(rel)]))
    expect(files).toEqual(HEAD_BLOBS)
    expect(head.blobs).toEqual(HEAD_BLOBS)
  })

  it('R-1 98ad75d findPendingToolReconciliations and prepareSessionInterruptionEvents leave the call pending and block boot', () => {
    expect(head.pending).toEqual([
      {
        messageId: 'a1',
        toolCallId: 'call-1',
        name: 'run_command',
        arguments: { command: 'printf x' },
      },
    ])
    expect(head.blockedBoot).toBe(0)

    const store = memoryStore(openCall)
    prepareSessionInterruptionEvents(store, 's-1')
    expect(foldPendingToolReconciliations(store.events)).toEqual([])
    const queued: string[] = []
    expect(
      runBootAutoContinuations(['s-1'], {
        getEvents: () => store.events,
        hasActiveWorkflow: () => false,
        appendEvent: () => {},
        queueMessage: (sessionId) => queued.push(sessionId),
      }),
    ).toBe(1)
    expect(queued).toEqual(['s-1'])
  })

  it('R-2 98ad75d runBootAutoContinuations requires a user decision', () => {
    expect(head.decisionBoot).toBe(0)
    const queued: string[] = []
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
      appendEvent: () => {},
      queueMessage: (sessionId) => queued.push(sessionId),
    }
    expect(runBootAutoContinuations(['s-1'], deps)).toBe(1)
    expect(queued).toEqual(['s-1'])
  })

  it('R-2 98ad75d executeTools blocks an effectful tool', async () => {
    expect(head.reconciliationRequired).toBe(true)
    expect(head.executed).toBe(false)

    const execute = vi.fn().mockResolvedValue({
      success: true,
      output: 'ran',
      durationMs: 1,
      truncated: false,
    })
    const result = await executeTools(
      'msg-1',
      [{ id: 'call-1', name: 'run_command', arguments: { command: 'touch x' } } satisfies ToolCall],
      {
        toolRegistry: { tools: [], execute, definitions: [] } as unknown as ToolRegistry,
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
      vi.fn(),
    )
    expect(result.reconciliationRequired).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('R-3 98ad75d fold keeps both tool results and attach replaces the terminal result', () => {
    expect(head.toolMessages).toBe(2)
    expect(head.replaced).toMatchObject({ success: true, output: 'late' })

    const events = [
      ...openCall,
      stored(4, 'tool.result', { messageId: 'a1', toolCallId: 'call-1', result: unknownResult }, 4),
      stored(
        5,
        'tool.result',
        {
          messageId: 'a1',
          toolCallId: 'call-1',
          result: { success: true, output: 'late', durationMs: 1, truncated: false },
        },
        5,
      ),
    ]
    expect(buildContextMessagesFromStoredEvents(events).filter((message) => message.role === 'tool')).toHaveLength(1)
    const attached = {
      toolCalls: [
        {
          id: 'call-1',
          name: 'run_command',
          arguments: { command: 'printf x' },
          result: unknownResult,
        },
      ],
    }
    attachToolResultToMessage(attached, 'call-1', {
      success: true,
      output: 'late',
      durationMs: 1,
      truncated: false,
    })
    expect(attached.toolCalls[0]?.result).toMatchObject({ success: false, outcomeUnknown: true })
  })
})
