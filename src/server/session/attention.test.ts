import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../shared/types.js'
import { loadConfig } from '../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject, updateProject } from '../db/projects.js'
import { initEventStore, getEventStore, getCurrentWindowMessageOptions } from '../events/index.js'
import { logger } from '../utils/logger.js'
import { SessionManager } from './manager.js'
import { provideAnswer, registerPendingQuestion } from '../tools/ask.js'
import {
  configureAttentionService,
  createAetherNotifier,
  formatAttentionMessage,
  getAttentionService,
  resetAttentionService,
  type CallToolFn,
} from './attention.js'
import { createTasksService, type TasksService } from '../tasks/service.js'
import { createOpenFoxMcpTools } from '../mcp/server/tools.js'
import type { OpenFoxMcpToolDeps } from '../mcp/server/types.js'
import { createOpenFoxCallerIdentityAuthority, createOpenFoxEndpointBinding } from '../mcp/server/caller-identity.js'
import { applyOpenFoxCallerIdentityInjection } from '../mcp/session-id-injection.js'

vi.mock('../lsp/index.js', () => ({
  getLspManager: vi.fn(() => undefined),
  shutdownLspManager: vi.fn(async () => {}),
}))

vi.mock('../git/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/workspace.js')>()),
  getGitBranch: vi.fn(async () => null),
}))

import { runChatTurn } from '../chat/orchestrator.js'

const execFileAsync = promisify(execFile)

const mockProviderManager = () =>
  ({
    getCurrentModelContext: () => 200_000,
    getLLMClient: () => ({ getModel: () => 'm', stream: vi.fn(), complete: vi.fn() }),
    createClient: () => undefined,
    getActiveProviderId: () => 'test-provider',
    getCurrentModel: () => 'm',
    getProviders: () => [],
    getDefaultModelSelection: () => undefined,
    getModelSettings: () => undefined,
    resolveModelEffort: () => undefined,
  }) as unknown as ConstructorParameters<typeof SessionManager>[0]

