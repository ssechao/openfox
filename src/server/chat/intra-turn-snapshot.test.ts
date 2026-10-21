/**
 * Intra-turn snapshots (real DB, EventStore, SessionManager, tools and
 * runChatTurn; only the LLM is scripted).
 *
 * A long turn takes a turn.snapshot every N events so the events re-read per
 * LLM call stay bounded, and the reconstructed state (messages, criteria,
 * context) is identical with and without the intermediate snapshots — also
 * after a stop and a resume.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LLMCompletionResponse, LLMStreamEvent } from '../llm/types.js'
import type { ToolCall } from '../../shared/types.js'
import type { StoredEvent } from '../events/types.js'
import type { RequestContextMessage } from './request-context.js'

vi.mock('../lsp/index.js', () => ({
  getLspManager: vi.fn(() => undefined),
  shutdownLspManager: vi.fn(async () => {}),
}))

vi.mock('../git/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/workspace.js')>()),
  getGitBranch: vi.fn(async () => null),
}))

import { loadConfig } from '../config.js'
import { setRuntimeConfig } from '../runtime-config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { initEventStore, getEventStore, getSessionState, getCurrentWindowMessageOptions } from '../events/index.js'
import { clearSessionStateMemo } from '../events/session.js'
import { SessionManager } from '../session/manager.js'
import { runChatTurn } from './orchestrator.js'
import { getConversationMessages } from './conversation-history.js'

const TOTAL_CALLS = 70
const STOP_AT = { call: 50, fragment: 50 }
const FRAGMENTS_PER_CALL = 300
const SNAPSHOT_EVERY = 40

const providerManager = {
  getCurrentModelContext: vi.fn(() => 200000),
  getLLMClient: vi.fn(),
  createClient: vi.fn(() => undefined),
  getActiveProviderId: vi.fn(() => undefined),
  getActiveProvider: vi.fn(() => undefined),
  getCurrentModel: vi.fn(() => 'scripted-model'),
  getProviders: vi.fn(() => []),
  getDefaultModelSelection: vi.fn(() => undefined),
  getModelSettings: vi.fn(() => undefined),
  resolveModelEffort: vi.fn(() => undefined),
}

function toolCallFor(call: number): ToolCall {
  return call % 2 === 0
    ? { id: `call-${call}`, name: 'read_file', arguments: { path: `notes/file-${call % 5}.txt` } }
    : {
        id: `call-${call}`,
        name: 'session_metadata',
        arguments: { action: 'add', key: 'criteria', description: `criterion from call ${call}` },
      }
}

function response(toolCalls: ToolCall[], content = ''): LLMCompletionResponse {
  return {
    id: 'resp',
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
  }
}

/** One scripted LLM shared by both turns: call N always streams the same events. */
function createScriptedClient(stop: { controller: AbortController | undefined }, onCall: (call: number) => void) {
  let call = 0
  return {
    complete: async () => response([]),
    getModel: () => 'scripted-model',
    getProfile: () => ({}) as never,
    getBackend: () => 'unknown' as const,
    setBackend: () => {},
    setModel: () => {},
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      const current = call++
      onCall(current)
      for (let i = 0; i < FRAGMENTS_PER_CALL; i++) {
        yield { type: 'thinking_delta', content: `c${current}-f${i} ` }
        if (current === STOP_AT.call && i === STOP_AT.fragment) stop.controller?.abort()
      }
      if (current >= TOTAL_CALLS - 1) {
        yield { type: 'text_delta', content: 'All done.' }
        yield { type: 'done', response: response([], 'All done.') }
        return
      }
      const toolCall = toolCallFor(current)
      const args = JSON.stringify(toolCall.arguments)
      yield { type: 'tool_call_delta', index: 0, id: toolCall.id, name: toolCall.name }
      for (let end = 8; end < args.length + 8; end += 8) {
        yield { type: 'tool_call_delta', index: 0, arguments: args.slice(end - 8, end) }
      }
      yield { type: 'done', response: response([toolCall]) }
    },
  }
}

function eventsAfterLastSnapshot(events: StoredEvent[]): number {
  return events.length - 1 - events.map((event) => event.type).lastIndexOf('turn.snapshot')
}

interface CapturedState {
  messages: unknown[]
  criteria: unknown
  metadataEntries: unknown
  mode: unknown
  phase: unknown
  context: unknown
  readFiles: unknown
  conversation: RequestContextMessage[]
}

function captureState(sessionId: string): CapturedState {
  clearSessionStateMemo()
  const state = getSessionState(sessionId)!
  const ids = new Map<string, string>()
  const stable = (id: string | undefined) => {
    if (id === undefined) return undefined
    if (!ids.has(id)) ids.set(id, `id-${ids.size}`)
    return ids.get(id)
  }
  return {
    messages: state.messages.map((message) => ({
      id: stable(message.id),
      role: message.role,
      content: message.content,
      thinkingContent: message.thinkingContent,
      contextWindowId: stable(message.contextWindowId),
      isStreaming: message.isStreaming,
      partial: message.partial,
      isSystemGenerated: message.isSystemGenerated,
      messageKind: message.messageKind,
      segments: message.segments,
      toolCalls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        success: toolCall.result?.success,
        output: toolCall.result?.output,
      })),
    })),
    criteria: state.criteria,
    metadataEntries: state.metadataEntries,
    mode: state.mode,
    phase: state.phase,
    context: {
      currentTokens: state.contextState.currentTokens,
      compactionCount: state.contextState.compactionCount,
      window: stable(state.currentContextWindowId),
    },
    readFiles: state.readFiles,
    conversation: getConversationMessages({ type: 'toplevel', sessionId }),
  }
}

