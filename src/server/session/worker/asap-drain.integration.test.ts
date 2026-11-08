import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'

interface SessionBody {
  session: { isRunning: boolean }
  queueState: Array<{ content: string }>
  messages: Array<{
    role: string
    content: string
    messageKind?: string
    attachments?: Array<{ filename?: string }>
    toolCalls?: Array<{ name: string }>
  }>
}

describe('worker asap drain', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let sessionId: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-asap-drain-${randomUUID()}`)
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
    const { createServerHandle } = await import('../../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'asap-drain', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'asap-drain' }),
    })
    expect(sessionResponse.status).toBe(201)
    sessionId = ((await sessionResponse.json()) as { session: { id: string } }).session.id
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    await rm(root, { recursive: true, force: true })
  }, 20_000)

  async function readSession(): Promise<SessionBody> {
    const response = await fetch(`${base}/api/sessions/${sessionId}?full=true`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionBody
  }

  async function waitFor(probe: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 25_000
    for (;;) {
      if (await probe()) return
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  it('delivers gateway asap messages to the next llm call once, in order', async () => {
    const started = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Run the exact command: sleep 2' }),
    })
    expect(started.status).toBe(200)
    await waitFor(async () => {
      const body = await readSession()
      return body.messages.some((message) => message.toolCalls?.some((call) => call.name === 'run_command'))
    }, 'the held command')

    const first = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'ACK-LOT13B3-ONE',
        attachments: [{ id: 'file-1', filename: 'note.txt', mimeType: 'text/plain', size: 4, data: 'note' }],
      }),
    })
    const second = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ACK-LOT13B3-TWO', messageKind: 'command' }),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    await waitFor(async () => {
      const body = await readSession()
      return !body.session.isRunning
    }, 'the worker turn to finish')

    const body = await readSession()
    const ack = (content: string) => body.messages.filter((message) => message.content === content)
    const firstAck = ack('ACK-LOT13B3-ONE')
    const secondAck = ack('ACK-LOT13B3-TWO')
    const firstIndex = body.messages.findIndex((message) => message.content === 'ACK-LOT13B3-ONE')
    const secondIndex = body.messages.findIndex((message) => message.content === 'ACK-LOT13B3-TWO')
    const followIndex = body.messages.findIndex(
      (message) =>
        message.role === 'assistant' && message.content.trim() === 'I understand. Let me help you with that.',
    )
    expect(body.messages.some((message) => message.content.trim() === 'Done.')).toBe(false)
    expect(firstAck).toHaveLength(1)
    expect(secondAck).toHaveLength(1)
    expect(firstAck[0]?.attachments?.[0]?.filename).toBe('note.txt')
    expect(secondAck[0]?.messageKind).toBe('command')
    expect(firstIndex).toBeGreaterThan(-1)
    expect(secondIndex).toBe(firstIndex + 1)
    expect(followIndex).toBeGreaterThan(secondIndex)
    expect(body.queueState).toEqual([])
  }, 60_000)
})
