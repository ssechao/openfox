// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { createSession } from '../db/sessions.js'

vi.mock('../llm/models.js', () => ({
  detectModel: vi.fn(async () => 'test-model'),
  getLlmStatus: vi.fn(() => 'unknown'),
  setLlmStatus: vi.fn(),
  clearModelCache: vi.fn(),
  getCachedModel: vi.fn(() => null),
}))

describe('GET /api/sessions performance', () => {
  let directory: string
  let handle: Awaited<ReturnType<typeof import('../index.js').createServerHandle>>
  let baseUrl: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openfox-session-list-'))
    const { createServerHandle } = await import('../index.js')
    handle = await createServerHandle({
      llm: {
        baseUrl: 'http://127.0.0.1:1',
        model: 'test-model',
        timeout: 100,
        idleTimeout: 100,
        backend: 'vllm',
      },
      context: { maxTokens: 200000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 100 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(directory, 'sessions.db') },
      mode: 'test',
      workdir: directory,
    })
    const started = await handle.start(0)
    baseUrl = `http://127.0.0.1:${started.port}`

    const project = createProject('Large session project', directory)
    const session = createSession(project.id, directory, 'Large session')
    getDatabase()
      .prepare('UPDATE sessions SET recent_user_prompts = ? WHERE id = ?')
      .run(JSON.stringify([{ id: 'm1', content: 'Cached prompt', timestamp: '2026-09-04T20:00:00.000Z' }]), session.id)
    getDatabase()
      .prepare('INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(
        session.id,
        1,
        Date.now(),
        'turn.snapshot',
        JSON.stringify({ messages: [], padding: 'x'.repeat(10_000_000) }),
      )
  }, 30_000)

  afterAll(async () => {
    await handle.close()
    closeDatabase()
    await rm(directory, { recursive: true, force: true })
  })

  it('returns lightweight prompts without parsing the snapshot payload', async () => {
    const startedAt = performance.now()
    const response = await fetch(`${baseUrl}/api/sessions`)
    const elapsed = performance.now() - startedAt
    const body = (await response.json()) as {
      sessions: Array<{ recentUserPrompts?: Array<{ id: string }> }>
    }

    expect(response.status).toBe(200)
    expect(body.sessions[0]?.recentUserPrompts?.[0]?.id).toBe('m1')
    expect(elapsed).toBeLessThan(200)
  })
})
