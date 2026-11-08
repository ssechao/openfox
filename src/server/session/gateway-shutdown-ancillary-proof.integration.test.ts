import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Config } from '../../shared/types.js'
import type { ServerHandle } from '../context.js'
import type { StoredEvent } from '../events/types.js'
import { sessionResumeAllowed } from './worker/settle-unknown.js'

describe('gateway shutdown ancillary proof', () => {
  let server: ServerHandle | undefined
  let base: string
  let root: string
  let config: Config
  let closed = false

  afterAll(async () => {
    const { devServerManager } = await import('../dev-server/manager.js')
    delete (devServerManager as { stopAll?: unknown }).stopAll
    const { reopenBackgroundAdmission } = await import('../tools/background-process/store.js')
    reopenBackgroundAdmission()
    if (server && !closed) await server.close().catch(() => {})
    const { closeDatabase } = await import('../db/index.js')
    closeDatabase()
    delete process.env['OPENFOX_MOCK_LLM']
    delete process.env['OPENFOX_SESSION_WORKER']
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  it.fails(
    'leaves a workerless runtime stopped when ancillary cleanup fails after the marker',
    async () => {
      process.env['OPENFOX_MOCK_LLM'] = 'true'
      process.env['OPENFOX_SESSION_WORKER'] = 'false'
      root = join(tmpdir(), `openfox-ancillary-proof-${randomUUID()}`)
      await mkdir(root, { recursive: true })
      config = {
        mode: 'test',
        llm: {
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'ancillary-proof',
          backend: 'unknown',
          timeout: 30_000,
          idleTimeout: 30_000,
        },
        context: { maxTokens: 100_000, compactionThreshold: 0.85, compactionTarget: 0.6 },
        agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120_000 },
        server: { port: 0, host: '127.0.0.1' },
        database: { path: join(root, 'sessions.db') },
        logging: { level: 'error' },
        workdir: root,
        globalConfigPath: join(root, 'config.json'),
      }
      const { createServerHandle } = await import('../index.js')
      server = await createServerHandle(config)
      const started = await server.start(0)
      base = `http://127.0.0.1:${started.port}`

      const projectDir = join(root, 'ancillary-chat')
      await mkdir(projectDir, { recursive: true })
      const projectResponse = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ancillary-chat', workdir: projectDir }),
      })
      expect(projectResponse.status).toBe(201)
      const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
      const sessionResponse = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, title: 'ancillary-chat' }),
      })
      expect(sessionResponse.status).toBe(201)
      const sessionId = ((await sessionResponse.json()) as { session: { id: string } }).session.id

      const { getEventStore } = await import('../events/index.js')
      const { getSessionRuntimeRegistry } = await import('./runtime.js')
      getEventStore().append(sessionId, { type: 'running.changed', data: { isRunning: true } })
      getEventStore().append(sessionId, {
        type: 'message.start',
        data: { messageId: 'message-ancillary', role: 'assistant' },
      })
      getEventStore().append(sessionId, {
        type: 'tool.call',
        data: {
          messageId: 'message-ancillary',
          toolCall: { id: 'ancillary-tool', name: 'run_command', arguments: { command: 'effect' } },
        },
      })
      getSessionRuntimeRegistry().get(sessionId).acquire('chat')

      const { devServerManager } = await import('../dev-server/manager.js')
      devServerManager.stopAll = () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('ancillary cleanup failed')), 0)
        })

      let closeError: unknown
      try {
        await server.close()
        closeError = undefined
      } catch (error) {
        closeError = error
      } finally {
        delete (devServerManager as { stopAll?: unknown }).stopAll
      }
      closed = true
      expect(closeError).toBeInstanceOf(Error)
      expect((closeError as Error).message).toMatch(/ancillary cleanup failed/)

      const { getDatabase, closeDatabase } = await import('../db/index.js')
      const { getSessionInterruptedAt } = await import('./worker/crash.js')
      const interruptedAt = getSessionInterruptedAt(getDatabase(), sessionId)
      expect(interruptedAt).toEqual(expect.any(String))
      const events = getEventStore().getEvents(sessionId)
      closeDatabase()

      server = await createServerHandle(config)
      closed = false
      const restarted = await server.start(0)
      base = `http://127.0.0.1:${restarted.port}`
      const viewResponse = await fetch(`${base}/api/sessions/${sessionId}`)
      expect(viewResponse.status).toBe(200)
      const view = (await viewResponse.json()) as { session: { interruptedAt?: string | null } }
      const proof = (event: StoredEvent) => (event.data as { interruptedAt?: string }).interruptedAt === interruptedAt
      expect({
        interruptedAtAfterBoot: view.session.interruptedAt ?? null,
        resumeAllowed: sessionResumeAllowed(events, interruptedAt!),
        hasBlocked: events.some(
          (event) =>
            event.type === 'worker.recovery_blocked' &&
            proof(event) &&
            (event.data as { reason?: string }).reason === 'orphan_proof',
        ),
        hasClean: events.some((event) => event.type === 'worker.recovery_clean' && proof(event)),
      }).toEqual({
        interruptedAtAfterBoot: interruptedAt,
        resumeAllowed: false,
        hasBlocked: true,
        hasClean: false,
      })
    },
    120_000,
  )
})
