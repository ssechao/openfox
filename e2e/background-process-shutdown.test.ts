import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, isolatedEnv, killProcessTree, track } from './utils/isolated-env.js'
import { createProject, createSession, sendMessage } from './utils/rest-client.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MIN_PORT = 11000

interface Instance {
  url: string
  port: number
  root: string
  dbPath: string
  child: ChildProcess
  logs: string[]
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

async function startInstance(): Promise<Instance> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openfox-runtime-stop-')))
  await mkdir(join(root, 'home'), { recursive: true })
  const dbPath = join(root, 'sessions.db')
  const port = await freePort(MIN_PORT)
  const logs: string[] = []
  const child = track(
    fork(join(REPO_ROOT, 'e2e/utils/health-server-child.ts'), [], {
      cwd: REPO_ROOT,
      env: isolatedEnv(root, {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_GLOBAL_CONFIG_PATH: join(root, 'config.json'),
        OPENFOX_HOST: '127.0.0.1',
        OPENFOX_PORT: String(port),
        OPENFOX_LLM_URL: 'http://127.0.0.1:9/v1',
        OPENFOX_MOCK_LLM: 'true',
        OPENFOX_SESSION_WORKER: 'true',
        OPENFOX_SESSION_PROCESS_SUPERVISOR: 'true',
      }),
      execArgv: ['--import', 'tsx/esm'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    }),
    'server',
    logs,
  )
  const listening = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Server did not start:\n${logs.join('')}`)), 120_000)
    child.on('message', (message) => {
      const value = (message as { port?: number } | null)?.port
      if (typeof value === 'number') {
        clearTimeout(timer)
        done(value)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`Server exited (${code}) before listening:\n${logs.join('')}`))
    })
  })
  return { url: `http://127.0.0.1:${listening}`, port: listening, root, dbPath, child, logs }
}

async function stopInstance(instance: Instance): Promise<void> {
  if (instance.child.exitCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        killProcessTree(instance.child)
        done()
      }, 15_000)
      instance.child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      try {
        instance.child.send('close')
      } catch {
        killProcessTree(instance.child)
      }
    })
  }
  await rm(instance.root, { recursive: true, force: true })
}

async function waitForIdle(base: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    const body = (await response.json()) as { session: { isRunning: boolean } }
    if (!body.session.isRunning) return
    if (Date.now() > deadline) throw new Error('Session did not finish in time')
    await sleep(50)
  }
}

describe('background process shutdown', () => {
  let instance: Instance

  beforeAll(async () => {
    instance = await startInstance()
  }, 120_000)

  afterAll(async () => {
    await stopInstance(instance)
  }, 20_000)

  it('a closing gateway destroys the background process of a finished turn before it exits', async () => {
    const projectDir = join(instance.root, 'project')
    await mkdir(projectDir, { recursive: true })
    const project = await createProject(instance.url, { name: 'background-process-shutdown', workdir: projectDir })
    const session = await createSession(instance.url, {
      projectId: project.id,
      title: 'background-process-shutdown',
    })

    await sendMessage(instance.url, session.id, 'BG-IPC-START')
    await waitForIdle(instance.url, session.id)
    await sleep(2_000)

    const processesResponse = await fetch(`${instance.url}/api/sessions/${session.id}/background-processes`)
    expect(processesResponse.status).toBe(200)
    const { processes } = (await processesResponse.json()) as {
      processes: Array<{ pid: number | null }>
    }
    const pid = processes[0]?.pid
    expect(pid).toBeTypeOf('number')
    expect(() => process.kill(pid!, 0)).not.toThrow()

    const exited = new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`Server did not exit:\n${instance.logs.join('')}`)), 15_000)
      instance.child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
    })
    instance.child.send('close')
    await exited

    expect(() => process.kill(pid!, 0)).toThrow()
  }, 60_000)
})