describe('session attention (STALL-NOTIFY)', () => {
  let root: string
  let projectDir: string
  let config: Config
  let projectId: string
  let manager: SessionManager
  let clock: { nowMs: number }
  let notify: (params: import('./attention.js').AttentionNotifyParams) => Promise<void>

  const configure = () =>
    configureAttentionService({
      now: () => clock.nowMs,
      waitMs: 10 * 60 * 1000,
      notify,
      getSessionTitle: (sessionId: string) => {
        const session = manager.getSession(sessionId)
        if (!session) return null
        return {
          title: session.metadata?.title ?? '',
          projectId: session.projectId,
          createdBy: session.createdBy ?? null,
        }
      },
    })

  const attentionEvents = (sessionId: string, type: string) =>
    getEventStore()
      .getEvents(sessionId)
      .filter((event) => event.type === type)
      .map((event) => event.data)

  beforeEach(async () => {
    closeDatabase()
    resetAttentionService()
    root = await mkdtemp(join(tmpdir(), 'openfox-attention-'))
    projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    config = loadConfig()
    config.database.path = join(root, 'sessions.db')
    initDatabase(config)
    initEventStore(getDatabase())
    manager = new SessionManager(mockProviderManager())
    projectId = createProject('Attention', projectDir).id
    clock = { nowMs: 1_700_000_000_000 }
    notify = async () => {}
    configure()
  })

  afterEach(async () => {
    resetAttentionService()
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it('blocked session emits attention_required once', () => {
    const session = manager.createSession(projectId, 'Stalled run')
    const service = getAttentionService()

    service.observeBlocked(session.id, 'HTTP 400 native_context_unavailable')
    // Repeated observations of the same state (sweeps, retries) must not re-emit.
    service.observeBlocked(session.id, 'HTTP 400 native_context_unavailable')
    service.sweep()

    let required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({
      sessionId: session.id,
      projectId,
      reason: 'blocked',
      detail: 'HTTP 400 native_context_unavailable',
      since: new Date(clock.nowMs).toISOString(),
    })

    // The session resumes: exactly one clearing event, and a later block re-arms.
    manager.setPhase(session.id, 'build')
    const cleared = attentionEvents(session.id, 'session.attention_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ sessionId: session.id, reason: 'blocked' })

    service.observeBlocked(session.id, 'HTTP 400 native_context_unavailable')
    required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(2)
  })

  it('waiting session without wake emits attention_required after the delay', () => {
    const session = manager.createSession(projectId, 'Waiting run')
    const service = getAttentionService()

    registerPendingQuestion('call-late', session.id, 'Which option?', 'text')
    service.sweep()
    expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(0)

    clock.nowMs += 10 * 60 * 1000 + 1
    service.sweep()
    service.sweep()
    const required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({
      sessionId: session.id,
      reason: 'waiting_question',
      detail: 'call-late',
      since: new Date(1_700_000_000_000).toISOString(),
    })

    provideAnswer('call-late', 'the first one')
    const cleared = attentionEvents(session.id, 'session.attention_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ sessionId: session.id, reason: 'waiting_question' })

    // A question answered before the delay never produces an event.
    registerPendingQuestion('call-fast', session.id, 'Quick check?', 'text')
    provideAnswer('call-fast', 'ok')
    clock.nowMs += 60 * 60 * 1000
    service.sweep()
    expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1)

    // A pending question that predates the service start is never backfilled.
    registerPendingQuestion('call-stale', session.id, 'Old question?', 'text')
    resetAttentionService()
    configure()
    getAttentionService().sweep()
    expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1)
    provideAnswer('call-stale', 'cleanup')
  })

  it('dedup survives a service restart (registry rebuilt from persisted events)', () => {
    const session = manager.createSession(projectId, 'Reboot cycle')
    const service = getAttentionService()
    service.observeBlocked(session.id, 'HTTP 400 native_context_unavailable')
    expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1)

    // A service restart must not re-notify a stall that is still open: the
    // registry is rebuilt from persisted events without re-emitting.
    resetAttentionService()
    configure()
    getAttentionService().observeBlocked(session.id, 'HTTP 400 native_context_unavailable')
    expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1)

    // After the restart, leaving the blocked phase still closes the stall
    // persisted before the restart.
    manager.setPhase(session.id, 'blocked')
    manager.setPhase(session.id, 'build')
    const cleared = attentionEvents(session.id, 'session.attention_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ sessionId: session.id, reason: 'blocked' })
  })

  it('a second open question still alerts after the first is answered', () => {
    const session = manager.createSession(projectId, 'Two questions')
    const service = getAttentionService()

    registerPendingQuestion('call-a', session.id, 'First?', 'text')
    registerPendingQuestion('call-b', session.id, 'Second?', 'text')
    // Answering the first question before the delay must not cancel the alert
    // owed for the second one, which is still pending.
    provideAnswer('call-a', 'first answer')
    clock.nowMs += 10 * 60 * 1000 + 1
    service.sweep()

    const required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({ sessionId: session.id, reason: 'waiting_question', detail: 'call-b' })

    provideAnswer('call-b', 'second answer')
    const cleared = attentionEvents(session.id, 'session.attention_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ sessionId: session.id, reason: 'waiting_question' })
  })

  it('attention_required notifies the creator pilot through Aether', async () => {
    const calls: Array<{
      serverName: string
      toolName: string
      args: Record<string, unknown>
      sessionId: string | undefined
    }> = []
    const callTool: CallToolFn = async (serverName, toolName, args, sessionId) => {
      calls.push({ serverName, toolName, args, sessionId })
      if (args['tool_name'] === 'ht_get_contact_info') {
        return { success: true, output: 'Your hub identity:\n  peer_id: peer-creator-42\n  hub: http://x/mcp' }
      }
      return { success: true, output: 'delivered' }
    }
    const notifyCreator = createAetherNotifier(callTool)

    const params = {
      sessionId: 'session-stalled',
      projectId: 'project-1',
      title: 'Worker run',
      reason: 'blocked' as const,
      detail: 'HTTP 400 native_context_unavailable',
      sinceMs: 1_700_000_000_000,
      createdBy: 'session-creator',
    }
    await notifyCreator(params)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      serverName: 'mcp-lazy',
      toolName: 'mcp_execute_tool',
      sessionId: 'session-creator',
    })
    expect((calls[0]!.args as Record<string, unknown>)['server_name']).toBe('llm-aether')
    expect((calls[0]!.args as Record<string, unknown>)['tool_name']).toBe('ht_get_contact_info')
    expect(calls[1]).toMatchObject({
      serverName: 'mcp-lazy',
      toolName: 'mcp_execute_tool',
      sessionId: 'session-stalled',
    })
    const sendArgs = calls[1]!.args as Record<string, unknown>
    expect(sendArgs['server_name']).toBe('llm-aether')
    expect(sendArgs['tool_name']).toBe('ht_send_to_peer')
    const innerSend = sendArgs['arguments'] as Record<string, unknown>
    expect(innerSend['peer_id']).toBe('peer-creator-42')
    const message = String(innerSend['message'])
    expect(message).toContain('SESSION BLOQUÉE')
    expect(message).toContain('Worker run')
    expect(message).toContain('session-stalled')
    expect(message).toContain('native_context_unavailable')

    // No proven creator: the event stands alone, no channel is attempted.
    calls.length = 0
    await notifyCreator({ ...params, createdBy: null })
    expect(calls).toHaveLength(0)

    // A failed contact lookup is an explicit logged failure, no fallback
    // channel. The spy proves the contact probe really ran exactly once and
    // the send never was attempted.
    calls.length = 0
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const failingContact: CallToolFn = async (serverName, toolName, args, sessionId) => {
      calls.push({ serverName, toolName, args, sessionId })
      return { success: false, error: 'no hub session established yet' }
    }
    await createAetherNotifier(failingContact)(params)
    expect(calls).toHaveLength(1)
    expect((calls[0]!.args as Record<string, unknown>)['tool_name']).toBe('ht_get_contact_info')
    let logged = errorLog.mock.calls.map((call) => call.map((arg) => JSON.stringify(arg)).join(' ')).join(' ')
    expect(logged).toContain('attention_notify_failed')
    expect(logged).toContain('ht_get_contact_info')

    // Contact OK but delivery fails: exactly one send was attempted and the
    // failure is logged with its stage.
    calls.length = 0
    errorLog.mockClear()
    const failingSend: CallToolFn = async (serverName, toolName, args, sessionId) => {
      calls.push({ serverName, toolName, args, sessionId })
      if ((args as Record<string, unknown>)['tool_name'] === 'ht_get_contact_info') {
        return { success: true, output: 'peer_id: peer-creator-42' }
      }
      return { success: false, error: 'peer offline' }
    }
    await createAetherNotifier(failingSend)(params)
    expect(calls).toHaveLength(2)
    expect((calls[1]!.args as Record<string, unknown>)['tool_name']).toBe('ht_send_to_peer')
    logged = errorLog.mock.calls.map((call) => call.map((arg) => JSON.stringify(arg)).join(' ')).join(' ')
    expect(logged).toContain('attention_notify_failed')
    expect(logged).toContain('ht_send_to_peer')
    errorLog.mockRestore()
  })

  it('session creator is recorded only from a proven identity', async () => {
    // --- kanban launch records the launcher --------------------------------
    const gitDir = join(root, 'launch-project')
    await mkdir(gitDir, { recursive: true })
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: gitDir })
    await execFileAsync('git', ['config', 'user.email', 'tests@openfox.local'], { cwd: gitDir })
    await execFileAsync('git', ['config', 'user.name', 'OpenFox Tests'], { cwd: gitDir })
    await writeFile(join(gitDir, 'README.md'), 'fixture\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: gitDir })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: gitDir })
    const launchProjectId = createProject('Launch', gitDir).id
    updateProject(launchProjectId, { workspaceRootDir: join(root, 'workspaces', 'launch') })
    const launcher = manager.createSession(projectId, 'Launcher')
    manager.setMode(launcher.id, 'manager')

    config.providers = [
      {
        id: 'provider-a',
        name: 'provider-a',
        url: 'http://localhost:8000/v1',
        backend: 'openai',
        models: [{ id: 'model-a', contextWindow: 32_000, source: 'user' }],
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    config.defaultModelSelection = 'provider-a/model-a'
    const service: TasksService = createTasksService({
      sessionManager: manager,
      config,
      broadcast: () => undefined,
      configDir: join(root, 'config'),
    })
    const task = service.create(launchProjectId, { prompt: 'do the thing' }, { actor: 'human' })
    const launch = await service.launch({
      requesterSessionId: launcher.id,
      projectId: launchProjectId,
      taskId: task.id,
      agentId: 'builder',
      providerId: 'provider-a',
      model: 'model-a',
      workspace: 'worker-1',
      branch: 'feature/worker-1',
      sourceBranch: 'main',
    })
    expect(launch.ok).toBe(true)
    if (!launch.ok || !launch.sessionId) throw new Error('launch failed')
    expect(manager.getSession(launch.sessionId)?.createdBy).toBe(launcher.id)

    // --- openfox_create_session records only a proven caller ---------------
    // Real HMAC authority (not mocked): the gateway is the production
    // createOpenFoxCallerIdentityAuthority + createOpenFoxEndpointBinding, and
    // the proof reaches the tool through the real injection helper.
    const created = new Map<string, { createdBy: string | null }>()
    const authority = createOpenFoxCallerIdentityAuthority()
    const binding = createOpenFoxEndpointBinding({
      selfEndpointUrl: () => 'http://127.0.0.1:450/mcp',
      proxyServerName: 'mcp-lazy',
      proxyTargetName: 'openfox',
      getProxyConfig: () => ({ transport: 'stdio', command: 'npx', args: ['mcp-lazy'] }),
      resolveProxyTargetUrl: () => 'http://127.0.0.1:450/mcp',
    })
    const gateway = { issueProof: authority.issueProof, isOwnEndpoint: binding }
    const deps = {
      sessionManager: {
        getSession: (id: string) => (id === 'caller-1' ? { id: 'caller-1', projectId, mode: 'manager' } : undefined),
        getProject: () => ({ id: projectId, name: 'Attention', workdir: projectDir }),
        createSession: vi.fn((pid: string, title?: string) => {
          const id = 'new-' + (created.size + 1)
          created.set(id, { createdBy: null })
          return { id, projectId: pid, metadata: { title } }
        }),
        setSessionCreatedBy: vi.fn((id: string, createdBy: string) => {
          created.set(id, { createdBy })
        }),
      },
      verifyCallerIdentity: (input: Parameters<typeof authority.verify>[0]) => authority.verify(input),
    } as unknown as OpenFoxMcpToolDeps
    const tools = createOpenFoxMcpTools(deps)
    const createTool = tools.find((tool) => tool.name === 'openfox_create_session')
    expect(createTool).toBeDefined()

    const serverConfig = { transport: 'http' as const, url: 'http://127.0.0.1:450/mcp' }
    const inject = (args: Record<string, unknown>, caller: string | undefined) =>
      applyOpenFoxCallerIdentityInjection(gateway, 'openfox', serverConfig, 'openfox_create_session', args, caller)

    // The host injects an HMAC proof only for a caller it observed itself.
    const proven = inject({ projectId, title: 'Proven child' }, 'caller-1')
    if (!proven.ok) throw new Error('host injection refused a proven caller')
    await createTool!.handler(proven.args)
    expect([...created.values()]).toEqual([{ createdBy: 'caller-1' }])

    // A model-declared (unproven) session id must not be trusted.
    await createTool!.handler({ projectId, title: 'Forged child', openfox_session_id: 'caller-1' })
    expect([...created.values()]).toEqual([{ createdBy: 'caller-1' }, { createdBy: null }])

    // A proof issued for another tool tuple must not validate for create.
    const wrongTuple = authority.issueProof({
      callerSessionId: 'caller-1',
      toolName: 'openfox_delete_session',
      targetSessionId: projectId,
    })
    await createTool!.handler({
      projectId,
      title: 'Wrong tuple',
      openfox_session_id: 'caller-1',
      openfox_session_proof: wrongTuple,
    })
    expect([...created.values()]).toEqual([{ createdBy: 'caller-1' }, { createdBy: null }, { createdBy: null }])

    // --- migration keeps existing rows and columns -------------------------
    const db = getDatabase()
    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('created_by')
    db.exec(`ALTER TABLE sessions DROP COLUMN created_by`)
    db.prepare(
      `INSERT INTO sessions (id, project_id, workdir, phase, created_at, updated_at, title, mode, workflow_phase, is_running, danger_level)
       VALUES ('legacy-1', ?, ?, 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'Legacy', 'planner', 'plan', 0, 'normal')`,
    ).run(projectId, projectDir)
    const before = db.prepare(`SELECT id, title, phase, mode FROM sessions WHERE id = 'legacy-1'`).all()
    expect(before).toHaveLength(1)
    closeDatabase()
    initDatabase(config)
    const after = getDatabase().prepare(`SELECT id, title, phase, mode FROM sessions WHERE id = 'legacy-1'`).all()
    expect(after).toEqual(before)
    const migrated = getDatabase().prepare(`SELECT created_by FROM sessions WHERE id = 'legacy-1'`).get() as
      { created_by: string | null } | undefined
    expect(migrated?.created_by).toBeNull()
  })

  // --------------------------------------------------------------------------
  // STALL-NOTIFY-2: failed plain chat turns
  // --------------------------------------------------------------------------

  const scriptedClient = (script: Array<{ error?: string; content?: string }>) => {
    let call = 0
    return {
      complete: async () => ({
        id: 'resp',
        content: '',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      }),
      getModel: () => 'scripted-model',
      getProfile: () => ({}) as never,
      getBackend: () => 'unknown' as const,
      setBackend: () => {},
      setModel: () => {},
      stream: async function* (): AsyncGenerator<import('../llm/types.js').LLMStreamEvent> {
        const step = script[Math.min(call++, script.length - 1)]!
        if (step.error) {
          yield { type: 'error', error: step.error }
          return
        }
        yield { type: 'text_delta', content: step.content ?? 'All done.' }
        yield {
          type: 'done',
          response: {
            id: 'resp',
            content: step.content ?? 'All done.',
            toolCalls: [],
            finishReason: 'stop' as const,
            usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
          },
        }
      },
    }
  }

  const appendUserMessage = (sessionId: string, content: string) => {
    const store = getEventStore()
    const messageId = crypto.randomUUID()
    store.append(sessionId, {
      type: 'message.start',
      data: { messageId, role: 'user', content, ...(getCurrentWindowMessageOptions(sessionId) ?? {}) },
    })
    store.append(sessionId, { type: 'message.done', data: { messageId } })
  }

  const NATIVE_CTX_ERROR = `HTTP 400: {"error":{"code":"native_context_unavailable","message":"${'x'.repeat(300)}"}}`
  const RATE_LIMIT_ERROR = 'HTTP 429 (retry-after-ms=1): {"error":{"code":"rate_limit_exceeded","message":"slow down"}}'

  it('a failed chat turn emits attention_required once', async () => {
    const session = manager.createSession(projectId, 'Failing pilot')
    manager.setPhase(session.id, 'build')
    appendUserMessage(session.id, 'Run the thing.')

    // One turn whose LLM requests keep failing internally (429 retried to
    // exhaustion) must emit exactly one attention_required.
    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: RATE_LIMIT_ERROR }]) as never,
      llmRetryPolicy: { maxAttempts: 2, maxDurationMs: 60_000, backoffMs: [1], minIntervalMs: 1 },
    })

    let required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({
      sessionId: session.id,
      projectId,
      reason: 'turn_failed',
      since: new Date(clock.nowMs).toISOString(),
    })
    const detail = String((required[0] as { detail: string }).detail)
    expect(detail.startsWith('HTTP 429')).toBe(true)
    expect(detail.length).toBeLessThanOrEqual(120)

    // A non-retryable 400 within the same ongoing failure must not re-emit.
    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)

    // The session phase is untouched: a failed chat turn never blocks it.
    expect(manager.getSession(session.id)?.phase).toBe('build')
    expect(attentionEvents(session.id, 'session.attention_cleared')).toHaveLength(0)
  })

  it('a later successful turn clears the attention without notifying again', async () => {
    const session = manager.createSession(projectId, 'Recovering pilot')
    appendUserMessage(session.id, 'Run the thing.')
    const notifySpy = vi.fn(async () => {})
    notify = notifySpy
    configure()

    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    expect(attentionEvents(session.id, 'session.attention_required')).toHaveLength(1)
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))

    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ content: 'Recovered.' }]) as never,
    })
    const cleared = attentionEvents(session.id, 'session.attention_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ sessionId: session.id, reason: 'turn_failed' })

    // Clearing never notifies over Aether.
    await Promise.resolve()
    await Promise.resolve()
    expect(notifySpy).toHaveBeenCalledTimes(1)

    // A later failure re-arms: a second required is emitted and notified.
    // (cleanupOldEvents after the successful turn may prune the first
    // persisted required, so the re-arm is proven by the second notification.)
    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(2))
    const required = attentionEvents(session.id, 'session.attention_required')
    expect(required.length).toBeGreaterThanOrEqual(1)
    expect(required.at(-1)).toMatchObject({ sessionId: session.id, reason: 'turn_failed' })
  })

  it('turn_failed notifies the proven creator only, with explicit send failures', async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const callTool: CallToolFn = async (_serverName, _toolName, args) => {
      calls.push({ toolName: String((args as Record<string, unknown>)['tool_name']), args })
      if ((args as Record<string, unknown>)['tool_name'] === 'ht_get_contact_info') {
        return { success: true, output: 'peer_id: peer-creator-77' }
      }
      return { success: true, output: 'delivered' }
    }
    notify = createAetherNotifier(callTool)
    configure()

    const session = manager.createSession(projectId, 'Piloted run')
    manager.setSessionCreatedBy(session.id, 'creator-pilot')
    appendUserMessage(session.id, 'Run the thing.')
    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]!.toolName).toBe('ht_get_contact_info')
    expect(calls[1]!.toolName).toBe('ht_send_to_peer')
    const inner = calls[1]!.args['arguments'] as Record<string, unknown>
    expect(inner['peer_id']).toBe('peer-creator-77')
    const message = String(inner['message'])
    expect(message).toContain('TOUR EN ÉCHEC')
    expect(message).toContain('Piloted run')
    expect(message).toContain(session.id)
    expect(message).toContain('native_context_unavailable')
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(800)

    // A session with no proven creator gets the event but no Aether attempt.
    calls.length = 0
    const orphan = manager.createSession(projectId, 'Orphan run')
    appendUserMessage(orphan.id, 'Run the thing.')
    await runChatTurn({
      sessionManager: manager,
      sessionId: orphan.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    expect(attentionEvents(orphan.id, 'session.attention_required')).toHaveLength(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(0)

    // A failed delivery is logged as attention_notify_failed, no fallback.
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
    notify = createAetherNotifier(async (_s, _t, args) => {
      if ((args as Record<string, unknown>)['tool_name'] === 'ht_get_contact_info') {
        return { success: true, output: 'peer_id: peer-creator-77' }
      }
      return { success: false, error: 'peer offline' }
    })
    configure()
    const second = manager.createSession(projectId, 'Undelivered run')
    manager.setSessionCreatedBy(second.id, 'creator-pilot')
    appendUserMessage(second.id, 'Run the thing.')
    await runChatTurn({
      sessionManager: manager,
      sessionId: second.id,
      llmClient: scriptedClient([{ error: NATIVE_CTX_ERROR }]) as never,
    })
    await vi.waitFor(() =>
      expect(errorLog.mock.calls.some((call) => String(call[0]).includes('attention_notify_failed'))).toBe(true),
    )
    errorLog.mockRestore()
  })

  it('worker forward transports turn observations through the attention service', () => {
    const forwarded: import('./attention.js').AttentionObservation[] = []
    configureAttentionService({ forward: (observation) => forwarded.push(observation) })
    const service = getAttentionService()
    service.observeTurnFailed('worker-session', 'HTTP 400 native_context_unavailable')
    service.observeTurnSucceeded('worker-session')
    expect(forwarded).toEqual([
      { kind: 'turn_failed', detail: 'HTTP 400 native_context_unavailable' },
      { kind: 'turn_succeeded', detail: 'turn' },
    ])
    configure()
  })

  it('gateway routes a worker turn_failed IPC observation into the attention service', async () => {
    const { EventEmitter } = await import('node:events')
    const { SessionWorkerManager } = await import('./worker/manager.js')
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    })
    const workerManager = new SessionWorkerManager({
      db: () => getDatabase(),
      config,
      sessionManager: { setRunning: () => {} } as never,
      isEnabled: () => true,
      broadcastForSession: () => {},
      processSupervisor: { spawnWorker: () => child } as never,
    })
    const session = manager.createSession(projectId, 'Worker session')
    workerManager.launch(session.id, () => {})
    const token = workerManager.activeWorker(session.id)!.token
    child.emit('message', {
      ...token,
      type: 'attention.observation',
      kind: 'turn_failed',
      detail: 'HTTP 429 rate_limit_exceeded',
    })
    const required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({
      sessionId: session.id,
      reason: 'turn_failed',
      detail: 'HTTP 429 rate_limit_exceeded',
    })
    child.emit('message', { ...token, type: 'attention.observation', kind: 'turn_succeeded', detail: 'turn' })
    const cleared = attentionEvents(session.id, 'session.attention_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ sessionId: session.id, reason: 'turn_failed' })
  })

  // R-4 (Astra B1/B2): the turn_failed detail is a whitelisted token (HTTP status +
  // structured code), never raw error text; no secret may reach the persisted event,
  // the IPC observation or the Aether message; the message is capped at 800 BYTES by
  // truncating the title, never the error detail.
  it('R-4 detail is whitelisted, no secret leaks, message capped at 800 bytes', async () => {
    const RAW_ERROR =
      'LLM request failed: HTTP 401 Bad Request: {"error":{"message":"Invalid API key provided: Bearer sk-fake-1234567890 (api_key=SECRET123)","type":"invalid_request_error","code":"invalid_api_key"}}'

    // Worker side: the forwarded observation carries the whitelisted detail only.
    const forwarded: import('./attention.js').AttentionObservation[] = []
    configureAttentionService({ forward: (observation) => forwarded.push(observation) })
    getAttentionService().observeTurnFailed('worker-session', RAW_ERROR)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]!.detail).toBe('HTTP 401 invalid_api_key')

    // Main side: orchestrator failure with a long multi-byte title.
    const notifySpy = vi.fn(async (_params: import('./attention.js').AttentionNotifyParams) => {})
    notify = notifySpy
    configure()
    const longTitle = 'Dépannage 🔥 très long '.repeat(40)
    const session = manager.createSession(projectId, longTitle)
    appendUserMessage(session.id, 'Run the thing.')

    await runChatTurn({
      sessionManager: manager,
      sessionId: session.id,
      llmClient: scriptedClient([{ error: RAW_ERROR }]) as never,
      llmRetryPolicy: { maxAttempts: 2, maxDurationMs: 60_000, backoffMs: [1], minIntervalMs: 1 },
    })

    const required = attentionEvents(session.id, 'session.attention_required')
    expect(required).toHaveLength(1)
    const persisted = JSON.stringify(required)
    expect(persisted).toContain('HTTP 401')
    expect(persisted).toContain('invalid_api_key')
    expect(persisted).not.toContain('sk-fake-1234567890')
    expect(persisted).not.toContain('SECRET123')
    expect(persisted).not.toContain('Invalid API key')

    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))

    // The rendered Aether payload keeps the error core, truncates the title,
    // drops the raw text, and stays under 800 bytes.
    const rendered = formatAttentionMessage(notifySpy.mock.calls[0]![0]!)
    expect(rendered).toContain('TOUR EN ÉCHEC')
    expect(rendered).toContain('HTTP 401')
    expect(rendered).toContain('invalid_api_key')
    expect(rendered).not.toContain('sk-fake-1234567890')
    expect(rendered).not.toContain('SECRET123')
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(800)
    configure()
  })
})
