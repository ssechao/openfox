import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config, ProjectTask, Provider } from '../../shared/types.js'
import { loadConfig } from '../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject, updateProject } from '../db/projects.js'
import { initEventStore } from '../events/index.js'
import { SessionManager } from '../session/manager.js'
import { SessionTurnScheduler, type AdmissionResult } from '../session/worker/scheduler.js'
import { projectTasksTool, setTasksService } from '../tools/project-tasks.js'
import type { ToolContext } from '../tools/types.js'
import { createTasksService, type LaunchRequest, type LaunchSpec, type TasksService } from './service.js'

const execFileAsync = promisify(execFile)

type Scenario = 'started' | 'waiting' | 'full' | 'closed' | 'start_failed'
type LaunchPath = 'manager' | 'human'

interface LaunchContract {
  runState: 'running' | 'queued'
  sessionId: string | null
  position?: number
  version: number
}

function testProvider(id: string, model: string, active = false): Provider {
  return {
    id,
    name: id,
    url: 'http://localhost:8000/v1',
    backend: 'openai',
    models: [{ id: model, contextWindow: 32_000, source: 'user' }],
    isActive: active,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const value = (error as { code?: unknown }).code
  return typeof value === 'string' ? value : null
}

describe('manager task launch', () => {
  let root: string
  let projectDir: string
  let configDir: string
  let config: Config
  let manager: SessionManager
  let service: TasksService
  let requesterSessionId: string
  let admissionMode: Exclude<Scenario, 'closed' | 'start_failed'> | null
  let preflightClosed: boolean
  let admissionRecords: AdmissionResult[]
  let admissionSequence: number

  const providerManager = () =>
    ({
      getCurrentModelContext: () => 32_000,
      getProviders: () => config.providers ?? [],
      getDefaultModelSelection: () => config.defaultModelSelection,
      getCurrentModel: () => 'model-default',
      getActiveProviderId: () => 'provider-default',
      resolveModelEffort: () => undefined,
      getModelSettings: () => undefined,
    }) as unknown as ConstructorParameters<typeof SessionManager>[0]

  const waitForBranch = async (sessionId: string, branch: string) => {
    await expect.poll(() => manager.getSession(sessionId)?.branch).toBe(branch)
  }

  const targetProject = async (label: string) => {
    const projectId = createProject('Manager Launch ' + label, projectDir).id
    updateProject(projectId, { workspaceRootDir: join(root, 'workspaces', label) })
    await service.setSettings(projectId, { slotLimit: 50 })
    return projectId
  }

  const requestFor = (
    projectId: string,
    taskId: string,
    suffix: string,
    expectedVersion?: number,
  ): LaunchRequest & { expectedVersion?: number } => ({
    requesterSessionId,
    projectId,
    taskId,
    agentId: 'agent-explicit',
    providerId: 'provider-explicit',
    model: 'model-explicit',
    workspace: 'workspace-' + suffix,
    branch: 'feature/' + suffix,
    sourceBranch: 'main',
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  })

  const persistSpec = (spec: LaunchSpec) => {
    getDatabase()
      .prepare(
        'UPDATE tasks SET agent_id = ?, provider_id = ?, model = ?, workspace = ?, branch = ?, source_branch = ?, launched_by = ? WHERE id = ?',
      )
      .run(
        spec.agentId,
        spec.providerId,
        spec.model,
        spec.workspace,
        spec.branch,
        spec.sourceBranch,
        spec.launchedBy,
        spec.taskId,
      )
  }

  const prepareHumanTask = async (projectId: string, prompt: string, suffix: string) => {
    const task = service.create(projectId, { prompt }, { actor: 'human' })
    const validation = await service.validateLaunch(requestFor(projectId, task.id, suffix))
    if (!validation.ok) throw new Error('Launch prevalidation failed: ' + validation.code)
    persistSpec(validation.spec)
    return { task, spec: validation.spec }
  }

  const managerContext = (): ToolContext => {
    const requester = manager.getSession(requesterSessionId)
    if (!requester) throw new Error('Manager requester not found')
    return {
      workdir: projectDir,
      sessionId: requesterSessionId,
      projectId: requester.projectId,
      sessionManager: manager,
    }
  }

  const executeManagerLaunch = async (
    projectId: string,
    task: ProjectTask,
    suffix: string,
    expectedVersion = task.version,
  ) =>
    projectTasksTool.execute(
      {
        action: 'launch',
        ...requestFor(projectId, task.id, suffix, expectedVersion),
      },
      managerContext(),
    )

  const admit = (sessionId: string): AdmissionResult => {
    if (!admissionMode) return 'started'
    const scheduler = new SessionTurnScheduler({
      maxConcurrent: 1,
      maxWaitingSessions: admissionMode === 'full' ? 0 : 1,
    })
    if (admissionMode !== 'started') {
      const holder = scheduler.admit('holder-' + ++admissionSequence, () => undefined)
      if (holder !== 'started') throw new Error('Holder was not started: ' + holder)
    }
    const admission = scheduler.admit(sessionId, () => undefined)
    admissionRecords.push(admission)
    return admission
  }

  const configureScenario = (scenario: Scenario) => {
    admissionRecords = []
    admissionMode = scenario === 'started' || scenario === 'waiting' || scenario === 'full' ? scenario : null
    preflightClosed = scenario === 'closed'
  }

  const holdBranch = async (projectId: string, suffix: string) => {
    const blocker = manager.createSession(projectId, 'Block ' + suffix, 'provider-default', 'model-default')
    await waitForBranch(blocker.id, 'main')
    await manager.switchWorkspace(blocker.id, 'blocker-' + suffix, 'feature/' + suffix, 'main')
  }

  const summarizeTask = (task: ProjectTask | null) => ({
    status: task?.status ?? null,
    runState: task?.runState ?? null,
    active: task?.activeSessionId !== undefined,
    links: task?.sessionIds.length ?? 0,
    spec:
      Boolean(task?.agentId) &&
      Boolean(task?.providerId) &&
      Boolean(task?.model) &&
      Boolean(task?.workspace) &&
      Boolean(task?.branch) &&
      Boolean(task?.sourceBranch) &&
      Boolean(task?.launchedBy),
  })

  const summarizeSession = (task: ProjectTask | null, spec: Pick<LaunchRequest, 'workspace' | 'branch'>) => {
    const session = task?.activeSessionId ? manager.getSession(task.activeSessionId) : null
    if (!session) return null
    return {
      mode: session.mode,
      providerId: session.providerId,
      model: session.providerModel,
      workspace: session.workspace?.endsWith('/' + spec.workspace) ?? false,
      branch: session.branch,
    }
  }

  const contractFromHuman = (
    result: Awaited<ReturnType<TasksService['move']>> | null,
  ): LaunchContract | 'start_failed' => {
    if (!result) return 'start_failed'
    return {
      runState: result.task.runState === 'queued' ? 'queued' : 'running',
      sessionId: result.sessionId ?? null,
      ...(result.queued ? { position: result.queued.position } : {}),
      version: result.task.version,
    }
  }

  const contractFromTool = (
    result: Awaited<ReturnType<typeof projectTasksTool.execute>>,
  ): LaunchContract | 'start_failed' => {
    if (!result.success || !result.output) return 'start_failed'
    return JSON.parse(result.output) as LaunchContract
  }

  const runPath = async (path: LaunchPath, projectId: string, prompt: string, suffix: string) => {
    const prepared =
      path === 'manager'
        ? {
            task: service.create(projectId, { prompt }, { actor: 'human' }),
            spec: requestFor(projectId, '', suffix),
          }
        : await prepareHumanTask(projectId, prompt, suffix)
    if (path === 'manager') prepared.spec.taskId = prepared.task.id
    const beforeSessionIds = new Set(manager.listSessions().map((session) => session.id))
    admissionRecords = []
    let contract: LaunchContract | 'start_failed'
    let failureCode: string | null = null
    if (path === 'manager') {
      const result = await executeManagerLaunch(projectId, prepared.task, suffix)
      contract = contractFromTool(result)
      failureCode = result.success ? null : (result.error ?? null)
    } else {
      let result: Awaited<ReturnType<TasksService['move']>> | null = null
      try {
        result = await service.move(projectId, prepared.task.id, 'in_progress', { actor: 'human' })
      } catch (error) {
        failureCode = errorCode(error)
      }
      contract = contractFromHuman(result)
    }
    const task = service.get(projectId, prepared.task.id)
    const freshSessions = manager
      .listSessions()
      .map((session) => session.id)
      .filter((sessionId) => !beforeSessionIds.has(sessionId))
    return {
      contract:
        contract === 'start_failed'
          ? contract
          : {
              runState: contract.runState,
              sessionId: contract.sessionId === null ? null : 'present',
              position: contract.position === undefined ? null : 'present',
              version: typeof contract.version,
            },
      failure: contract === 'start_failed' ? (failureCode ? 'present' : null) : null,
      task: summarizeTask(task),
      session: summarizeSession(task, prepared.spec),
      freshSessions: freshSessions.length,
      admission: admissionRecords[0] ?? null,
    }
  }

  const expectedPath = (scenario: Scenario, path: LaunchPath) => {
    if (scenario === 'started' || scenario === 'waiting') {
      return {
        contract: { runState: 'running', sessionId: 'present', position: null, version: 'number' },
        failure: null,
        task: { status: 'in_progress', runState: 'running', active: true, links: 1, spec: true },
        session: {
          mode: 'agent-explicit',
          providerId: 'provider-explicit',
          model: 'model-explicit',
          workspace: true,
          branch: expect.stringMatching(/^feature\//),
        },
        freshSessions: 1,
        admission: scenario,
      }
    }
    if (scenario === 'full' || scenario === 'closed') {
      return {
        contract: { runState: 'queued', sessionId: null, position: 'present', version: 'number' },
        failure: null,
        task: { status: 'in_progress', runState: 'queued', active: false, links: 0, spec: true },
        session: null,
        freshSessions: 0,
        admission: scenario === 'full' ? 'full' : null,
      }
    }
    return {
      contract: 'start_failed',
      failure: 'present',
      task: {
        status: 'todo',
        runState: null,
        active: false,
        links: 0,
        spec: path === 'human',
      },
      session: null,
      freshSessions: 0,
      admission: null,
    }
  }

  const expectParity = async (prompt: string, label: string) => {
    const observed = []
    for (const scenario of ['started', 'waiting', 'full', 'closed', 'start_failed'] as const) {
      configureScenario(scenario)
      const managerProjectId = await targetProject(label + '-' + scenario + '-manager')
      const humanProjectId = await targetProject(label + '-' + scenario + '-human')
      const managerSuffix = label + '-' + scenario + '-manager'
      const humanSuffix = label + '-' + scenario + '-human'
      if (scenario === 'start_failed') {
        await holdBranch(managerProjectId, managerSuffix)
        await holdBranch(humanProjectId, humanSuffix)
      }
      const managerResult = await runPath('manager', managerProjectId, prompt, managerSuffix)
      configureScenario(scenario)
      const humanResult = await runPath('human', humanProjectId, prompt, humanSuffix)
      observed.push({ scenario, manager: managerResult, human: humanResult })
    }

    expect(observed).toEqual(
      (['started', 'waiting', 'full', 'closed', 'start_failed'] as const).map((scenario) => ({
        scenario,
        manager: expectedPath(scenario, 'manager'),
        human: expectedPath(scenario, 'human'),
      })),
    )
  }

  beforeEach(async () => {
    closeDatabase()
    root = await mkdtemp(join(tmpdir(), 'openfox-manager-launch-'))
    projectDir = join(root, 'project')
    configDir = join(root, 'config')
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(projectDir, '.openfox', 'agents'), { recursive: true })
    await mkdir(join(configDir, 'workflows'), { recursive: true })
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.email', 'tests@openfox.local'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.name', 'OpenFox Tests'], { cwd: projectDir })
    await writeFile(join(projectDir, 'README.md'), 'fixture\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: projectDir })
    await writeFile(
      join(projectDir, '.openfox', 'agents', 'agent-explicit.agent.md'),
      '---\nid: agent-explicit\nname: Agent Explicit\ndescription: Explicit launch agent\nallowedTools: []\n---\n\nExplicit launch agent.\n',
    )
    await writeFile(
      join(configDir, 'workflows', 'default.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'default',
          name: 'Default',
          description: 'Default launch workflow',
          version: '1.0.0',
          parameters: [],
        },
        entryStep: 'run',
        settings: { maxIterations: 1 },
        steps: [
          {
            id: 'run',
            name: 'Run',
            type: 'agent',
            phase: 'build',
            prompt: 'Run',
            transitions: [{ when: { type: 'always' }, goto: '$done' }],
          },
        ],
        startCondition: { type: 'always' },
      }),
    )

    config = loadConfig()
    config.database.path = join(root, 'sessions.db')
    config.providers = [
      testProvider('provider-default', 'model-default', true),
      testProvider('provider-explicit', 'model-explicit'),
    ]
    config.defaultModelSelection = 'provider-default/model-default'
    config.defaultAgent = 'planner'
    initDatabase(config)
    initEventStore(getDatabase())
    manager = new SessionManager(providerManager())
    const requesterProjectId = createProject('Manager Requester', projectDir).id
    updateProject(requesterProjectId, { workspaceRootDir: join(root, 'workspaces', 'requester') })
    const requester = manager.createSession(
      requesterProjectId,
      'Manager requester',
      'provider-default',
      'model-default',
    )
    requesterSessionId = requester.id
    manager.setMode(requesterSessionId, 'manager')
    await waitForBranch(requesterSessionId, 'main')

    admissionMode = null
    preflightClosed = false
    admissionRecords = []
    admissionSequence = 0
    manager.setQueueAdmissionGuard((sessionId) => {
      const admission = admit(sessionId)
      return admission === 'started' || admission === 'waiting'
    })
    service = createTasksService({
      sessionManager: manager,
      config,
      broadcast: () => undefined,
      configDir,
      canStartSession: (sessionId) => {
        if (!preflightClosed) return true
        const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 1 })
        scheduler.closeAdmissions()
        return scheduler.canAccept(sessionId)
      },
      launchWorkflow: (sessionId) => admit(sessionId),
    })
    setTasksService(service)
  })

  afterEach(async () => {
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it.fails(
    'manager launch matches human move admission for plain prompts',
    async () => {
      await expectParity('plain launch prompt', 'plain')
    },
    60_000,
  )

  it.fails(
    'manager launch matches human move admission for default workflows',
    async () => {
      await expectParity('/default', 'workflow')
    },
    60_000,
  )

  it.fails('late worker admission refusal queues without a session for manager and human launches', async () => {
    configureScenario('full')
    const managerProjectId = await targetProject('late-full-manager')
    const humanProjectId = await targetProject('late-full-human')
    const managerResult = await runPath('manager', managerProjectId, 'late refusal', 'late-full-manager')
    configureScenario('full')
    const humanResult = await runPath('human', humanProjectId, 'late refusal', 'late-full-human')

    expect({ manager: managerResult, human: humanResult }).toEqual({
      manager: expectedPath('full', 'manager'),
      human: expectedPath('full', 'human'),
    })
  })

  it.fails('manager launch preserves explicit selection and rejects stale versions atomically', async () => {
    configureScenario('started')
    const projectId = await targetProject('explicit-selection')
    const task = service.create(projectId, { prompt: 'exact selection' }, { actor: 'human' })
    const launched = await executeManagerLaunch(projectId, task, 'explicit-selection')
    const launchedContract = contractFromTool(launched)
    const current = service.get(projectId, task.id)
    const session = current?.activeSessionId ? manager.getSession(current.activeSessionId) : null

    const stale = service.create(projectId, { prompt: 'stale original' }, { actor: 'human' })
    const staleVersion = stale.version
    await service.update(projectId, stale.id, { prompt: 'stale changed' }, { actor: 'human' })
    const beforeTask = structuredClone(service.get(projectId, stale.id))
    const beforeSessions = manager.listSessions().map((candidate) => candidate.id)
    const staleResult = await executeManagerLaunch(projectId, stale, 'stale-version', staleVersion)

    expect({
      launched: launchedContract === 'start_failed' ? launchedContract : launchedContract.runState,
      selection: {
        mode: session?.mode ?? null,
        providerId: session?.providerId ?? null,
        model: session?.providerModel ?? null,
        workspace: session?.workspace?.endsWith('/workspace-explicit-selection') ?? false,
        branch: session?.branch ?? null,
      },
      defaults: {
        agent: config.defaultAgent,
        providerModel: config.defaultModelSelection,
      },
      stale: {
        success: staleResult.success,
        conflict: staleResult.error?.includes('CONFLICT') ?? false,
        taskUnchanged: service.get(projectId, stale.id),
        sessionsUnchanged: manager.listSessions().map((candidate) => candidate.id),
      },
    }).toEqual({
      launched: 'running',
      selection: {
        mode: 'agent-explicit',
        providerId: 'provider-explicit',
        model: 'model-explicit',
        workspace: true,
        branch: 'feature/explicit-selection',
      },
      defaults: {
        agent: 'planner',
        providerModel: 'provider-default/model-default',
      },
      stale: {
        success: false,
        conflict: true,
        taskUnchanged: beforeTask,
        sessionsUnchanged: beforeSessions,
      },
    })
  })
})
