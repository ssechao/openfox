import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { StoredEvent, TurnEvent } from '../../events/types.js'
import type { ToolCall } from '../../../shared/types.js'

const worktree = process.cwd()
const headRoot = join(tmpdir(), 'openfox-head-98ad75d')
rmSync(headRoot, { recursive: true, force: true })
const files: Record<string, string> = {
  'src/server/session/worker/crash.ts': 'crash.ts',
  'src/server/session/auto-continue.ts': 'auto-continue.ts',
  'src/server/chat/execute-tools.ts': 'execute-tools.ts',
  'src/server/events/fold-messages.ts': 'fold-messages.ts',
  'src/server/events/apply-events.ts': 'apply-events.ts',
}
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'head-98ad75d')
const head = new Set(Object.keys(files))

function rewrite(source: string, fromRel: string): string {
  return source.replace(/from '(\.[^']+)'/g, (_match, spec: string) => {
    const base = join(worktree, dirname(fromRel), spec)
    const asTs = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base
    const rel = relative(worktree, asTs)
    const target = head.has(rel) ? join(headRoot, rel) : asTs
    return `from '${target}'`
  })
}

const blobs: Record<string, string> = {}
for (const [rel, name] of Object.entries(files)) {
  const source = readFileSync(join(fixtureDir, name), 'utf8')
  blobs[rel] = createHash('sha256').update(source).digest('hex')
  const dest = join(headRoot, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rewrite(source, rel))
}

function stored(seq: number, type: string, data: unknown, timestamp = seq): StoredEvent {
  return { seq, timestamp, sessionId: 's-1', type, data } as StoredEvent
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

const crash = await import(pathToFileURL(join(headRoot, 'src/server/session/worker/crash.ts')).href)
const auto = await import(pathToFileURL(join(headRoot, 'src/server/session/auto-continue.ts')).href)
const tools = await import(pathToFileURL(join(headRoot, 'src/server/chat/execute-tools.ts')).href)
const fold = await import(pathToFileURL(join(headRoot, 'src/server/events/fold-messages.ts')).href)
const apply = await import(pathToFileURL(join(headRoot, 'src/server/events/apply-events.ts')).href)

const storeEvents = [...openCall]
const store = {
  invalidateExternalSession: () => {},
  getEvents: () => storeEvents,
  append: (_sessionId: string, event: TurnEvent) => {
    storeEvents.push(stored(storeEvents.length + 1, event.type, event.data, 1_000 + storeEvents.length))
  },
}
crash.prepareSessionInterruptionEvents(store, 's-1')
const pending = crash.findPendingToolReconciliations(storeEvents)
const bootDeps = {
  getEvents: () => storeEvents,
  hasActiveWorkflow: () => false,
  appendEvent: () => {},
  queueMessage: () => {},
}
const blockedBoot = auto.runBootAutoContinuations(['s-1'], bootDeps)

const decisionEvents = [
  stored(1, 'message.start', { messageId: 'u1', role: 'user' }),
  stored(2, 'message.start', { messageId: 'a1', role: 'assistant' }),
  stored(3, 'tool.reconciliation_required', {
    messageId: 'a1',
    toolCallId: 'tool-1',
    name: 'run_command',
    arguments: { command: 'side-effect' },
  }),
]
const decisionBoot = auto.runBootAutoContinuations(['s-1'], {
  ...bootDeps,
  getEvents: () => decisionEvents,
})

let executed = false
const registry = {
  tools: [],
  definitions: [],
  execute: async () => {
    executed = true
    return { success: true, output: 'ran', durationMs: 1, truncated: false }
  },
}
const effect = await tools.executeTools(
  'msg-1',
  [{ id: 'call-1', name: 'run_command', arguments: { command: 'touch x' } } satisfies ToolCall],
  {
    toolRegistry: registry,
    sessionManager: {
      getLspManager: () => undefined,
      getEffectiveWorkdir: () => '/test',
      getProjectWorkdir: () => '/test',
    },
    sessionId: 'test-session',
    workdir: '/test',
    turnMetrics: { addToolTime: () => {} },
    pendingToolReconciliations: [
      {
        messageId: 'old-message',
        toolCallId: 'unknown-call',
        name: 'run_command',
        arguments: { command: 'touch x' },
      },
    ],
  },
  () => {},
)

const duplicateEvents = [
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
const folded = fold.buildContextMessagesFromStoredEvents(duplicateEvents) as Array<{ role: string }>
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
apply.attachToolResultToMessage(attached, 'call-1', {
  success: true,
  output: 'late',
  durationMs: 1,
  truncated: false,
})

process.stdout.write(
  `HEAD_RESULT ${JSON.stringify({
    blobs,
    pending,
    blockedBoot,
    decisionBoot,
    reconciliationRequired: effect.reconciliationRequired === true,
    executed,
    toolMessages: folded.filter((message) => message.role === 'tool').length,
    replaced: attached.toolCalls[0]?.result,
  })}\n`,
)
