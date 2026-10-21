/**
 * Étape 2 demo: a second OpenFox instance refuses to open a database that is
 * already in use, and the first instance keeps its sessions intact. After the
 * first instance is killed, the database can be reopened immediately.
 *
 * Environment is fully temporary (HOME, database, config), ports >= 10620.
 * Set ETAPE2_DEMO_REPORT=<file> to keep the measured figures as JSON.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from '../src/shared/types.js'
import { freePort, isolatedEnv, killProcessTree, openFiles, productionFiles } from './utils/isolated-env.js'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const CHILD = join(REPO_ROOT, 'e2e/utils/instance-collision-child.ts')
const LOCK_CHILD = join(REPO_ROOT, 'src/server/db/instance-lock.test-child.ts')
const MIN_PORT = 10620

interface ChildResult {
  port?: number
  error?: string
  pid?: number
  running?: boolean
  refuseMs?: number
}

interface ChildInstance {
  url: string
  port: number
  child: ChildProcess
  logs: string[]
}

const children = new Set<ChildProcess>()

async function buildConfigFile(
  root: string,
  providerId: string,
  modelId: string,
  fileName = 'config.json',
): Promise<string> {
  const configPath = join(root, fileName)
  const config = {
    version: 1,
    providers: [
      {
        id: providerId,
        name: 'Collision Test Provider',
        url: 'http://127.0.0.1:9/v1',
        backend: 'ollama',
        models: [{ id: modelId, contextWindow: 128000, source: 'user' }],
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeProviderId: providerId,
    defaultModelSelection: `${providerId}/${modelId}`,
  }
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return configPath
}

function forkChild(
  root: string,
  port: number,
  mode: 'test' | 'development',
  configPath: string,
): {
  child: ChildProcess
  logs: string[]
} {
  const logs: string[] = []
  const child = fork(CHILD, [], {
    cwd: REPO_ROOT,
    env: isolatedEnv(root, {
      OPENFOX_DB_PATH: join(root, 'sessions.db'),
      OPENFOX_GLOBAL_CONFIG_PATH: configPath,
      OPENFOX_HOST: '127.0.0.1',
      OPENFOX_PORT: String(port),
      OPENFOX_MODE: mode,
      OPENFOX_MOCK_LLM: 'true',
    }),
    execArgv: ['--import', 'tsx/esm'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: true,
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  const keep = (data: Buffer) => {
    logs.push(data.toString())
    if (logs.length > 200) logs.shift()
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  return { child, logs }
}

function waitForResult(child: ChildProcess, logs: string[], timeoutMs = 60_000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: ChildResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => reject(new Error(`Server did not report:\n${logs.join('')}`)), timeoutMs)
    child.on('message', (message) => finish(message as ChildResult))
    child.once('exit', (code) => {
      setTimeout(() => finish({ error: `exited ${code}\n${logs.join('')}` }), 80)
    })
  })
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function startInstance(
  root: string,
  port: number,
  mode: 'test' | 'development',
  configPath: string,
): Promise<ChildInstance> {
  await mkdir(join(root, 'home'), { recursive: true })
  const { child, logs } = forkChild(root, port, mode, configPath)
  const result = await waitForResult(child, logs)
  if (result.error || typeof result.port !== 'number') {
    throw new Error(`Server failed to start: ${result.error ?? 'no port'}\n${logs.join('')}`)
  }
  return { url: `http://127.0.0.1:${result.port}`, port: result.port, child, logs }
}

async function stopInstance(instance: ChildInstance | ChildProcess | undefined): Promise<void> {
  const child = instance && 'child' in instance ? instance.child : instance
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      killProcessTree(child)
      done()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    try {
      child.send('close')
    } catch {
      killProcessTree(child)
    }
  })
}

async function killAndWait(child: ChildProcess): Promise<number> {
  const started = Date.now()
  if (child.exitCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => done(), 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      killProcessTree(child)
    })
  }
  return Date.now() - started
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error(`Health not available at ${url}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function createProjectAndSession(
  url: string,
  workdir: string,
): Promise<{ projectId: string; sessionId: string }> {
  const projectRes = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'collision-test', workdir }),
  })
  if (!projectRes.ok) throw new Error(`Create project failed: ${projectRes.status} ${await projectRes.text()}`)
  const project = (await projectRes.json()) as { project: { id: string } }

  const sessionRes = await fetch(`${url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.project.id, title: 'collision session' }),
  })
  if (!sessionRes.ok) throw new Error(`Create session failed: ${sessionRes.status} ${await sessionRes.text()}`)
  const session = (await sessionRes.json()) as { session: Session }
  return { projectId: project.project.id, sessionId: session.session.id }
}

async function getSession(url: string, sessionId: string): Promise<Session> {
  const res = await fetch(`${url}/api/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`Get session failed: ${res.status}`)
  const body = (await res.json()) as { session: Session }
  return body.session
}

async function setSessionProvider(url: string, sessionId: string): Promise<void> {
  const res = await fetch(`${url}/api/sessions/${sessionId}/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'collision-provider', model: 'collision-model' }),
  })
  if (!res.ok) throw new Error(`Set provider failed: ${res.status} ${await res.text()}`)
}

function setRunning(child: ChildProcess, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('set-running timed out')), 5_000)
    const onMessage = (message: ChildResult) => {
      if (message.running) {
        clearTimeout(timer)
        child.off('message', onMessage)
        resolve()
      }
    }
    child.on('message', onMessage)
    child.send({ type: 'set-running', sessionId })
  })
}

describe('instance collision demo (isolated instances)', () => {
  let root: string
  let instanceA: ChildInstance
  let sessionId: string
  let configPath: string
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'openfox-collision-demo-'))
    await mkdir(join(root, 'project'), { recursive: true })
    configPath = await buildConfigFile(root, 'collision-provider', 'collision-model')
    const port = await freePort(MIN_PORT)
    instanceA = await startInstance(root, port, 'test', configPath)
    await waitForHealth(instanceA.url)

    const ids = await createProjectAndSession(instanceA.url, join(root, 'project'))
    sessionId = ids.sessionId
    await setSessionProvider(instanceA.url, sessionId)
    await setRunning(instanceA.child, sessionId)
    const running = await getSession(instanceA.url, sessionId)
    expect(running.isRunning).toBe(true)
    expect(running.providerId).toBe('collision-provider')
    report['portA'] = instanceA.port
    report['pidA'] = instanceA.child.pid
  }, 120_000)

  afterAll(async () => {
    try {
      for (const child of [...children]) killProcessTree(child)
      if (root) await rm(root, { recursive: true, force: true })
      const out = process.env['ETAPE2_DEMO_REPORT']
      if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf-8')
    } finally {
      children.clear()
    }
  }, 30_000)

  it('uses only the temporary database and config, never production files', async () => {
    const files = await openFiles(instanceA.child.pid!)
    const realDbPath = await realpath(join(root, 'sessions.db'))
    expect(files).toContain(realDbPath)
    expect(productionFiles(files)).toEqual([])
    expect(productionFiles(await openFiles(process.pid))).toEqual([])
    report['database'] = realDbPath
  })

  it('refuses a second instance on the same database and reports the holder PID', async () => {
    const secondPort = await freePort(MIN_PORT + 1)
    const devConfigPath = await buildConfigFile(root, 'dev-unknown-provider', 'dev-unknown-model', 'dev-config.json')
    const started = Date.now()
    const { child, logs } = forkChild(root, secondPort, 'development', devConfigPath)
    const result = await waitForResult(child, logs, 30_000)
    const fullMs = Date.now() - started
    const exitCode = await waitForExit(child, 5_000)
    const stderr = logs.join('')
    expect(result.error).toMatch(/database already in use by instance PID/)
    expect(result.error).toMatch(new RegExp(`PID ${instanceA.child.pid}`))
    expect(stderr).toMatch(/database already in use by instance PID/)
    expect(stderr).toMatch(new RegExp(`PID ${instanceA.child.pid}`))
    expect(exitCode).toBe(1)
    expect(result.refuseMs).toBeLessThan(2_000)
    report['refusal'] = result.error
    report['portB'] = secondPort
    report['refuseMs'] = result.refuseMs
    report['fullStartupMs'] = fullMs
    report['exitCodeB'] = exitCode
  }, 60_000)

  it('keeps the first instance healthy, the session provider, and running state', async () => {
    const health = await fetch(`${instanceA.url}/api/health`)
    expect(health.status).toBe(200)
    const session = await getSession(instanceA.url, sessionId)
    expect(session.providerId).toBe('collision-provider')
    expect(session.providerModel).toBe('collision-model')
    expect(session.isRunning).toBe(true)
    report['healthAfterRefusal'] = health.status
    report['runningAfterRefusal'] = session.isRunning
  })

  it('allows immediate reopening after the holder is killed', async () => {
    const killMs = await killAndWait(instanceA.child)

    const lockChild = fork(LOCK_CHILD, [], {
      cwd: REPO_ROOT,
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, OPENFOX_LOCK_DB_PATH: join(root, 'sessions.db') },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
    })
    children.add(lockChild)
    const lockStarted = Date.now()
    const lockResult = await new Promise<{ ok: boolean; error?: string }>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('lock probe timed out')), 5_000)
      lockChild.once('message', (message) => {
        clearTimeout(timer)
        done(message as { ok: boolean; error?: string })
      })
      lockChild.once('exit', (code) => {
        clearTimeout(timer)
        done({ ok: false, error: `exited ${code}` })
      })
    })
    const lockReacquireMs = Date.now() - lockStarted
    killProcessTree(lockChild)
    await waitForExit(lockChild, 2_000)
    expect(lockResult.ok).toBe(true)
    expect(lockReacquireMs).toBeLessThan(2_000)

    const newPort = await freePort(MIN_PORT + 2)
    const restartedAt = Date.now()
    const instanceA2 = await startInstance(root, newPort, 'test', configPath)
    const restartMs = Date.now() - restartedAt
    try {
      await waitForHealth(instanceA2.url)
      const session = await getSession(instanceA2.url, sessionId)
      expect(session.providerId).toBe('collision-provider')
      expect(session.providerModel).toBe('collision-model')
      report['killMs'] = killMs
      report['lockReacquireMs'] = lockReacquireMs
      report['restartMs'] = restartMs
      report['portA2'] = instanceA2.port
    } finally {
      await stopInstance(instanceA2)
    }
  }, 120_000)
})
