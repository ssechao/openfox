import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, Provider } from '../../shared/types.js'
import { loadConfig } from '../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject, updateProject } from '../db/projects.js'
import { getEventStore, initEventStore } from '../events/index.js'
import { SessionManager } from '../session/manager.js'
import { createTasksService, type LaunchRequest, type LaunchSpec, type TasksService } from './service.js'

const execFileAsync = promisify(execFile)

function testProvider(id: string, model: string): Provider {
  return {
    id,
    name: id,
    url: 'http://localhost:8000/v1',
    backend: 'openai',
    models: [{ id: model, contextWindow: 32_000, source: 'user' }],
    isActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function errorField(reason: unknown, field: 'code' | 'admission'): string | null {
  if (typeof reason !== 'object' || reason === null) return null
  const value = (reason as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('manager task launch workspace integration', () => {
  let root: string
  let projectDir: string
  let workspacesDir: string
  let configDir: string
  let projectId: string
  let config: Config
  let manager: SessionManager
  let service: TasksService
  let requesterSessionId: string
  let agentPath: string
  let workflowObservations: Array<{
    workspace: string | null
    branch: string | null
    reminderTypes: string[]
  }>

  const providerManager = () =>
    ({
      getCurrentModelContext: () => 32_000,
      getProviders: () => config.providers ?? [],
      getDefaultModelSelection: () => config.defaultModelSelection,
      getCurrentModel: () => 'fallback-model',
      getActiveProviderId: () => 'fallback-provider',
      resolveModelEffort: () => undefined,
      getModelSettings: () => undefined,
    }) as unknown as ConstructorParameters<typeof SessionManager>[0]

  const reminderTypes = (sessionId: string) =>
    getEventStore()
      .getEvents(sessionId)
      .flatMap((event) => {
        if (event.type !== 'message.start') return []
        const data = event.data as { metadata?: { type: string } }
        return data.metadata ? [data.metadata.type] : []
      })

  const requestFor = (taskId: string, suffix: string, overrides: Partial<LaunchRequest> = {}): LaunchRequest => ({
    requesterSessionId,
    projectId,
    taskId,
    agentId: 'agent-exact',
    providerId: 'provider-exact',
    model: 'model-exact',
    workspace: `launch-${suffix}`,
    branch: `feature/${suffix}`,
    sourceBranch: 'main',
    ...overrides,
  })

  const persistLaunchSpec = (spec: LaunchSpec) => {
    getDatabase()
      .prepare(
        `UPDATE tasks
         SET agent_id = ?, provider_id = ?, model = ?, workspace = ?, branch = ?, source_branch = ?, launched_by = ?
         WHERE id = ?`,
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

  const prepareLaunchTask = async (prompt: string, suffix: string, overrides: Partial<LaunchRequest> = {}) => {
    const task = service.create(projectId, { prompt }, { actor: 'human' })
    const request = requestFor(task.id, suffix, overrides)
    const validation = await service.validateLaunch(request)
    if (!validation.ok) throw new Error(`Launch prevalidation failed: ${validation.code}`)
    persistLaunchSpec(validation.spec)
    return { taskId: task.id, spec: validation.spec }
  }

  const waitForBranch = async (sessionId: string, branch: string) => {
    await vi.waitFor(() => expect(manager.getSession(sessionId)?.branch).toBe(branch))
  }

  const prepareWorkspace = async (name: string, branch: string, sentinel: string) => {
    const session = manager.createSession(projectId, `workspace fixture ${name}`)
    await waitForBranch(session.id, 'main')
    await manager.switchWorkspace(session.id, name, branch, 'main')
    const workspace = manager.getSession(session.id)?.workspace
    if (!workspace) throw new Error(`Workspace ${name} was not assigned`)
    const sentinelPath = join(workspace, 'workspace-sentinel.txt')
    await writeFile(sentinelPath, sentinel)
    await manager.switchWorkspace(session.id, 'original')
    return { sessionId: session.id, workspace, sentinelPath }
  }

  const installCheckoutBarrier = async (workspace: string, label: string) => {
    const entered = join(root, `${label}.entered`)
    const release = join(root, `${label}.release`)
    await rm(entered, { force: true })
    await rm(release, { force: true })
    const hookPath = join(workspace, '.git', 'hooks', 'post-checkout')
    const hook = `#!/usr/bin/env node
const fs = require('node:fs')
const entered = ${JSON.stringify(entered)}
const release = ${JSON.stringify(release)}
fs.writeFileSync(entered, 'entered')
const timer = setInterval(() => {
  if (fs.existsSync(release)) {
    clearInterval(timer)
    process.exit(0)
  }
}, 5)
`
    await writeFile(hookPath, hook)
    await chmod(hookPath, 0o755)
    return { entered, release }
  }

  const waitForBarrierOrSettlement = async (
    promise: Promise<unknown>,
    entered: string,
  ): Promise<'entered' | 'settled'> =>
    Promise.race([
      vi
        .waitFor(
          async () => {
            await access(entered)
          },
          { timeout: 10_000, interval: 10 },
        )
        .then(() => 'entered' as const),
      promise.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
    ])

  const runOrderedBarrierRace = async (
    first: () => Promise<unknown>,
    firstBarrier: { entered: string; release: string },
    second: () => Promise<unknown>,
    secondBarrier: { entered: string; release: string },
  ) => {
    const firstPromise = first()
    const firstState = await waitForBarrierOrSettlement(firstPromise, firstBarrier.entered)
    const secondPromise = second()
    if (firstState === 'entered') await writeFile(firstBarrier.release, 'release')
    const secondState = await waitForBarrierOrSettlement(secondPromise, secondBarrier.entered)
    if (secondState === 'entered') await writeFile(secondBarrier.release, 'release')
    return Promise.allSettled([firstPromise, secondPromise])
  }

  const settledSummary = (settled: PromiseSettledResult<unknown>[]) => ({
    successes: settled.filter((result) => result.status === 'fulfilled').length,
    codes: settled
      .flatMap((result) => (result.status === 'rejected' ? [errorField(result.reason, 'code')] : []))
      .filter((code): code is string => code !== null)
      .sort(),
  })

  beforeEach(async () => {
    closeDatabase()
    root = await mkdtemp(join(tmpdir(), 'openfox-launch-workspace-'))
    projectDir = join(root, 'project')
    workspacesDir = join(root, 'workspaces')
    configDir = join(root, 'config')
    await mkdir(projectDir, { recursive: true })
    await mkdir(workspacesDir, { recursive: true })
    await mkdir(join(projectDir, '.openfox', 'agents'), { recursive: true })
    await mkdir(join(configDir, 'workflows'), { recursive: true })

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.email', 'tests@openfox.local'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.name', 'OpenFox Tests'], { cwd: projectDir })
    await writeFile(join(projectDir, 'README.md'), 'fixture\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: projectDir })

    agentPath = join(projectDir, '.openfox', 'agents', 'agent-exact.agent.md')
    await writeFile(
      agentPath,
      '---\nid: agent-exact\nname: Agent Exact\ndescription: Fixture agent\nallowedTools: []\n---\n\nExact fixture agent.\n',
    )
    await writeFile(
      join(configDir, 'workflows', 'seed.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'seed',
          name: 'Seed',
          description: 'Seed fixture',
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
      { ...testProvider('provider-exact', 'model-exact'), isActive: true },
      testProvider('fallback-provider', 'fallback-model'),
    ]
    config.defaultModelSelection = 'fallback-provider/fallback-model'
    initDatabase(config)
    initEventStore(getDatabase())

    projectId = createProject('Launch Workspace', projectDir).id
    updateProject(projectId, { workspaceRootDir: workspacesDir })
    manager = new SessionManager(providerManager())
    const requester = manager.createSession(projectId, 'Manager requester', 'fallback-provider', 'fallback-model')
    requesterSessionId = requester.id
    manager.setMode(requesterSessionId, 'manager')
    await waitForBranch(requesterSessionId, 'main')

    workflowObservations = []
    service = createTasksService({
      sessionManager: manager,
      config,
      broadcast: () => undefined,
      configDir,
      launchWorkflow: (sessionId) => {
        const session = manager.getSession(sessionId)
        workflowObservations.push({
          workspace: session?.workspace ?? null,
          branch: session?.branch ?? null,
          reminderTypes: reminderTypes(sessionId),
        })
        return 'started'
      },
    })
    await service.setSettings(projectId, { slotLimit: 50 })
  })

  afterEach(async () => {
    await vi.waitFor(() => {
      const sessionsWithoutBranch = manager
        .listSessions()
        .filter((summary) => manager.getSession(summary.id)?.branch === undefined)
      expect(sessionsWithoutBranch).toEqual([])
    })
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it.fails(
    'serializes task launch and workspace switch on the same project branch',
    async () => {
      const runScenario = async (suffix: string, first: 'launch' | 'switch') => {
        const launchTarget = await prepareWorkspace(
          `launch-target-${suffix}`,
          `fixture/launch-base-${suffix}`,
          `launch-${suffix}`,
        )
        const switchTarget = await prepareWorkspace(
          `switch-target-${suffix}`,
          `fixture/switch-base-${suffix}`,
          `switch-${suffix}`,
        )
        const launchBarrier = await installCheckoutBarrier(launchTarget.workspace, `launch-${suffix}`)
        const switchBarrier = await installCheckoutBarrier(switchTarget.workspace, `switch-${suffix}`)
        const branch = `feature/shared-${suffix}`
        const task = await prepareLaunchTask(`launch ${suffix}`, suffix, {
          workspace: `launch-target-${suffix}`,
          branch,
        })
        const launch = () =>
          service.move(projectId, task.taskId, 'in_progress', {
            actor: 'human',
          })
        const switchWorkspace = () =>
          manager.switchWorkspace(switchTarget.sessionId, `switch-target-${suffix}`, branch, 'main')
        const settled =
          first === 'launch'
            ? await runOrderedBarrierRace(launch, launchBarrier, switchWorkspace, switchBarrier)
            : await runOrderedBarrierRace(switchWorkspace, switchBarrier, launch, launchBarrier)
        return {
          ...settledSummary(settled),
          launchSentinel: await readFile(launchTarget.sentinelPath, 'utf8'),
          switchSentinel: await readFile(switchTarget.sentinelPath, 'utf8'),
        }
      }

      expect([await runScenario('launch-first', 'launch'), await runScenario('switch-first', 'switch')]).toEqual([
        {
          successes: 1,
          codes: ['BRANCH_IN_USE'],
          launchSentinel: 'launch-launch-first',
          switchSentinel: 'switch-launch-first',
        },
        {
          successes: 1,
          codes: ['BRANCH_IN_USE'],
          launchSentinel: 'launch-switch-first',
          switchSentinel: 'switch-switch-first',
        },
      ])
    },
    60_000,
  )

  it.fails(
    'serializes task launch and workspace deletion on the same project workspace',
    async () => {
      const runScenario = async (suffix: string, first: 'launch' | 'delete') => {
        const targetName = `delete-target-${suffix}`
        const target = await prepareWorkspace(targetName, `fixture/delete-base-${suffix}`, `delete-${suffix}`)
        const task = await prepareLaunchTask(`delete race ${suffix}`, `delete-${suffix}`, {
          workspace: targetName,
          branch: `feature/delete-${suffix}`,
        })
        const launch = () => service.move(projectId, task.taskId, 'in_progress', { actor: 'human' })
        const deleteWorkspace = () => manager.deleteWorkspace(target.sessionId, targetName)
        let settled: PromiseSettledResult<unknown>[]

        if (first === 'launch') {
          const launchBarrier = await installCheckoutBarrier(target.workspace, `delete-launch-${suffix}`)
          const launchPromise = launch()
          const launchState = await waitForBarrierOrSettlement(launchPromise, launchBarrier.entered)
          const deletePromise = deleteWorkspace()
          if (launchState === 'entered') await writeFile(launchBarrier.release, 'release')
          settled = await Promise.allSettled([launchPromise, deletePromise])
        } else {
          const bulkDir = join(target.workspace, 'bulk')
          await mkdir(bulkDir)
          await Promise.all(Array.from({ length: 2_000 }, (_, index) => writeFile(join(bulkDir, `${index}.txt`), 'x')))
          const deletePromise = deleteWorkspace()
          const launchPromise = launch()
          settled = await Promise.allSettled([deletePromise, launchPromise])
        }

        const exists = await pathExists(target.workspace)
        const sessionsUsingTarget = manager.listSessions().flatMap((summary) => {
          const session = manager.getSession(summary.id)
          return session?.workspace === target.workspace ? [session.id] : []
        })
        return {
          ...settledSummary(settled),
          exists,
          sentinel: exists ? await readFile(target.sentinelPath, 'utf8') : null,
          unsafeDeleted: sessionsUsingTarget.length > 0 && !exists,
        }
      }

      expect([await runScenario('launch-first', 'launch'), await runScenario('delete-first', 'delete')]).toEqual([
        {
          successes: 1,
          codes: ['WORKSPACE_IN_USE'],
          exists: true,
          sentinel: 'delete-launch-first',
          unsafeDeleted: false,
        },
        {
          successes: 1,
          codes: ['WORKSPACE_BEING_DELETED'],
          exists: false,
          sentinel: null,
          unsafeDeleted: false,
        },
      ])
    },
    60_000,
  )

  it.fails('applies the launch workspace and branch before the first task message or workflow', async () => {
    const plain = await prepareLaunchTask('plain task prompt', 'plain')
    const plainResult = await service.move(projectId, plain.taskId, 'in_progress', { actor: 'human' })
    const plainSessionId = plainResult.sessionId
    if (!plainSessionId) throw new Error('Plain launch did not return a session')
    const plainSession = manager.getSession(plainSessionId)

    const workflow = await prepareLaunchTask('/seed', 'workflow')
    const workflowResult = await service.move(projectId, workflow.taskId, 'in_progress', { actor: 'human' })
    const workflowSessionId = workflowResult.sessionId
    if (!workflowSessionId) throw new Error('Workflow launch did not return a session')
    const workflowSession = manager.getSession(workflowSessionId)

    expect({
      plain: {
        workspace: plainSession?.workspace ?? null,
        branch: plainSession?.branch ?? null,
        reminderTypes: reminderTypes(plainSessionId),
        queuedPrompt: manager.getQueueState(plainSessionId)[0]?.content ?? null,
      },
      workflow: {
        workspace: workflowSession?.workspace ?? null,
        branch: workflowSession?.branch ?? null,
        reminderTypes: reminderTypes(workflowSessionId),
        observation: workflowObservations[0] ?? null,
      },
    }).toEqual({
      plain: {
        workspace: join(workspacesDir, 'launch-plain'),
        branch: 'feature/plain',
        reminderTypes: ['workspace', 'task'],
        queuedPrompt: 'plain task prompt',
      },
      workflow: {
        workspace: join(workspacesDir, 'launch-workflow'),
        branch: 'feature/workflow',
        reminderTypes: ['workspace', 'task'],
        observation: {
          workspace: join(workspacesDir, 'launch-workflow'),
          branch: 'feature/workflow',
          reminderTypes: ['workspace'],
        },
      },
    })
  })

  it.fails('preserves exact manager launch selections and rejects stale selections without fallback', async () => {
    const valid = await prepareLaunchTask('valid exact launch', 'valid')
    const validResult = await service.move(projectId, valid.taskId, 'in_progress', { actor: 'human' })
    const validSession = validResult.sessionId ? manager.getSession(validResult.sessionId) : null

    const staleOutcomes: Array<Record<string, unknown>> = []
    for (const kind of ['agent', 'provider', 'model'] as const) {
      const task = await prepareLaunchTask(`stale ${kind}`, `stale-${kind}`)
      const beforeIds = new Set(manager.listSessions().map((session) => session.id))
      const originalProviders = config.providers
      if (kind === 'agent') await rm(agentPath)
      if (kind === 'provider') {
        config.providers = (config.providers ?? []).filter((provider) => provider.id !== 'provider-exact')
      }
      if (kind === 'model') {
        config.providers = (config.providers ?? []).map((provider) =>
          provider.id === 'provider-exact' ? { ...provider, models: [] } : provider,
        )
      }

      let reason: unknown = null
      try {
        await service.move(projectId, task.taskId, 'in_progress', { actor: 'human' })
      } catch (error) {
        reason = error
      } finally {
        config.providers = originalProviders
        if (kind === 'agent') {
          await writeFile(
            agentPath,
            '---\nid: agent-exact\nname: Agent Exact\ndescription: Fixture agent\nallowedTools: []\n---\n\nExact fixture agent.\n',
          )
        }
      }

      const current = service.get(projectId, task.taskId)
      staleOutcomes.push({
        kind,
        code: errorField(reason, 'code'),
        admission: errorField(reason, 'admission'),
        status: current?.status ?? null,
        runState: current?.runState ?? null,
        activeSessionId: current?.activeSessionId ?? null,
        newSessionIds: manager
          .listSessions()
          .map((session) => session.id)
          .filter((sessionId) => !beforeIds.has(sessionId))
          .sort(),
      })
    }

    expect({
      valid: {
        mode: validSession?.mode ?? null,
        providerId: validSession?.providerId ?? null,
        model: validSession?.providerModel ?? null,
      },
      staleOutcomes,
    }).toEqual({
      valid: {
        mode: 'agent-exact',
        providerId: 'provider-exact',
        model: 'model-exact',
      },
      staleOutcomes: ['agent', 'provider', 'model'].map((kind) => ({
        kind,
        code: 'WORKER_ADMISSION_REFUSED',
        admission: 'start_failed',
        status: 'todo',
        runState: null,
        activeSessionId: null,
        newSessionIds: [],
      })),
    })
  })
})
