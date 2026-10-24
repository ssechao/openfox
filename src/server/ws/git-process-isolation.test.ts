import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

const execFileAsync = promisify(execFile)

interface WsMessage {
  id?: string
  type?: string
}

interface ProcessIntrospection {
  processSupervisor: {
    pid: number
    lastGitProcess: {
      pid: number
      parentPid: number
      cwd: string
      args: string[]
    }
  }
}

describe('git process isolation', () => {
  let server: ServerHandle
  let base: string
  let root: string
  let sessionId: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
    process.env['OPENFOX_SESSION_WORKER'] = 'true'
    root = join(tmpdir(), `openfox-git-isolation-${randomUUID()}`)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: projectDir })
    await writeFile(join(projectDir, 'README.md'), 'isolation\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir })
    await execFileAsync(
      'git',
      ['-c', 'user.name=OpenFox Test', '-c', 'user.email=test@openfox.local', 'commit', '-m', 'initial'],
      { cwd: projectDir },
    )

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
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`

    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'git-isolation', workdir: projectDir }),
    })
    expect(projectResponse.status).toBe(201)
    const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'git-isolation' }),
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

  function waitForWs(ws: WebSocket, predicate: (message: WsMessage) => boolean): Promise<WsMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMessage)
        reject(new Error('timed out waiting for WebSocket response'))
      }, 10_000)
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(String(raw)) as WsMessage
        if (!predicate(message)) return
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(message)
      }
      ws.on('message', onMessage)
    })
  }

  it('runs WebSocket git status processes under the supervisor instead of the gateway', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    try {
      const gitStatus = waitForWs(ws, (message) => message.type === 'git.status')
      const loadAck = waitForWs(ws, (message) => message.id === 'load')
      ws.send(JSON.stringify({ id: 'load', type: 'session.load', payload: { sessionId } }))
      await expect(gitStatus).resolves.toMatchObject({ type: 'git.status' })
      await expect(loadAck).resolves.toMatchObject({ type: 'ack' })

      const response = await fetch(`${base}/api/test/worker`)
      expect(response.status).toBe(200)
      const { processSupervisor } = (await response.json()) as ProcessIntrospection

      expect(processSupervisor.pid).not.toBe(process.pid)
      expect(processSupervisor.lastGitProcess.pid).not.toBe(process.pid)
      expect(processSupervisor.lastGitProcess.parentPid).toBe(processSupervisor.pid)
      expect(processSupervisor.lastGitProcess.parentPid).not.toBe(process.pid)
      expect(processSupervisor.lastGitProcess.cwd).toBe(join(root, 'project'))
      expect(processSupervisor.lastGitProcess.args.length).toBeGreaterThan(0)
    } finally {
      ws.close()
    }
  }, 60_000)
})
