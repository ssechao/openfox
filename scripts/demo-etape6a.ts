import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/shared/types.js'
import type { ServerHandle } from '../src/server/context.js'

interface WorkerIntrospection {
  active: {
    sessionId: string
    token: { workerId: string; generation: number }
    pid: number | undefined
  } | null
}

interface SessionView {
  session: { isRunning: boolean; interruptedAt?: string | null }
  messages: Array<{
    toolCalls?: Array<{
      result?: { success: boolean; metadata?: Record<string, unknown> }
    }>
  }>
  pendingToolReconciliations: Array<{ toolCallId: string; name: string }>
}

const startedAt = performance.now()

function elapsed(): number {
  return Math.round(performance.now() - startedAt)
}

function emit(event: string, fields: Record<string, string | number | boolean> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  process.stdout.write(
    `${new Date().toISOString()} event=${event} elapsed_ms=${elapsed()}${suffix ? ` ${suffix}` : ''}\n`,
  )
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const result = await probe()
    if (result !== null) return result
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function expectOk(response: Response, label: string): Promise<Response> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${await response.text()}`)
  return response
}

async function main(): Promise<void> {
  process.env['OPENFOX_MOCK_LLM'] = 'true'
  const root = await mkdtemp(join(tmpdir(), 'openfox-etape6a-demo-'))
  const workdir = join(root, 'workdir')
  const dbDir = join(root, 'db')
  await mkdir(workdir, { recursive: true })
  await mkdir(dbDir, { recursive: true })

  const config: Config = {
    mode: 'test',
    llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
    context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
    agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
    server: { port: 0, host: '127.0.0.1' },
    database: { path: join(dbDir, 'sessions.db') },
    logging: { level: 'error' },
    workdir,
    globalConfigPath: join(root, 'config.json'),
  }

  let server: ServerHandle | undefined
  try {
    const { createServerHandle } = await import('../src/server/index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    const base = `http://127.0.0.1:${port}`

    const request = async (path: string, init?: RequestInit): Promise<Response> =>
      expectOk(
        await fetch(`${base}${path}`, {
          ...init,
          headers: init?.body
            ? { connection: 'close', 'content-type': 'application/json', ...init.headers }
            : { connection: 'close', ...init?.headers },
        }),
        path,
      )

    const createSession = async (title: string): Promise<string> => {
      const projectDir = join(workdir, title)
      await mkdir(projectDir, { recursive: true })
      const projectResponse = await request('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: title, workdir: projectDir }),
      })
      const { project } = (await projectResponse.json()) as { project: { id: string } }
      const sessionResponse = await request('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ projectId: project.id, title }),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }
      return session.id
    }

    const worker = async (): Promise<WorkerIntrospection> =>
      (await (await request('/api/test/worker')).json()) as WorkerIntrospection
    const session = async (id: string): Promise<SessionView> =>
      (await (await request(`/api/sessions/${id}`)).json()) as SessionView
    const send = async (id: string, content: string): Promise<void> => {
      await request(`/api/sessions/${id}/message`, { method: 'POST', body: JSON.stringify({ content }) })
    }

    await request('/api/settings/agent.sessionWorkerMode', {
      method: 'PUT',
      body: JSON.stringify({ value: 'true' }),
    })

    const crashSession = await createSession('etape6a-crash')
    const effectPath = join(workdir, 'effect.txt')
    const launchStarted = performance.now()
    await send(crashSession, `Run the exact command: printf x >> ${JSON.stringify(effectPath)}; sleep 30`)
    const active = await waitFor(
      async () => {
        const current = (await worker()).active
        return current?.sessionId === crashSession ? current : null
      },
      20_000,
      'crash worker launch',
    )
    await waitFor(
      async () => ((await readFile(effectPath, 'utf-8').catch(() => '')) === 'x' ? true : null),
      20_000,
      'initial side effect',
    )
    emit('worker_launched', {
      launch_ms: Math.round(performance.now() - launchStarted),
      generation: active.token.generation,
      worker_pid: active.pid!,
    })

    const killStarted = performance.now()
    process.kill(active.pid!, 'SIGKILL')
    emit('sigkill_sent', { worker_pid: active.pid! })

    const interrupted = await waitFor(
      async () => {
        const current = await session(crashSession)
        return current.session.interruptedAt && !current.session.isRunning ? current : null
      },
      10_000,
      'interrupted session',
    )
    emit('interrupted_observed', {
      detection_ms: Math.round(performance.now() - killStarted),
      pending_reconciliations: interrupted.pendingToolReconciliations.length,
    })

    const resumeStarted = performance.now()
    const resumeResponse = await request(`/api/sessions/${crashSession}/resume-interruption`, { method: 'POST' })
    emit('resume_response', { status: resumeResponse.status })

    const resumed = await waitFor(
      async () => {
        const current = await session(crashSession)
        return !current.session.interruptedAt && !current.session.isRunning ? current : null
      },
      30_000,
      'resumed completion',
    )
    const refusedDuplicate = resumed.messages.some((message) =>
      message.toolCalls?.some(
        (call) => call.result?.success === false && call.result.metadata?.['reconciliationRequired'] === true,
      ),
    )
    emit('resume_completed', {
      resume_ms: Math.round(performance.now() - resumeStarted),
      effect_bytes: (await readFile(effectPath, 'utf-8')).length,
      duplicate_refused: refusedDuplicate,
      pending_reconciliations: resumed.pendingToolReconciliations.length,
    })

    const stopSession = await createSession('etape6a-stop')
    const stopLaunchStarted = performance.now()
    await send(stopSession, 'Run the exact command: sleep 30')
    const stopWorker = await waitFor(
      async () => {
        const current = (await worker()).active
        return current?.sessionId === stopSession ? current : null
      },
      20_000,
      'Stop worker launch',
    )
    emit('stop_worker_launched', {
      launch_ms: Math.round(performance.now() - stopLaunchStarted),
      generation: stopWorker.token.generation,
      worker_pid: stopWorker.pid!,
    })

    const stopStarted = performance.now()
    const stopResponse = await request(`/api/sessions/${stopSession}/stop`, { method: 'POST' })
    emit('stop_response', { status: stopResponse.status })
    await waitFor(async () => ((await worker()).active === null ? true : null), 15_000, 'worker Stop')
    let workerAlive = true
    try {
      process.kill(stopWorker.pid!, 0)
    } catch {
      workerAlive = false
    }
    emit('worker_stopped', {
      stop_ms: Math.round(performance.now() - stopStarted),
      worker_alive: workerAlive,
    })
  } finally {
    if (server) {
      await Promise.race([server.close(), new Promise((resolve) => setTimeout(resolve, 1000))])
    }
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENFOX_MOCK_LLM']
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  },
)
