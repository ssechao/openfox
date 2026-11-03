import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'
import { getDatabase } from '../db/index.js'
import { markSessionInterrupted } from '../session/worker/crash.js'

describe('workflow background wait', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let projectId: string
  let sessionId: string
  let closed = false

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    process.env['OPENFOX_TEST_BACKGROUND_WAIT_RECHECK_DELAY_MS'] = '2500'
    root = join(tmpdir(), `openfox-background-wait-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(root, 'sessions.db') },
      logging: { level: 'error' },
      workdir: root,
      globalConfigPath: join(root, 'config.json'),
      mcpServers: {},
    }
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const workflowDir = join(projectDir, '.openfox', 'workflows')
    await mkdir(workflowDir, { recursive: true })
    await writeFile(
      join(workflowDir, 'background-wait.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'background-wait',
          name: 'Background wait',
          description: 'Waits for a notifyOnExit job',
          version: '1.0.0',
        },
        entryStep: 'run',
        settings: { maxIterations: 3 },
        steps: [
          {
            id: 'run',
            name: 'Run',
            type: 'agent',
            phase: 'build',
            agentId: 'builder',
            prompt: 'BG-WAIT-START',
            transitions: [{ when: { type: 'always' }, goto: '$done' }],
          },
        ],
      }),
    )
    await writeFile(
      join(workflowDir, 'background-wait-long.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'background-wait-long',
          name: 'Background wait long',
          description: 'Waits for a notifyOnExit job',
          version: '1.0.0',
        },
        entryStep: 'run',
        settings: { maxIterations: 3 },
        steps: [
          {
            id: 'run',
            name: 'Run',
            type: 'agent',
            phase: 'build',
            agentId: 'builder',
            prompt: 'BG-WAIT-LONG',
            transitions: [{ when: { type: 'always' }, goto: '$done' }],
          },
        ],
      }),
    )
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'background-wait', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const { project } = (await projectResponse.json()) as { project: { id: string } }
    projectId = project.id
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'background-wait' }),
    })
    expect(sessionResponse.status).toBe(201)
    const body = (await sessionResponse.json()) as { session: { id: string } }
    sessionId = body.session.id
  }, 60_000)

  afterAll(async () => {
    if (!closed) await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    delete process.env['OPENFOX_TEST_BACKGROUND_WAIT_RECHECK_DELAY_MS']
    await rm(root, { recursive: true, force: true })
  }, 20_000)

  async function createSession(title: string): Promise<string> {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { session: { id: string } }).session.id
  }

  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error('timed out waiting for worker background process')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('pauses on a notifyOnExit process and resumes the step with its exit notice', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    try {
      ws.send(
        JSON.stringify({
          id: 'launch-wait',
          type: 'runner.launch',
          payload: { sessionId, workflowId: 'background-wait', scope: 'project' },
        }),
      )
      const status = async () =>
        (await (await fetch(`${base}/api/sessions/${sessionId}/status`)).json()) as {
          phase: string
          workflowStep: string | null
        }
      const messages = async () =>
        (
          (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as {
            messages: Array<{ role: string; content: string; isSystemGenerated?: boolean; messageKind?: string }>
          }
        ).messages
      await waitFor(async () => ((await status()).phase === 'waiting' ? true : null), 15_000)
      expect(
        (await messages()).filter(
          (message) =>
            message.content.includes("You haven't called step_done()") || message.content.includes('Continue working'),
        ),
      ).toEqual([])
      await waitFor(async () => ((await status()).phase === 'done' ? true : null), 30_000)
      const notice = (await messages()).find(
        (message) => message.role === 'user' && message.content.startsWith('Background process "wait-job"'),
      )
      expect(notice?.isSystemGenerated).toBe(true)
      expect(notice?.messageKind).toBe('auto-prompt')
      let idleSince: number | null = null
      const settledMessages = await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as {
          session: { isRunning: boolean }
          messages: Array<{ messageKind?: string }>
        }
        if (body.session.isRunning) {
          idleSince = null
          return null
        }
        idleSince ??= Date.now()
        return Date.now() - idleSince >= 1_000 ? body.messages : null
      }, 30_000)
      expect(settledMessages.filter((message) => message.messageKind === 'task-completed')).toHaveLength(1)
    } finally {
      ws.close()
    }
  }, 60_000)

  it('runs a background-wait step once when a manual resume overlaps the exit notice', async () => {
    const id = await createSession('background-wait-overlap')
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    try {
      ws.send(
        JSON.stringify({
          id: 'launch-overlap',
          type: 'runner.launch',
          payload: { sessionId: id, workflowId: 'background-wait', scope: 'project' },
        }),
      )
      const status = async () => (await (await fetch(`${base}/api/sessions/${id}/status`)).json()) as { phase: string }
      await waitFor(async () => ((await status()).phase === 'waiting' ? true : null), 15_000)
      ws.send(
        JSON.stringify({
          id: 'resume-overlap',
          type: 'runner.launch',
          payload: { sessionId: id, workflowId: 'background-wait', scope: 'project', resumeFrom: 'run' },
        }),
      )
      await waitFor(async () => ((await status()).phase === 'done' ? true : null), 30_000)
      // A duplicate resume would run after the winner: give it time to show up.
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const messages = (
        (await (await fetch(`${base}/api/sessions/${id}`)).json()) as {
          messages: Array<{ messageKind?: string }>
        }
      ).messages
      expect(messages.filter((message) => message.messageKind === 'task-completed')).toHaveLength(1)
    } finally {
      ws.close()
    }
  }, 60_000)

  it('does not relaunch the workflow of an interrupted session on the exit notice', async () => {
    const id = await createSession('background-wait-interrupted')
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    try {
      ws.send(
        JSON.stringify({
          id: 'launch-interrupted',
          type: 'runner.launch',
          payload: { sessionId: id, workflowId: 'background-wait-long', scope: 'project' },
        }),
      )
      const status = async () => (await (await fetch(`${base}/api/sessions/${id}/status`)).json()) as { phase: string }
      await waitFor(async () => ((await status()).phase === 'waiting' ? true : null), 15_000)
      markSessionInterrupted(getDatabase(), id, new Date().toISOString())
      await new Promise((resolve) => setTimeout(resolve, 9_000))
      expect((await status()).phase).toBe('waiting')
      const body = (await (await fetch(`${base}/api/sessions/${id}`)).json()) as {
        messages: Array<{ messageKind?: string }>
      }
      expect(body.messages.filter((message) => message.messageKind === 'task-completed')).toHaveLength(0)
    } finally {
      ws.close()
    }
  }, 60_000)

  it.fails(
    'blocks a claimed background-wait resume that cannot start',
    async () => {
      const id = await createSession('background-wait-missing-step')
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      try {
        ws.send(
          JSON.stringify({
            id: 'launch-missing',
            type: 'runner.launch',
            payload: { sessionId: id, workflowId: 'background-wait-long', scope: 'project' },
          }),
        )
        const status = async () =>
          (await (await fetch(`${base}/api/sessions/${id}/status`)).json()) as { phase: string }
        await waitFor(async () => ((await status()).phase === 'waiting' ? true : null), 15_000)
        ws.send(
          JSON.stringify({
            id: 'resume-missing',
            type: 'runner.launch',
            payload: {
              sessionId: id,
              workflowId: 'background-wait-long',
              scope: 'project',
              resumeFrom: 'missing-step',
            },
          }),
        )
        const execution = await waitFor(async () => {
          const row = getDatabase()
            .prepare(
              'SELECT status, step_output FROM workflow_executions WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
            )
            .get(id) as { status: string; step_output: string | null } | undefined
          return row && row.status === 'blocked' ? row : null
        }, 5_000)
        expect(JSON.parse(execution.step_output ?? '{}')).not.toHaveProperty('backgroundWait')
      } finally {
        ws.close()
      }
    },
    60_000,
  )
})
