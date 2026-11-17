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
import { initEventStore, getEventStore } from '../events/index.js'
import { logger } from '../utils/logger.js'
import { SessionManager } from './manager.js'
import { provideAnswer, registerPendingQuestion } from '../tools/ask.js'
import {
  configureAttentionService,
  createAetherNotifier,
  getAttentionService,
  resetAttentionService,
  type CallToolFn,
} from './attention.js'
import { createTasksService, type TasksService } from '../tasks/service.js'
import { createOpenFoxMcpTools } from '../mcp/server/tools.js'
import type { OpenFoxMcpToolDeps } from '../mcp/server/types.js'

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

  it.fails('blocked session emits attention_required once', () => {
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

  it.fails('waiting session without wake emits attention_required after the delay', () => {
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

  it.fails('attention_required notifies the creator pilot through Aether', async () => {
    const calls: Array<{
      serverName: string
      toolName: string
      args: Record<string, unknown>
      sessionId: string | undefined
    }> = []
    const callTool: CallToolFn = async (serverName, toolName, args, sessionId) => {
      calls.push({ serverName, toolName, args, sessionId })
      if (toolName === 'ht_get_contact_info') {
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
      toolName: 'ht_get_contact_info',
      sessionId: 'session-creator',
    })
    expect(calls[1]).toMatchObject({
      serverName: 'mcp-lazy',
      toolName: 'ht_send_to_peer',
      sessionId: 'session-stalled',
      args: { peer_id: 'peer-creator-42' },
    })
    const message = String((calls[1]!.args as Record<string, unknown>)['message'])
    expect(message).toContain('SESSION BLOQUÉE')
    expect(message).toContain('Worker run')
    expect(message).toContain('session-stalled')
    expect(message).toContain('native_context_unavailable')

    // No proven creator: the event stands alone, no channel is attempted.
    calls.length = 0
    await notifyCreator({ ...params, createdBy: null })
    expect(calls).toHaveLength(0)

    // A failed contact lookup is an explicit logged failure, no fallback channel.
    calls.length = 0
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const failing: CallToolFn = async () => ({ success: false, error: 'no hub session established yet' })
    await createAetherNotifier(failing)(params)
    const logged = errorLog.mock.calls.flat().map(String).join(' ')
    errorLog.mockRestore()
    expect(logged).toContain('attention_notify_failed')
    expect(calls).toHaveLength(0)
  })

  it.fails('session creator is recorded only from a proven identity', async () => {
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
    const created = new Map<string, { createdBy: string | null }>()
    const issued = new Set<string>()
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
      verifyCallerIdentity: (input: {
        callerSessionId: string
        proof: unknown
        toolName: string
        targetSessionId: string
      }) =>
        typeof input.proof === 'string' && issued.has(input.proof)
          ? { ok: true as const, callerSessionId: input.callerSessionId }
          : { ok: false as const, error: 'trusted OpenFox caller identity is required' },
    } as unknown as OpenFoxMcpToolDeps
    const tools = createOpenFoxMcpTools(deps)
    const createTool = tools.find((tool) => tool.name === 'openfox_create_session')
    expect(createTool).toBeDefined()

    // The host injects a proof only for a caller it observed itself.
    issued.add('proof-1')
    await createTool!.handler({
      projectId,
      title: 'Proven child',
      openfox_session_id: 'caller-1',
      openfox_session_proof: 'proof-1',
    })
    expect([...created.values()]).toEqual([{ createdBy: 'caller-1' }])

    // A model-declared (unproven) session id must not be trusted.
    await createTool!.handler({ projectId, title: 'Forged child', openfox_session_id: 'caller-1' })
    expect([...created.values()]).toEqual([{ createdBy: 'caller-1' }, { createdBy: null }])

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
})
