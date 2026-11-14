import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { streamLLMPureMock, consumeStreamGeneratorMock } = vi.hoisted(() => ({
  streamLLMPureMock: vi.fn(),
  consumeStreamGeneratorMock: vi.fn(),
}))

vi.mock('../chat/stream-pure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/stream-pure.js')>()
  return {
    ...actual,
    streamLLMPure: streamLLMPureMock,
    consumeStreamGenerator: consumeStreamGeneratorMock,
  }
})

import type { Config, Provider } from '../../shared/types.js'
import { setAgentModelOverride } from '../agents/model-overrides.js'
import { loadConfig } from '../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject, updateProject } from '../db/projects.js'
import { getEventStore, initEventStore } from '../events/index.js'
import type { LLMClientWithModel } from '../llm/client.js'
import { SessionManager } from '../session/manager.js'
import { projectTasksTool, setTasksService } from '../tools/project-tasks.js'
import type { ToolContext } from '../tools/types.js'
import { TurnMetrics, runAgentTurn } from '../chat/orchestrator.js'
import { executeWorkflow } from '../workflows/executor.js'
import type { WorkflowDefinition } from '../workflows/types.js'
import { createTasksService, type TasksService } from './service.js'

const execFileAsync = promisify(execFile)

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

function testClient(providerId: string, model: string): LLMClientWithModel & { providerId: string } {
  return {
    providerId,
    getModel: () => model,
    setModel: vi.fn(),
    getProfile: () => ({ name: model }) as never,
    getBackend: () => 'openai',
    setBackend: vi.fn(),
    complete: vi.fn(),
    stream: vi.fn(),
  }
}

