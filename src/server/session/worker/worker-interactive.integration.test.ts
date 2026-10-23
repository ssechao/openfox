import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

interface SessionView {
  session: { isRunning: boolean; interruptedAt?: string | null }
  messages: unknown[]
  pendingQuestions: Array<{ callId: string }>
  pendingConfirmations: Array<{ callId: string }>
}

describe('worker interactive IPC', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let projectId: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-worker-interactive-${randomUUID()}`)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
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
    }
    const { createServerHandle } = await import('../../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-interactive', workdir: projectDir }),
    })
    expect(response.status).toBe(201)
    projectId = ((await response.json()) as { project: { id: string } }).project.id
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
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

  async function getSession(sessionId: string): Promise<SessionView> {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionView
  }

  async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
    const deadline = Date.now() + 30_000
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function sendMessage(sessionId: string, content: string): Promise<void> {
    const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(response.status).toBe(200)
  }

  it('routes ask_user through the gateway and rejects a late answer', async () => {
    const sessionId = await createSession('worker-question')
    await sendMessage(sessionId, 'ask the user a question')

    const callId = await waitFor(async () => {
      const view = await getSession(sessionId)
      return view.pendingQuestions[0]?.callId ?? null
    }, 'worker question')

    const answer = await fetch(`${base}/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, answer: 'Continue' }),
    })
    expect(answer.status).toBe(200)

    const finished = await waitFor(async () => {
      const view = await getSession(sessionId)
      return !view.session.isRunning && view.pendingQuestions.length === 0 ? view : null
    }, 'question turn completion')
    expect(JSON.stringify(finished.messages)).toContain('Continue')

    const late = await fetch(`${base}/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, answer: 'Late' }),
    })
    expect(late.status).toBe(404)
  }, 60_000)

  it('cancels a pending question on Stop', async () => {
    const sessionId = await createSession('worker-question-stop')
    await sendMessage(sessionId, 'ask the user a question')

    const callId = await waitFor(async () => {
      const view = await getSession(sessionId)
      return view.pendingQuestions[0]?.callId ?? null
    }, 'worker question before Stop')

    const stop = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)

    await waitFor(async () => {
      const view = await getSession(sessionId)
      return !view.session.isRunning && view.pendingQuestions.length === 0 ? true : null
    }, 'question cancellation on Stop')

    const late = await fetch(`${base}/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, answer: 'Late' }),
    })
    expect(late.status).toBe(404)
  }, 60_000)

  it('cancels a pending question when the worker crashes', async () => {
    const sessionId = await createSession('worker-question-crash')
    await sendMessage(sessionId, 'ask the user a question')

    const callId = await waitFor(async () => {
      const view = await getSession(sessionId)
      return view.pendingQuestions[0]?.callId ?? null
    }, 'worker question before crash')
    const pid = await waitFor(async () => {
      const response = await fetch(`${base}/api/test/worker`)
      const body = (await response.json()) as { activeWorkers: Array<{ sessionId: string; pid?: number }> }
      return body.activeWorkers.find((worker) => worker.sessionId === sessionId)?.pid ?? null
    }, 'interactive worker process')
    process.kill(pid, 'SIGKILL')

    await waitFor(async () => {
      const view = await getSession(sessionId)
      return view.session.interruptedAt && view.pendingQuestions.length === 0 ? true : null
    }, 'question cancellation after crash')

    const late = await fetch(`${base}/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, answer: 'Late' }),
    })
    expect(late.status).toBe(404)
  }, 60_000)

  it('routes path confirmation through the gateway and rejects a late response', async () => {
    const sessionId = await createSession('worker-path')
    await sendMessage(sessionId, 'Run the exact command: cat /etc/hosts')

    const callId = await waitFor(async () => {
      const view = await getSession(sessionId)
      return view.pendingConfirmations[0]?.callId ?? null
    }, 'worker path confirmation')

    const confirmation = await fetch(`${base}/api/sessions/${sessionId}/confirm-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, approved: true, alwaysAllow: false }),
    })
    expect(confirmation.status).toBe(200)

    const finished = await waitFor(async () => {
      const view = await getSession(sessionId)
      return !view.session.isRunning && view.pendingConfirmations.length === 0 ? view : null
    }, 'path turn completion')
    expect(JSON.stringify(finished.messages)).toContain('localhost')

    const late = await fetch(`${base}/api/sessions/${sessionId}/confirm-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, approved: true }),
    })
    expect(late.status).toBe(404)
  }, 60_000)
})
