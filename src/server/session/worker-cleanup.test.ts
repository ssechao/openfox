/**
 * Étape 6a, critère 3 — nettoyage prouvé après kill -9.
 *
 * Runs ONLY on .122 (scripts/test-remote.sh / pre-commit hook): kill -9 and
 * process management are forbidden on the Mac.
 *
 * A worker running a long detached shell command is killed with SIGKILL. The
 * gateway must reap the worker's exclusive children (recorded in the sidecar
 * file) with no orphan process or process group left, while the shared MCP
 * servers (gateway-spawned) stay alive and functional — proven by a real MCP
 * tool call on another session after the crash. LSP servers are likewise
 * gateway-spawned and are never recorded in the worker sidecar, so the
 * cleanup never touches them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

interface WorkerIntrospection {
  active: { sessionId: string; token: { workerId: string; generation: number }; pid: number | undefined } | null
  lastCrash: { sessionId: string; pid: number; signal: NodeJS.Signals | null; killedChildren: number[] } | null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function processGroupMembers(pgid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-g', String(pgid)])
    return stdout
      .trim()
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((n) => n > 0)
  } catch {
    return []
  }
}

describe('worker crash cleanup', () => {
  let server: ServerHandle
  let base: string
  let workdir: string
  let dbDir: string
  let dbPath: string

  beforeAll(async () => {
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    workdir = join(tmpdir(), `openfox-worker-cleanup-${randomUUID()}`)
    dbDir = join(tmpdir(), `openfox-worker-cleanup-db-${randomUUID()}`)
    await mkdir(workdir, { recursive: true })
    await mkdir(dbDir, { recursive: true })
    dbPath = join(dbDir, 'sessions.db')
    const config: Config = {
      mode: 'test',
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: '', backend: 'unknown', timeout: 300000, idleTimeout: 300000 },
      context: { maxTokens: 100000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: dbPath },
      logging: { level: 'error' },
      workdir,
      globalConfigPath: join(tmpdir(), `openfox-worker-cleanup-${randomUUID()}.json`),
      mcpServers: {
        'test-server': {
          transport: 'stdio',
          command: 'npx',
          args: ['tsx', join(here, '..', '..', '..', 'e2e', 'mock-mcp-server.ts')],
        },
      },
    }
    const { createServerHandle } = await import('../index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    base = `http://127.0.0.1:${port}`
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    delete process.env['OPENFOX_MOCK_LLM']
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
    await rm(dbDir, { recursive: true, force: true }).catch(() => {})
  }, 20_000)

  async function createSession(title: string): Promise<string> {
    const projectDir = join(workdir, randomUUID())
    await mkdir(projectDir, { recursive: true })
    const projectRes = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `p-${randomUUID().slice(0, 8)}`, workdir: projectDir }),
    })
    expect(projectRes.status).toBe(201)
    const { project } = (await projectRes.json()) as { project: { id: string } }
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, title }),
    })
    expect(sessionRes.status).toBe(201)
    const { session } = (await sessionRes.json()) as { session: { id: string } }
    return session.id
  }

  async function setWorkerMode(enabled: boolean): Promise<void> {
    const res = await fetch(`${base}/api/settings/agent.sessionWorkerMode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: enabled ? 'true' : 'false' }),
    })
    expect(res.status).toBe(200)
  }

  async function sendMessage(sessionId: string, content: string): Promise<void> {
    const res = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(200)
  }

  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function mcpStatus(): Promise<string | undefined> {
    const res = await fetch(`${base}/api/mcp/servers`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { servers: Array<{ name: string; status: string }> }
    return data.servers.find((s) => s.name === 'test-server')?.status
  }

  it('reaps exclusive children after kill -9 and preserves the shared MCP server', async () => {
    // Shared MCP server connected before the crash.
    await waitFor(async () => ((await mcpStatus()) === 'connected' ? true : null), 30_000, 'MCP server connected')

    await setWorkerMode(true)
    const sessionA = await createSession('cleanup-victim')
    const sessionB = await createSession('mcp-witness')

    // The worker gets busy inside a long detached shell command.
    await sendMessage(sessionA, 'Run the exact command: sleep 300')
    const active = await waitFor(
      async () => {
        const res = await fetch(`${base}/api/test/worker`)
        const data = (await res.json()) as WorkerIntrospection
        return data.active
      },
      20_000,
      'worker to be launched',
    )
    expect(active?.sessionId).toBe(sessionA)
    const workerPid = active!.pid!
    const childrenPath = `${dbPath}.worker-${active!.token.workerId}.children`

    // Wait until the worker has recorded its exclusive shell child.
    const childPid = await waitFor(
      async () => {
        if (!existsSync(childrenPath)) return null
        const lines = (await readFile(childrenPath, 'utf-8')).trim().split('\n').filter(Boolean)
        if (lines.length === 0) return null
        const entry = JSON.parse(lines[0]!) as { pid: number }
        return entry.pid
      },
      20_000,
      'worker child to be tracked',
    )
    expect(pidAlive(childPid)).toBe(true)

    // Kill the worker with prejudice.
    process.kill(workerPid, 'SIGKILL')

    const crash = await waitFor(
      async () => {
        const res = await fetch(`${base}/api/test/worker`)
        const data = (await res.json()) as WorkerIntrospection
        return data.lastCrash
      },
      10_000,
      'crash report',
    )
    expect(crash?.sessionId).toBe(sessionA)
    expect(crash?.signal).toBe('SIGKILL')

    // Proof of cleanup: the recorded child pid was signaled and is gone, its
    // process group is empty, and the sidecar file was removed.
    expect(crash?.killedChildren).toContain(childPid)

    await waitFor(
      async () => {
        const group = await processGroupMembers(childPid)
        return !pidAlive(childPid) && group.length === 0 ? true : null
      },
      10_000,
      'orphan child and its process group to be gone',
    )
    expect(existsSync(childrenPath)).toBe(false)

    // The gateway process itself (and thus its LSP managers) never died:
    // the shared MCP server is still connected…
    expect(await mcpStatus()).toBe('connected')

    // …and functionally alive: a real MCP tool call succeeds on another
    // session (in-process turn) after the crash.
    await setWorkerMode(false)
    await sendMessage(sessionB, 'Call the MCP tool test-server_greet')
    const witness = await waitFor(
      async () => {
        const res = await fetch(`${base}/api/sessions/${sessionB}`)
        const body = (await res.json()) as { session: { isRunning: boolean }; messages: unknown[] }
        const raw = JSON.stringify(body.messages)
        return !body.session.isRunning && raw.includes('test-server_greet') ? raw : null
      },
      30_000,
      'MCP tool call on the witness session',
    )
    expect(witness).toContain('WorkerCleanupProbe')
    expect(witness).not.toMatch(/Unknown tool|tool.*not.*found/i)
  }, 120_000)
})