function appendUserMessage(sessionId: string, content: string): void {
  const store = getEventStore()
  const messageId = crypto.randomUUID()
  store.append(sessionId, {
    type: 'message.start',
    data: { messageId, role: 'user', content, ...(getCurrentWindowMessageOptions(sessionId) ?? {}) },
  })
  store.append(sessionId, { type: 'message.done', data: { messageId } })
}

async function runScenario(workdir: string, snapshotEvery: number) {
  closeDatabase()
  clearSessionStateMemo()
  const config = loadConfig()
  config.database.path = ':memory:'
  config.mode = 'test'
  config.context.snapshotEveryEvents = snapshotEvery
  setRuntimeConfig(config)
  initDatabase(config)
  initEventStore(getDatabase())

  const store = getEventStore()
  const reads: number[] = []
  const getReplayEvents = store.getReplayEvents.bind(store)
  vi.spyOn(store, 'getReplayEvents').mockImplementation((sessionId: string) => {
    const events = getReplayEvents(sessionId)
    reads.push(eventsAfterLastSnapshot(events))
    return events
  })
  const snapshots: number[] = []
  const append = store.append.bind(store)
  vi.spyOn(store, 'append').mockImplementation((sessionId, event) => {
    const stored = append(sessionId, event)
    if (event.type === 'turn.snapshot') snapshots.push(stored.seq)
    return stored
  })

  const sessionManager = new SessionManager(providerManager as never)
  const session = sessionManager.createSession(createProject('Long turn', workdir).id)
  const stop: { controller: AbortController | undefined } = { controller: new AbortController() }
  const thinkingRowsPerCall: number[] = []
  const client = createScriptedClient(stop, () => {
    const row = getDatabase()
      .prepare(`SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND event_type = 'message.thinking'`)
      .get(session.id) as { count: number }
    thinkingRowsPerCall.push(row.count)
  })

  appendUserMessage(session.id, 'Run the long task.')
  await runChatTurn({
    sessionManager,
    sessionId: session.id,
    llmClient: client as never,
    signal: stop.controller!.signal,
  })
  const afterStop = captureState(session.id)
  const snapshotsInFirstTurn = snapshots.length

  stop.controller = undefined
  appendUserMessage(session.id, 'Resume.')
  await runChatTurn({ sessionManager, sessionId: session.id, llmClient: client as never })
  const final = captureState(session.id)

  return { reads, afterStop, final, snapshotsInFirstTurn, thinkingRowsPerCall }
}

describe('intra-turn snapshots', () => {
  let workdir: string
  let withSnapshots: Awaited<ReturnType<typeof runScenario>>
  let withoutSnapshots: Awaited<ReturnType<typeof runScenario>>

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'openfox-intra-turn-snapshot-'))
    await mkdir(join(workdir, 'notes'))
    for (let i = 0; i < 5; i++) await writeFile(join(workdir, 'notes', `file-${i}.txt`), `note ${i}\n`)

    withSnapshots = await runScenario(workdir, SNAPSHOT_EVERY)
    withoutSnapshots = await runScenario(workdir, Number.MAX_SAFE_INTEGER)
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    closeDatabase()
    await rm(workdir, { recursive: true, force: true })
  })

  it('runs the whole scripted turn (stop, then resume to the final answer)', () => {
    const lastMessage = withSnapshots.final.messages.at(-1) as { role: string; content: string }
    expect(lastMessage).toMatchObject({ role: 'assistant', content: 'All done.' })
    expect(withSnapshots.final.conversation.length).toBeGreaterThan(2 * TOTAL_CALLS)
  })

  it('takes intermediate snapshots in a long turn', () => {
    expect(withSnapshots.snapshotsInFirstTurn).toBeGreaterThan(3)
  })

  it('keeps the events re-read per LLM call bounded', () => {
    const maxWith = Math.max(...withSnapshots.reads)
    const maxWithout = Math.max(...withoutSnapshots.reads)
    expect(maxWith).toBeLessThanOrEqual(2 * SNAPSHOT_EVERY)
    expect(maxWithout).toBeGreaterThan(5 * SNAPSHOT_EVERY)
  })

  it('reconstructs the same state after the stop with and without intermediate snapshots', () => {
    expect(withSnapshots.afterStop).toEqual(withoutSnapshots.afterStop)
  })

  it('reconstructs the same state after the resume with and without intermediate snapshots', () => {
    expect(withSnapshots.final).toEqual(withoutSnapshots.final)
  })

  it('persists streamed fragments in batches through the real orchestrator', () => {
    const rowsBeforeStop = withoutSnapshots.thinkingRowsPerCall[STOP_AT.call]!
    expect(rowsBeforeStop).toBeGreaterThan(0)
    expect(rowsBeforeStop).toBeLessThanOrEqual(2 * STOP_AT.call)
    const thinking = withSnapshots.final.messages.filter(
      (message) => (message as { thinkingContent?: string }).thinkingContent,
    )
    expect(thinking.length).toBeGreaterThan(TOTAL_CALLS - 2)
  })
})
