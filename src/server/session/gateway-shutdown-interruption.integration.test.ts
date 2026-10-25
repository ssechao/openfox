import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

interface SessionView {
  session: { interruptedAt?: string | null }
  pendingToolReconciliations: Array<{ toolCallId: string }>
}

describe('gateway shutdown interruption recovery', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let config: Config

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'false'
    root = join(tmpdir(), `openfox-shutdown-interruption-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    config = {
      mode: 'test',
      llm: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'shutdown-interruption',
        backend: 'unknown',
        timeout: 30_000,
        idleTimeout: 30_000,
      },
      context: { maxTokens: 100_000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120_000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(root, 'sessions.db') },
      logging: { level: 'error' },
      workdir: root,
      globalConfigPath: join(root, 'config.json'),
    }
    await startServer()
  }, 120_000)

  afterAll(async () => {
    await server?.close().catch(() => {})
    const { closeDatabase } = await import('../db/index.js')
    closeDatabase()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  async function startServer(): Promise<void> {
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
  }

  async function createSession(title: string): Promise<string> {
    const projectDir = join(root, title)
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: title, workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title }),
    })
    expect(sessionResponse.status).toBe(201)
    return ((await sessionResponse.json()) as { session: { id: string } }).session.id
  }

  async function getSession(sessionId: string): Promise<SessionView> {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionView
  }

  it('persists active chat and workflow runtimes before aborting them, then resumes both', async () => {
    const chatSessionId = await createSession('shutdown-chat')
    const workflowSessionId = await createSession('shutdown-workflow')
    const { getSessionRuntimeRegistry } = await import('./runtime.js')
    const { createWorkflowExecution, updateWorkflowExecutionStatus } = await import('../db/sessions.js')
    const { getEventStore } = await import('../events/index.js')

    for (const [sessionId, toolCallId] of [
      [chatSessionId, 'chat-tool'],
      [workflowSessionId, 'workflow-tool'],
    ] as const) {
      getEventStore().append(sessionId, { type: 'running.changed', data: { isRunning: true } })
      getEventStore().append(sessionId, {
        type: 'tool.call',
        data: {
          messageId: `message-${toolCallId}`,
          toolCall: { id: toolCallId, name: 'run_command', arguments: { command: 'effect' } },
        },
      })
    }

    createWorkflowExecution('workflow-execution', workflowSessionId, 'default', 'Default', undefined, {})
    updateWorkflowExecutionStatus('workflow-execution', 'running', 'build', 'Build')
    getSessionRuntimeRegistry().get(chatSessionId).acquire('chat')
    getSessionRuntimeRegistry().get(workflowSessionId).acquire('workflow')

    await server.close()
    const { closeDatabase } = await import('../db/index.js')
    closeDatabase()
    await startServer()

    const chat = await getSession(chatSessionId)
    const workflow = await getSession(workflowSessionId)
    expect(chat.session.interruptedAt).toBeTruthy()
    expect(workflow.session.interruptedAt).toBeTruthy()
    expect(chat.pendingToolReconciliations).toEqual([expect.objectContaining({ toolCallId: 'chat-tool' })])
    expect(workflow.pendingToolReconciliations).toEqual([expect.objectContaining({ toolCallId: 'workflow-tool' })])

    const chatResume = await fetch(`${base}/api/sessions/${chatSessionId}/resume-interruption`, { method: 'POST' })
    const workflowResume = await fetch(`${base}/api/sessions/${workflowSessionId}/resume-interruption`, {
      method: 'POST',
    })
    expect(chatResume.status).toBe(200)
    expect(workflowResume.status).toBe(200)

    const deadline = Date.now() + 30_000
    while (getSessionRuntimeRegistry().countActive() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(getSessionRuntimeRegistry().countActive()).toBe(0)
  }, 120_000)
})
