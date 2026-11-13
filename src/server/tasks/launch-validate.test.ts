import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config, ProjectTask, Provider } from '../../shared/types.js'
import { loadConfig } from '../config.js'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { addTaskLink, createTask as dbCreateTask, getTask as dbGetTask, setTaskStatus } from '../db/tasks.js'
import type { SessionManager } from '../session/manager.js'
import { createTasksService, type TasksService } from './service.js'

type LaunchRefusalCodeShape =
  | 'NOT_MANAGER'
  | 'PROJECT_MISMATCH'
  | 'TASK_NOT_TODO'
  | 'TASK_ALREADY_BOUND'
  | 'UNKNOWN_AGENT'
  | 'UNKNOWN_PROVIDER'
  | 'UNKNOWN_MODEL'
  | 'INVALID_WORKSPACE_NAME'
  | 'INVALID_BRANCH_NAME'
  | 'INVALID_SOURCE_BRANCH'

interface LaunchRequestShape {
  requesterSessionId: string
  projectId: string
  taskId: string
  agentId: string
  providerId: string
  model: string
  workspace: string
  branch: string
  sourceBranch: string
}

type LaunchSpecShape = Omit<LaunchRequestShape, 'requesterSessionId'> & {
  launchedBy: string
}

type LaunchValidationShape =
  { ok: true; spec: LaunchSpecShape } | { ok: false; code: LaunchRefusalCodeShape; message: string }

type LaunchFields = Pick<LaunchSpecShape, 'workspace' | 'branch' | 'sourceBranch' | 'launchedBy'>

interface TestSession {
  id: string
  projectId: string
  mode: string
  messages: unknown[]
  providerId?: string
  providerModel?: string
}

interface TestSessionManager {
  sessions: Map<string, TestSession>
  createdSessions: TestSession[]
  getSession: (id: string) => TestSession | null
  createSession: (projectId: string) => TestSession
  setMode: (sessionId: string, mode: string) => void
  addMessage: () => void
  queueMessage: () => void
  deleteSession: (sessionId: string) => void
}

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

function makeSessionManager(): TestSessionManager {
  const sessions = new Map<string, TestSession>()
  const createdSessions: TestSession[] = []
  return {
    sessions,
    createdSessions,
    getSession: (id) => sessions.get(id) ?? null,
    createSession: (projectId) => {
      const session = {
        id: `created-${createdSessions.length + 1}`,
        projectId,
        mode: 'planner',
        messages: [],
      }
      createdSessions.push(session)
      sessions.set(session.id, session)
      return session
    },
    setMode: (sessionId, mode) => {
      const session = sessions.get(sessionId)
      if (session) session.mode = mode
    },
    addMessage: () => undefined,
    queueMessage: () => undefined,
    deleteSession: (sessionId) => {
      sessions.delete(sessionId)
    },
  }
}

