/**
 * Replay proof for wrapper-compat 2 (a) on REAL production data.
 *
 * Loads the exported session 450/0fd8a855 (workflow Build & Verify, compacted
 * twice, provider = wrapper that strips usage) into a temporary in-memory
 * event store, then runs ONE top-level turn — the exact code path the
 * workflow `agent` step uses (executor → runAgentTurn → orchestrator →
 * buildGetConversationMessages) — against a stub chat-completions server that,
 * like the wrapper, never reports token usage.
 *
 * Old code (f75435a6): recorded context size stays 0, auto-compaction never
 * fires, every request re-sends the whole current window (~780 items).
 * New code: the local estimate drives auto-compaction and the post-compaction
 * body only carries the summary.
 *
 * The export path is provided via REPLAY_EXPORT (default /tmp file).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import type { LLMToolDefinition } from '../llm/types.js'
import { createLLMClient } from '../llm/client.js'

vi.mock('../events/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/index.js')>()
  return {
    ...actual,
    getCurrentContextWindowId: vi.fn((sessionId: string) => {
      const store = vi.mocked(getEventStore)()
      return store?.getCurrentWindowId(sessionId)
    }),
    getCurrentWindowMessageOptions: vi.fn((sessionId: string) => {
      const store = vi.mocked(getEventStore)()
      const contextWindowId = store?.getCurrentWindowId(sessionId)
      return contextWindowId ? { contextWindowId } : undefined
    }),
    getEventStore: vi.fn(),
  }
})

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: vi.fn(),
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn(),
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    mode: 'test',
    workdir: '/test',
    context: { compactionThreshold: 800000 },
    agent: { toolTimeout: 5000 },
    llm: {
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      timeout: 30000,
      idleTimeout: 30000,
      backend: 'ollama',
    },
  }),
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: vi.fn().mockReturnValue('/test/config'),
}))

vi.mock('../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(async () => []),
  getSubAgents: vi.fn(() => []),
  resolveDefaultAgentId: vi.fn(() => 'planner'),
}))

vi.mock('./drain-queue.js', () => ({
  drainQueue: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('../db/settings.js', () => ({
  getSetting: vi.fn(),
  SETTINGS_KEYS: {
    AGENT_ALLOW_PARALLEL_SUB_AGENTS: 'agent.allowParallelSubAgents',
    LLM_DYNAMIC_SYSTEM_PROMPT: 'llm.dynamicSystemPrompt',
  },
}))

import { runTopLevelAgentLoop } from './agent-loop.js'
import { getConversationMessages } from './conversation-history.js'
import { getEventStore } from '../events/index.js'

const EXPORT_PATH = process.env['REPLAY_EXPORT'] ?? '/tmp/session-0fd8a855-export.json'
const SESSION_ID = '0fd8a855-f280-4aea-8a48-b1c968c4f322'
const MODEL_CONTEXT = 262144
const COMPACTION_THRESHOLD = 0.85

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }
const READ_FILE_TOOL: LLMToolDefinition = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
}

const CHAT_OK_SSE_NO_USAGE = [
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }),
  JSON.stringify({ id: 'c-ok', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
]

interface ExportMessage {
  id: string
  role: string
  content?: string
  contextWindowId?: string
}
interface ExportEvent {
  seq: number
  sessionId: string
  timestamp: number
  type: string
  data: Record<string, unknown>
}
interface SessionExport {
  events: ExportEvent[]
}

function loadExport(): SessionExport {
  return JSON.parse(readFileSync(EXPORT_PATH, 'utf8')) as SessionExport
}

async function startNoUsageServer(
  onHit: (body: Record<string, unknown>) => void,
): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString()
    })
    req.on('end', () => {
      onHit(JSON.parse(raw || '{}') as Record<string, unknown>)
      count += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const line of CHAT_OK_SSE_NO_USAGE) res.write(`data: ${line}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, hits: () => count }
}

describe.skipIf(!existsSync(EXPORT_PATH))(
  'wrapper-compat 2 — replay of real session 450/0fd8a855 (workflow, 2 compactions)',
  () => {
    const servers: Server[] = []
    let db: Database.Database
    let store: EventStore
    let mockSessionManager: any
    let mockTurnMetrics: TurnMetrics
    let recordedTokens = 0

    afterAll(() => {
      for (const server of servers) server.close()
    })

    beforeEach(async () => {
      vi.clearAllMocks()
      recordedTokens = 0
      db = new Database(':memory:')
      store = new EventStore(db)
      db.exec(
        `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0, updated_at INTEGER)`,
      )
      vi.mocked(getEventStore).mockReturnValue(store)

      const exported = loadExport()
      for (const event of exported.events) {
        store.append(event.sessionId, { type: event.type, data: event.data } as never)
      }

      mockSessionManager = {
        enterPauseGate: vi.fn().mockResolvedValue('released'),
        requireSession: vi.fn().mockReturnValue({
          workdir: '/test',
          projectId: 'test-project',
          executionState: null,
          criteria: [],
          isRunning: false,
        }),
        getEffectiveWorkdir: vi.fn().mockReturnValue('/test'),
        getProjectWorkdir: vi.fn().mockReturnValue('/test'),
        getContextState: vi.fn().mockImplementation(() => ({
          currentTokens: recordedTokens,
          maxTokens: MODEL_CONTEXT,
          compactionCount: 2,
          dangerZone: false,
          canCompact: true,
          dynamicContextChanged: false,
        })),
        getCurrentModelContext: vi.fn().mockReturnValue(MODEL_CONTEXT),
        getCurrentModelSettings: vi.fn().mockReturnValue({ maxTokens: 4096 }),
        getModelCompactionThreshold: vi.fn().mockReturnValue(COMPACTION_THRESHOLD),
        setCurrentContextSize: vi
          .fn()
          .mockImplementation((_sid: string, promptTokens: number, completionTokens = 0) => {
            recordedTokens = promptTokens + completionTokens
          }),
        getCachedPrompt: vi.fn().mockReturnValue(undefined),
        setCachedPrompt: vi.fn(),
        getReadFiles: vi.fn().mockReturnValue({}),
        getLspManager: vi.fn().mockReturnValue(undefined),
        drainAsapMessages: vi.fn().mockReturnValue([]),
        getSessionProjectId: vi.fn().mockReturnValue('test-project'),
      }
      mockTurnMetrics = {
        addToolTime: vi.fn(),
        addLLMCall: vi.fn(),
        addThinkingTime: vi.fn(),
        buildStats: vi.fn().mockReturnValue({ durationMs: 0 }),
      } as unknown as TurnMetrics

      const { getAllInstructions } = await import('../context/instructions.js')
      const { getEnabledSkillMetadata } = await import('../skills/registry.js')
      ;(getAllInstructions as any).mockResolvedValue({ content: 'test instructions', files: [] })
      ;(getEnabledSkillMetadata as any).mockResolvedValue([])
    })

    afterEach(() => {
      db.close()
    })

    it('usage-stripped provider: auto-compaction fires and the post-compaction body only carries the summary', async () => {
      const exported = loadExport()
      const snapshot = [...exported.events].reverse().find((e) => e.type === 'turn.snapshot')!
      const snapshotMessages = (snapshot.data as { messages: ExportMessage[] }).messages
      const currentWindowId = (snapshot.data as { currentContextWindowId: string }).currentContextWindowId

      const currentWindowContents = new Set(
        snapshotMessages
          .filter((m) => m.contextWindowId === currentWindowId && m.content)
          .map((m) => m.content as string),
      )
      const oldWindowUniqueContents = snapshotMessages
        .filter((m) => m.contextWindowId && m.contextWindowId !== currentWindowId && m.content)
        .map((m) => m.content as string)
        .filter((content) => content.length > 80 && !currentWindowContents.has(content))

      // Static replay: what the workflow build step would send as the next body.
      const staticMessages = getConversationMessages({ type: 'toplevel', sessionId: SESSION_ID })
      const staticJson = JSON.stringify(staticMessages)
      console.log(`[replay] static body: messages=${staticMessages.length} bytes=${Buffer.byteLength(staticJson)}`)
      const leaked = oldWindowUniqueContents.filter((content) => staticJson.includes(content))
      console.log(
        `[replay] old-window unique contents checked=${oldWindowUniqueContents.length} leaked=${leaked.length}`,
      )
      expect(leaked).toEqual([])

      // Dynamic replay: one full turn against a usage-stripped stub (the wrapper).
      const captured: Array<Record<string, unknown>> = []
      const mock = await startNoUsageServer((body) => {
        captured.push(body)
      })
      servers.push(mock.server)
      const llmClient = createLLMClient({
        llm: {
          baseUrl: `http://127.0.0.1:${mock.port}`,
          timeout: 30000,
          idleTimeout: 30000,
          model: 'kimi-k3-256k',
          apiKey: 'test-key',
          backend: 'openai',
          apiProtocol: 'chat-completions',
        },
        context: { maxTokens: MODEL_CONTEXT, compactionThreshold: 0.85, compactionTarget: 0.6 },
      } as never)

      const config: TopLevelLoopConfig = {
        mode: 'builder',
        append: (event) => store.append(SESSION_ID, event),
        sessionManager: mockSessionManager,
        sessionId: SESSION_ID,
        llmClient: llmClient as never,
        statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'kimi-k3-256k' },
        assembleRequest: vi.fn(async ({ messages }) => ({
          systemPrompt: 'sys',
          messages,
          tools: [READ_FILE_TOOL],
        })),
        getToolRegistry: () =>
          ({
            tools: [{ name: 'read_file' }],
            definitions: [READ_FILE_TOOL],
            execute: vi.fn(async () => ({ success: true, output: 'file-ok', durationMs: 1, truncated: false })),
          }) as any,
        getConversationMessages: async () => getConversationMessages({ type: 'toplevel', sessionId: SESSION_ID }),
        llmRetryPolicy: FAST_POLICY,
      }
      const result = await runTopLevelAgentLoop(config, mockTurnMetrics)
      expect(result.failed).toBeUndefined()

      const firstBody = JSON.stringify(captured[0])
      const firstItems = (captured[0]!['messages'] as unknown[]).length
      console.log(
        `[replay] turn bodies: hits=${mock.hits()} first={items=${firstItems} bytes=${Buffer.byteLength(firstBody)}} recordedTokensAfterFirst=${recordedTokens}`,
      )
      const compactionEvents = store.getEvents(SESSION_ID).filter((e) => e.type === 'context.compacted')
      console.log(`[replay] context.compacted appended during turn: ${compactionEvents.length}`)

      // The fix: the local estimate must replace the stripped usage, driving
      // auto-compaction; the request right after carries only the new window.
      expect(compactionEvents.length).toBe(1)
      expect(mock.hits()).toBe(3)
      const lastBody = JSON.stringify(captured[2])
      const lastItems = (captured[2]!['messages'] as unknown[]).length
      console.log(`[replay] post-compaction body: items=${lastItems} bytes=${Buffer.byteLength(lastBody)}`)
      expect(lastItems).toBeLessThan(10)
      expect(Buffer.byteLength(lastBody)).toBeLessThan(50_000)
    }, 120_000)
  },
)
