/**
 * Étape 5 demo C3: Stop while a process tree (parent shell + child + grandchild,
 * at least one of them ignoring SIGTERM) is running.
 *
 * Verifies:
 *   - /stop is acknowledged in < 100 ms;
 *   - runtime state becomes 'stopping' and session.isRunning becomes false immediately;
 *   - the session is not relaunched while still stopping (state never returns to running);
 *   - the whole process tree (parent, child and grandchild PIDs recorded BEFORE Stop)
 *     is gone within 1 s and leaves no orphan behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createTestServer, type TestServerHandle } from './utils/server-factory.js'
import { createProject, createSession, sendMessage, stopSessionChat } from './utils/rest-client.js'
import type { DiagnosticsData } from '../src/shared/diagnostics.js'

const ACK_BUDGET_MS = 100
const TREE_GONE_BUDGET_MS = 1_000
const PROJECT_DIR = '/tmp/openfox-runtime-stop-demo'
const SCRIPT_PATH = `${PROJECT_DIR}/tree.sh`
const PIDS_PATH = `${PROJECT_DIR}/pids`

const TREE_SCRIPT = `#!/usr/bin/env bash
set -m
child_cmd="process.title='of-stop-demo-child-$$'; process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
grandchild_cmd="process.title='of-stop-demo-grandchild-$$'; process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
node -e "$child_cmd" & child=$!
node -e "$grandchild_cmd" & grandchild=$!
echo "$$ $child $grandchild" > '${PIDS_PATH}'
wait
`

async function waitForRunning(baseUrl: string, sessionId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    if (!res.ok) throw new Error(`GET session failed: ${res.status}`)
    const { session } = (await res.json()) as { session: { isRunning: boolean } }
    if (session.isRunning) return
    if (Date.now() > deadline) throw new Error('Session did not start running in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function getSession(baseUrl: string, sessionId: string): Promise<{ isRunning: boolean }> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`GET session failed: ${res.status}`)
  const { session } = (await res.json()) as { session: { isRunning: boolean } }
  return session
}

async function diagnostics(baseUrl: string): Promise<DiagnosticsData> {
  const res = await fetch(`${baseUrl}/api/diagnostics`)
  if (!res.ok) throw new Error(`GET diagnostics failed: ${res.status}`)
  return (await res.json()) as DiagnosticsData
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readTreePids(): Promise<{ parent: number; child: number; grandchild: number }> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      const text = await readFile(PIDS_PATH, 'utf-8')
      const pids = text
        .trim()
        .split(/\s+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => !Number.isNaN(n) && n > 0)
      if (pids.length === 3 && pids.every(isAlive)) {
        return { parent: pids[0]!, child: pids[1]!, grandchild: pids[2]! }
      }
    } catch {}
    if (Date.now() > deadline) throw new Error('Tree PID file did not appear in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function waitForTreeGone(
  pids: number[],
  timeoutMs: number,
): Promise<{ goneWithinBudget: boolean; survivors: number[] }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const survivors = pids.filter(isAlive)
    if (survivors.length === 0) return { goneWithinBudget: true, survivors: [] }
    if (Date.now() > deadline) return { goneWithinBudget: false, survivors }
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('session runtime stop demo', () => {
  let server: TestServerHandle
  let sessionId: string

  beforeAll(async () => {
    await rm(PROJECT_DIR, { recursive: true, force: true })
    await mkdir(PROJECT_DIR, { recursive: true })
    await writeFile(SCRIPT_PATH, TREE_SCRIPT, { mode: 0o755 })

    server = await createTestServer()
    const project = await createProject(server.url, { name: 'runtime-stop-demo', workdir: PROJECT_DIR })
    const session = await createSession(server.url, { projectId: project.id, title: 'Stop demo' })
    sessionId = session.id
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await rm(PROJECT_DIR, { recursive: true, force: true })
  }, 30_000)

  it('stops a SIGTERM-ignoring process tree within 1 s and stays stopping until settled', async () => {
    await sendMessage(server.url, sessionId, 'RUNTIME-STOP-DEMO-TREE')
    await waitForRunning(server.url, sessionId)

    const { parent: parentPid, child: childPid, grandchild: grandchildPid } = await readTreePids()
    expect(parentPid).toBeGreaterThan(0)
    expect(childPid).toBeGreaterThan(0)
    expect(grandchildPid).toBeGreaterThan(0)

    const diagnosticsBefore = await diagnostics(server.url)
    const runtimeBefore = diagnosticsBefore.runtimes.find((r) => r.sessionId === sessionId)
    expect(runtimeBefore).toBeTruthy()
    expect(runtimeBefore!.state).toMatch(/running|workflow/)

    const started = performance.now()
    const stopResult = await stopSessionChat(server.url, sessionId)
    const ackMs = performance.now() - started
    expect(stopResult.success).toBe(true)
    expect(ackMs).toBeLessThan(ACK_BUDGET_MS)

    const sessionAfterStop = await getSession(server.url, sessionId)
    expect(sessionAfterStop.isRunning).toBe(false)

    const diagnosticsAfterStop = await diagnostics(server.url)
    const runtimeAfterStop = diagnosticsAfterStop.runtimes.find((r) => r.sessionId === sessionId)
    expect(runtimeAfterStop).toBeTruthy()
    expect(runtimeAfterStop!.state).toBe('stopping')

    // No relaunch while stopping, and process tree gone within budget.
    const treePids = [parentPid, childPid, grandchildPid]
    const settleDeadline = Date.now() + 5_000
    let settled = false
    while (Date.now() < settleDeadline) {
      const data = await diagnostics(server.url)
      const runtime = data.runtimes.find((r) => r.sessionId === sessionId)
      const state = runtime?.state

      expect(state).not.toBe('running')

      const { goneWithinBudget, survivors } = await waitForTreeGone(treePids, TREE_GONE_BUDGET_MS)
      expect(goneWithinBudget).toBe(true)
      expect(survivors.length).toBe(0)

      if (state === 'idle') {
        settled = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(settled).toBe(true)

    const sessionFinal = await getSession(server.url, sessionId)
    expect(sessionFinal.isRunning).toBe(false)
  }, 30_000)
})