function createLegacyDatabase(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'todo',
      run_state TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      provider_id TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, prompt, attachments, status, run_state, position, version,
      agent_id, provider_id, model, created_at, updated_at
    ) VALUES (?, ?, ?, '[]', 'todo', NULL, 0, 1, NULL, NULL, NULL, ?, ?)`,
  ).run('legacy-task', 'legacy-project', 'Legacy task', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.close()
}

describe('validateLaunch', () => {
  let root: string
  let projectDir: string
  let projectId: string
  let taskId: string
  let config: Config
  let service: TasksService
  let sessionManager: TestSessionManager

  const launchService = () =>
    service as TasksService & {
      validateLaunch: (request: LaunchRequestShape) => Promise<LaunchValidationShape>
    }

  const validate = (request: LaunchRequestShape) => launchService().validateLaunch(request)

  const request = (overrides: Partial<LaunchRequestShape> = {}): LaunchRequestShape => ({
    requesterSessionId: 'requester-1',
    projectId,
    taskId,
    agentId: 'manager',
    providerId: 'provider-exact',
    model: 'model-exact',
    workspace: 'workspace-test',
    branch: 'feature/launch-test',
    sourceBranch: 'main',
    ...overrides,
  })

  const without = (field: keyof LaunchRequestShape): LaunchRequestShape => {
    const value: Partial<LaunchRequestShape> = request()
    delete value[field]
    return value as LaunchRequestShape
  }

  const expectRefusal = async (value: LaunchRequestShape, code: LaunchRefusalCodeShape) => {
    await expect(validate(value)).resolves.toMatchObject({
      ok: false,
      code,
      message: expect.any(String),
    })
  }

  const git = async (...args: string[]) => {
    const { stdout } = await execFileAsync('git', args, { cwd: projectDir })
    return stdout.trim()
  }

  beforeEach(async () => {
    closeDatabase()
    root = await mkdtemp(join(tmpdir(), 'openfox-launch-validate-'))
    projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.email', 'tests@openfox.local'], { cwd: projectDir })
    await execFileAsync('git', ['config', 'user.name', 'OpenFox Tests'], { cwd: projectDir })
    await writeFile(join(projectDir, 'README.md'), 'fixture\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: projectDir })

    const databasePath = join(root, 'sessions.db')
    createLegacyDatabase(databasePath)
    config = loadConfig()
    config.database.path = databasePath
    config.providers = [
      { ...testProvider('provider-exact', 'model-exact'), isActive: true },
      testProvider('fallback-provider', 'fallback-model'),
    ]
    config.defaultModelSelection = 'fallback-provider/fallback-model'
    initDatabase(config)

    projectId = createProject('Launch Validation', projectDir).id
    taskId = dbCreateTask(projectId, { prompt: 'Launch me' }).id
    sessionManager = makeSessionManager()
    sessionManager.sessions.set('requester-1', {
      id: 'requester-1',
      projectId,
      mode: 'manager',
      messages: [],
      providerId: 'fallback-provider',
      providerModel: 'fallback-model',
    })

    const configDir = join(root, 'config')
    await mkdir(configDir, { recursive: true })
    service = createTasksService({
      sessionManager: sessionManager as unknown as SessionManager,
      config,
      broadcast: () => undefined,
      configDir,
    })
  })

  afterEach(async () => {
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  it.fails('persists additive launch specification columns without regressing legacy tasks', () => {
    const columns = (getDatabase().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    )
    expect(columns).toEqual(expect.arrayContaining(['workspace', 'branch', 'source_branch', 'launched_by']))

    const legacy = dbGetTask('legacy-task') as (ProjectTask & Partial<LaunchFields>) | null
    expect(legacy).toMatchObject({
      id: 'legacy-task',
      prompt: 'Legacy task',
    })
    expect(legacy?.workspace).toBeUndefined()
    expect(legacy?.branch).toBeUndefined()
    expect(legacy?.sourceBranch).toBeUndefined()
    expect(legacy?.launchedBy).toBeUndefined()

    const createWithLaunch = dbCreateTask as unknown as (
      targetProjectId: string,
      input: {
        prompt: string
        workspace: string
        branch: string
        sourceBranch: string
        launchedBy: string
      },
    ) => ProjectTask & LaunchFields
    const created = createWithLaunch(projectId, {
      prompt: 'Configured launch',
      workspace: 'workspace-test',
      branch: 'feature/launch-test',
      sourceBranch: 'main',
      launchedBy: 'requester-1',
    })
    expect(dbGetTask(created.id)).toMatchObject({
      workspace: 'workspace-test',
      branch: 'feature/launch-test',
      sourceBranch: 'main',
      launchedBy: 'requester-1',
    })
  })

  it.fails('rejects callers and tasks that are not eligible for launch with exact codes', async () => {
    sessionManager.sessions.set('builder-1', {
      id: 'builder-1',
      projectId,
      mode: 'builder',
      messages: [],
    })
    const otherProjectDir = join(root, 'other-project')
    await mkdir(otherProjectDir)
    const otherProject = createProject('Other Project', otherProjectDir)
    const foreignTask = dbCreateTask(otherProject.id, { prompt: 'Foreign task' })
    const activeTask = dbCreateTask(projectId, { prompt: 'Active task' })
    setTaskStatus(activeTask.id, 'in_progress')
    const boundTask = dbCreateTask(projectId, { prompt: 'Bound task' })
    addTaskLink(boundTask.id, 'bound-session', true)

    await expectRefusal(request({ requesterSessionId: '' }), 'NOT_MANAGER')
    await expectRefusal(without('requesterSessionId'), 'NOT_MANAGER')
    await expectRefusal(request({ requesterSessionId: 'missing-session' }), 'NOT_MANAGER')
    await expectRefusal(request({ requesterSessionId: 'builder-1' }), 'NOT_MANAGER')
    await expectRefusal(request({ projectId: '' }), 'PROJECT_MISMATCH')
    await expectRefusal(without('projectId'), 'PROJECT_MISMATCH')
    await expectRefusal(request({ taskId: '' }), 'PROJECT_MISMATCH')
    await expectRefusal(without('taskId'), 'PROJECT_MISMATCH')
    await expectRefusal(request({ taskId: 'missing-task' }), 'PROJECT_MISMATCH')
    await expectRefusal(request({ taskId: foreignTask.id }), 'PROJECT_MISMATCH')
    await expectRefusal(request({ taskId: activeTask.id }), 'TASK_NOT_TODO')
    await expectRefusal(request({ taskId: boundTask.id }), 'TASK_ALREADY_BOUND')
  })

  it.fails('rejects unknown launch selections without falling back to defaults', async () => {
    await expectRefusal(request({ agentId: '' }), 'UNKNOWN_AGENT')
    await expectRefusal(without('agentId'), 'UNKNOWN_AGENT')
    await expectRefusal(request({ agentId: 'missing-agent' }), 'UNKNOWN_AGENT')
    await expectRefusal(request({ agentId: 'verifier' }), 'UNKNOWN_AGENT')
    await expectRefusal(request({ providerId: '' }), 'UNKNOWN_PROVIDER')
    await expectRefusal(without('providerId'), 'UNKNOWN_PROVIDER')
    await expectRefusal(request({ providerId: 'missing-provider' }), 'UNKNOWN_PROVIDER')
    await expectRefusal(request({ model: '' }), 'UNKNOWN_MODEL')
    await expectRefusal(without('model'), 'UNKNOWN_MODEL')
    await expectRefusal(request({ model: 'missing-model' }), 'UNKNOWN_MODEL')
  })

  it.fails('validates workspace inputs and returns the complete nominal launch specification', async () => {
    await expectRefusal(request({ workspace: '' }), 'INVALID_WORKSPACE_NAME')
    await expectRefusal(without('workspace'), 'INVALID_WORKSPACE_NAME')
    await expectRefusal(request({ workspace: 'invalid/workspace' }), 'INVALID_WORKSPACE_NAME')
    await expectRefusal(request({ branch: '' }), 'INVALID_BRANCH_NAME')
    await expectRefusal(without('branch'), 'INVALID_BRANCH_NAME')
    await expectRefusal(request({ branch: 'bad..branch' }), 'INVALID_BRANCH_NAME')
    await expectRefusal(request({ sourceBranch: '' }), 'INVALID_SOURCE_BRANCH')
    await expectRefusal(without('sourceBranch'), 'INVALID_SOURCE_BRANCH')
    await expectRefusal(request({ sourceBranch: 'missing-source' }), 'INVALID_SOURCE_BRANCH')

    await expect(
      validate(
        request({
          requesterSessionId: ' requester-1 ',
          projectId: ` ${projectId} `,
          taskId: ` ${taskId} `,
          agentId: ' manager ',
          providerId: ' provider-exact ',
          model: ' model-exact ',
          workspace: ' workspace-test ',
          branch: ' feature/launch-test ',
          sourceBranch: ' main ',
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      spec: {
        projectId,
        taskId,
        agentId: 'manager',
        providerId: 'provider-exact',
        model: 'model-exact',
        workspace: 'workspace-test',
        branch: 'feature/launch-test',
        sourceBranch: 'main',
        launchedBy: 'requester-1',
      },
    })
  })

  it.fails('validates launch requests without mutating sessions tasks or git state', async () => {
    sessionManager.sessions.set('builder-1', {
      id: 'builder-1',
      projectId,
      mode: 'builder',
      messages: [],
    })
    const activeTask = dbCreateTask(projectId, { prompt: 'Active task' })
    setTaskStatus(activeTask.id, 'done')
    const boundTask = dbCreateTask(projectId, { prompt: 'Bound task' })
    addTaskLink(boundTask.id, 'bound-session', true)

    const cases: Array<{
      value: LaunchRequestShape
      expected: { ok: boolean; code?: LaunchRefusalCodeShape }
    }> = [
      { value: request({ requesterSessionId: 'builder-1' }), expected: { ok: false, code: 'NOT_MANAGER' } },
      { value: request({ taskId: 'missing-task' }), expected: { ok: false, code: 'PROJECT_MISMATCH' } },
      { value: request({ taskId: activeTask.id }), expected: { ok: false, code: 'TASK_NOT_TODO' } },
      { value: request({ taskId: boundTask.id }), expected: { ok: false, code: 'TASK_ALREADY_BOUND' } },
      { value: request({ agentId: 'missing-agent' }), expected: { ok: false, code: 'UNKNOWN_AGENT' } },
      { value: request({ providerId: 'missing-provider' }), expected: { ok: false, code: 'UNKNOWN_PROVIDER' } },
      { value: request({ model: 'missing-model' }), expected: { ok: false, code: 'UNKNOWN_MODEL' } },
      { value: request({ workspace: 'invalid/workspace' }), expected: { ok: false, code: 'INVALID_WORKSPACE_NAME' } },
      { value: request({ branch: 'bad..branch' }), expected: { ok: false, code: 'INVALID_BRANCH_NAME' } },
      { value: request({ sourceBranch: 'missing-source' }), expected: { ok: false, code: 'INVALID_SOURCE_BRANCH' } },
      { value: request(), expected: { ok: true } },
    ]

    for (const testCase of cases) {
      const before = {
        sessionCount: sessionManager.sessions.size,
        tasks: getDatabase().prepare('SELECT * FROM tasks ORDER BY id').all(),
        status: await git('status', '--porcelain=v1'),
        refs: await git('show-ref', '--head'),
      }
      const result = await validate(testCase.value)
      expect(result).toMatchObject(testCase.expected)
      const after = {
        sessionCount: sessionManager.sessions.size,
        tasks: getDatabase().prepare('SELECT * FROM tasks ORDER BY id').all(),
        status: await git('status', '--porcelain=v1'),
        refs: await git('show-ref', '--head'),
      }
      expect(after).toEqual(before)
    }
  })
})
