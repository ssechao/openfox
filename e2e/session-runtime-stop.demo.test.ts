/**
 * Étape 5 demo: Stop is acknowledged within 100 ms even while a long shell
 * command is in flight. The runtime registry gives every execution path a
 * single root AbortController, so /stop can abort synchronously before any
 * further I/O.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestServerHandle } from './utils/server-factory.js'
import { createProject, createSession, sendMessage, stopSessionChat } from './utils/rest-client.js'
import type { DiagnosticsData } from '../src/shared/diagnostics.js'

const ACK_BUDGET_MS = 100
const SLEEP_SECONDS = 5
const PROJECT_DIR = '/tmp/openfox-runtime-stop-demo'

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

async function diagnostics(baseUrl: string): Promise<DiagnosticsData> {
  const res = await fetch(`${baseUrl}/api/diagnostics`)
  if (!res.ok) throw new Error(`GET diagnostics failed: ${res.status}`)
  return (await res.json()) as DiagnosticsData
}

describe('session runtime stop demo', () => {
  let server: TestServerHandle
  let sessionId: string

  beforeAll(async () => {
    server = await createTestServer()
    const project = await createProject(server.url, { name: 'runtime-stop-demo', workdir: PROJECT_DIR })
    const session = await createSession(server.url, { projectId: project.id, title: 'Stop demo' })
    sessionId = session.id
  }, 60_000)

  afterAll(async () => {
    await server.close()
  }, 30_000)

  it('acknowledges /stop within 100 ms while a long command is running', async () => {
    await sendMessage(server.url, sessionId, `Run the exact command: sleep ${SLEEP_SECONDS}`)
    await waitForRunning(server.url, sessionId)

    const diagnosticsBefore = await diagnostics(server.url)
    const runtimeBefore = diagnosticsBefore.runtimes.find((r) => r.sessionId === sessionId)
    expect(runtimeBefore).toBeTruthy()
    expect(runtimeBefore!.state).toMatch(/running|workflow/)

    const started = performance.now()
    const stopResult = await stopSessionChat(server.url, sessionId)
    const ackMs = performance.now() - started

    expect(stopResult.success).toBe(true)
    expect(ackMs).toBeLessThan(ACK_BUDGET_MS)

    // The runtime eventually settles to idle.
    const deadline = Date.now() + 5_000
    let settled = false
    while (Date.now() < deadline) {
      const data = await diagnostics(server.url)
      const runtime = data.runtimes.find((r) => r.sessionId === sessionId)
      if (!runtime || runtime.state === 'idle') {
        settled = true
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(settled).toBe(true)
  }, 30_000)
})