describe('manager launch provider runtime pin', () => {
  let root: string
  let projectDir: string
  let configDir: string
  let config: Config
  let manager: SessionManager
  let service: TasksService
  let requesterSessionId: string
  let targetProjectId: string
  let createClient: ReturnType<typeof vi.fn>
  let fallbackClient: LLMClientWithModel

  const clients = new Map<string, LLMClientWithModel & { providerId: string }>()

  const providerManager = () => {
    fallbackClient = clients.get('provider-default/model-default')!
    createClient = vi.fn((providerId: string, model: string) => clients.get(providerId + '/' + model))
    return {
      getCurrentModelContext: () => 32_000,
      getProviders: () => config.providers ?? [],
      getDefaultModelSelection: () => config.defaultModelSelection,
      getCurrentModel: () => 'model-default',
      getActiveProviderId: () => 'provider-default',
      getLLMClient: () => fallbackClient,
      createClient,
      resolveModel: (_providerId: string, model: string) => model,
      resolveModelEffort: () => undefined,
      getModelSettings: () => undefined,
    } as unknown as ConstructorParameters<typeof SessionManager>[0]
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

  const launch = async (prompt: string) => {
    const task = service.create(targetProjectId, { prompt }, { actor: 'human' })
    const result = await projectTasksTool.execute(
      {
        action: 'launch',
        projectId: targetProjectId,
        taskId: task.id,
        agentId: 'agent-a',
        providerId: 'provider-explicit',
        model: 'model-explicit',
        workspace: 'provider-runtime-' + task.id,
        branch: 'feature/provider-runtime-' + task.id,
        sourceBranch: 'main',
        expectedVersion: task.version,
      },
      managerContext(),
    )
    if (!result.success || !result.output) throw new Error(result.error ?? 'Launch failed')
    const contract = JSON.parse(result.output) as { sessionId: string | null }
    if (!contract.sessionId) throw new Error('Launch did not return a session')
    return contract.sessionId
  }

  const usedPairs = () =>
    streamLLMPureMock.mock.calls.map((call) => {
      const client = call[0]?.llmClient as (LLMClientWithModel & { providerId?: string }) | undefined
      return {
        providerId: client?.providerId ?? null,
        model: client?.getModel() ?? null,
      }
    })

  beforeEach(async () => {
    closeDatabase()
    root = await mkdtemp(join(tmpdir(), 'openfox-launch-provider-runtime-'))
    projectDir = join(root, 'project')
    configDir = join(root, 'config')
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(projectDir, '.openfox', 'agents'), { recursive: true })
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.email', 'tests@openfox.local'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.name', 'OpenFox Tests'], { cwd: projectDir })
    await writeFile(join(projectDir, 'README.md'), 'fixture\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: projectDir })
    for (const id of ['agent-a', 'agent-b']) {
      await writeFile(
        join(projectDir, '.openfox', 'agents', id + '.agent.md'),
        '---\nid: ' +
          id +
          '\nname: ' +
          id +
          '\ndescription: Runtime fixture\nallowedTools: []\n---\n\nRuntime fixture.\n',
      )
    }

    config = loadConfig()
    config.database.path = join(root, 'sessions.db')
    config.providers = [
      testProvider('provider-default', 'model-default', true),
      testProvider('provider-explicit', 'model-explicit'),
      testProvider('provider-override-a', 'model-override-a'),
      testProvider('provider-override-b', 'model-override-b'),
      testProvider('provider-ui', 'model-ui'),
    ]
    config.defaultModelSelection = 'provider-default/model-default'
    initDatabase(config)
    initEventStore(getDatabase())

    clients.clear()
    for (const [providerId, model] of [
      ['provider-default', 'model-default'],
      ['provider-explicit', 'model-explicit'],
      ['provider-override-a', 'model-override-a'],
      ['provider-override-b', 'model-override-b'],
      ['provider-ui', 'model-ui'],
    ] as const) {
      clients.set(providerId + '/' + model, testClient(providerId, model))
    }

    manager = new SessionManager(providerManager())
    const requesterProjectId = createProject('Runtime Manager', projectDir).id
    targetProjectId = createProject('Runtime Target', projectDir).id
    updateProject(requesterProjectId, { workspaceRootDir: join(root, 'workspaces', 'requester') })
    updateProject(targetProjectId, {
      workspaceRootDir: join(root, 'workspaces', 'target'),
      defaultAgent: 'planner',
    })
    const requester = manager.createSession(
      requesterProjectId,
      'Manager requester',
      'provider-default',
      'model-default',
    )
    requesterSessionId = requester.id
    manager.setMode(requesterSessionId, 'manager')
    await expect.poll(() => manager.getSession(requesterSessionId)?.branch).toBe('main')

    service = createTasksService({
      sessionManager: manager,
      config,
      broadcast: () => undefined,
      configDir,
      canStartSession: () => true,
    })
    await service.setSettings(targetProjectId, { slotLimit: 20 })
    setTasksService(service)

    setAgentModelOverride('agent-a', {
      providerId: 'provider-override-a',
      model: 'model-override-a',
    })
    setAgentModelOverride('agent-b', {
      providerId: 'provider-override-b',
      model: 'model-override-b',
    })

    streamLLMPureMock.mockReset().mockReturnValue({ kind: 'stream' })
    consumeStreamGeneratorMock.mockReset().mockResolvedValue({
      content: 'done',
      toolCalls: [],
      segments: [{ type: 'text', content: 'done' }],
      usage: { promptTokens: 1, completionTokens: 1 },
      timing: { ttft: 1, completionTime: 1, tps: 1, prefillTps: 1 },
      aborted: false,
    })
  })

  afterEach(async () => {
    setAgentModelOverride('agent-a', null)
    setAgentModelOverride('agent-b', null)
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it('launched explicit provider and model drive the real chat turn client over the same-agent override', async () => {
    const sessionId = await launch('runtime chat turn')
    streamLLMPureMock.mockClear()
    const append = (event: import('../events/types.js').TurnEvent) => getEventStore().append(sessionId, event)

    await runAgentTurn(
      {
        sessionManager: manager,
        sessionId,
        llmClient: fallbackClient,
      },
      new TurnMetrics(),
      'agent-a',
      append,
    )

    const pairs = usedPairs()
    expect({
      explicitCalls: pairs.filter((pair) => pair.providerId === 'provider-explicit' && pair.model === 'model-explicit')
        .length,
      overrideCalls: pairs.filter(
        (pair) => pair.providerId === 'provider-override-a' && pair.model === 'model-override-a',
      ).length,
    }).toEqual({ explicitCalls: 1, overrideCalls: 0 })
  })

  it('launched explicit provider and model drive every same-agent workflow step client', async () => {
    const sessionId = await launch('runtime workflow')
    streamLLMPureMock.mockClear()
    consumeStreamGeneratorMock.mockResolvedValue({
      content: '',
      toolCalls: [{ id: 'step-done', name: 'step_done', arguments: {} }],
      segments: [],
      usage: { promptTokens: 1, completionTokens: 1 },
      timing: { ttft: 1, completionTime: 1, tps: 1, prefillTps: 1 },
      aborted: false,
    })
    const workflow: WorkflowDefinition = {
      metadata: {
        id: 'provider-runtime',
        name: 'Provider runtime',
        description: 'Provider runtime',
        version: '1.0.0',
        parameters: [],
      },
      entryStep: 'same-agent',
      settings: { maxIterations: 2 },
      steps: [
        {
          id: 'same-agent',
          name: 'Same agent',
          type: 'agent',
          phase: 'build',
          agentId: 'agent-a',
          prompt: 'Use A',
          transitions: [{ when: { type: 'always' }, goto: 'other-agent' }],
        },
        {
          id: 'other-agent',
          name: 'Other agent',
          type: 'agent',
          phase: 'build',
          agentId: 'agent-b',
          prompt: 'Use B',
          transitions: [{ when: { type: 'always' }, goto: '$done' }],
        },
      ],
      startCondition: { type: 'always' },
    }

    const result = await executeWorkflow(workflow, {
      sessionManager: manager,
      sessionId,
      llmClient: fallbackClient,
      scope: 'auto',
    })

    const pairs = usedPairs()
    expect({
      finalAction: result.finalAction.type,
      explicitCalls: pairs.filter((pair) => pair.providerId === 'provider-explicit' && pair.model === 'model-explicit')
        .length,
      sameAgentOverrideCalls: pairs.filter(
        (pair) => pair.providerId === 'provider-override-a' && pair.model === 'model-override-a',
      ).length,
      otherAgentOverrideCalls: pairs.filter(
        (pair) => pair.providerId === 'provider-override-b' && pair.model === 'model-override-b',
      ).length,
    }).toEqual({
      finalAction: 'DONE',
      explicitCalls: 1,
      sameAgentOverrideCalls: 0,
      otherAgentOverrideCalls: 1,
    })
  })

  it('a provider change after launch clears the launch pin and restores the existing resolution', async () => {
    const sessionId = await launch('runtime provider change')
    const launched = manager.getSession(sessionId) as typeof manager extends never
      ? never
      : import('../../shared/types.js').Session
    const launchPinBefore = (launched as unknown as { providerLaunchAgentId?: string }).providerLaunchAgentId

    manager.setSessionProvider(sessionId, 'provider-ui', 'model-ui', true)
    const changed = manager.getSession(sessionId)
    const launchPinAfter = (changed as unknown as { providerLaunchAgentId?: string }).providerLaunchAgentId
    createClient.mockClear()
    const client = manager.createClientForAgent(sessionId, 'agent-a', fallbackClient)

    expect({
      launchPinBefore,
      launchPinAfter: launchPinAfter ?? null,
      providerId: (client as LLMClientWithModel & { providerId?: string }).providerId ?? null,
      model: client.getModel(),
    }).toEqual({
      launchPinBefore: 'agent-a',
      launchPinAfter: null,
      providerId: 'provider-override-a',
      model: 'model-override-a',
    })
  })
})
