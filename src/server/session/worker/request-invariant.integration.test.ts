import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../shared/types.js'
import type { ServerHandle } from '../../context.js'
import { closeDatabase } from '../../db/index.js'
import { computeResponsesRequestInvariantHashes } from '../../llm/request-invariant.js'
import type { ResponsesRequestBody } from '../../llm/responses-native.js'

describe('request invariant stability across turns', () => {
  let llm: Server
  let llmBaseUrl: string
  let responseBodies: ResponsesRequestBody[]
  const roots: string[] = []
  let responseSequence = 0

  beforeAll(async () => {
    responseBodies = []
    llm = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'gpt-5.6-luna' }] }))
        return
      }

      let raw = ''
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      request.on('end', () => {
        responseBodies.push(JSON.parse(raw) as ResponsesRequestBody)
        responseSequence += 1
        const id = `resp-${responseSequence}`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ type: 'response.created', response_id: id })}\n\n`)
        response.write(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: id, delta: 'done' })}\n\n`,
        )
        response.write(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response_id: id,
            response: {
              id,
              status: 'completed',
              output: [],
              usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
            },
          })}\n\n`,
        )
        response.end()
      })
    })
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve))
    llmBaseUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => llm.close(() => resolve()))
    for (const root of roots) await rm(root, { recursive: true, force: true })
    delete process.env['OPENFOX_SESSION_WORKER']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    closeDatabase()
  })

  async function runTwoTurns(worker: boolean): Promise<{
    hashes: ReturnType<typeof computeResponsesRequestInvariantHashes>[]
    debug: string[]
  }> {
    responseBodies.length = 0
    process.env['OPENFOX_SESSION_WORKER'] = worker ? 'true' : 'false'
    process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = worker ? 'true' : 'false'
    const root = join(tmpdir(), `openfox-request-invariant-${worker ? 'worker' : 'gateway'}-${randomUUID()}`)
    roots.push(root)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const config: Config = {
      mode: 'test',
      llm: {
        baseUrl: llmBaseUrl,
        model: 'gpt-5.6-luna',
        backend: 'openai',
        timeout: 30_000,
        idleTimeout: 30_000,
        reasoningEffort: 'high',
      },
      context: { maxTokens: 100_000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120_000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: join(root, 'sessions.db') },
      logging: { level: 'debug' },
      workdir: root,
      globalConfigPath: join(root, 'config.json'),
    }
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { createServerHandle } = await import('../../index.js')
    const server: ServerHandle = await createServerHandle(config)

    try {
      const { port } = await server.start(0)
      const base = `http://127.0.0.1:${port}`
      const projectResponse = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'request-invariant', workdir: projectDir }),
      })
      const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
      const sessionResponse = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, title: 'Stable request invariant' }),
      })
      const sessionId = ((await sessionResponse.json()) as { session: { id: string } }).session.id

      for (const content of ['first stable request', 'second request']) {
        const before = responseBodies.length
        const response = await fetch(`${base}/api/sessions/${sessionId}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        expect(response.status).toBe(200)
        await waitFor(async () => {
          const view = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as {
            session: { isRunning: boolean }
          }
          return responseBodies.length > before && !view.session.isRunning
        })
      }

      const bodies = responseBodies.filter((body) => Array.isArray(body.input)).slice(-2)
      expect(bodies).toHaveLength(2)
      return {
        hashes: bodies.map(computeResponsesRequestInvariantHashes),
        debug: debugSpy.mock.calls
          .flat()
          .map(String)
          .filter((line) => line.includes('LLM request invariant hashes')),
      }
    } finally {
      await server.close()
      debugSpy.mockRestore()
      closeDatabase()
    }
  }

  it.each([
    ['without worker', false],
    ['with worker', true],
  ])(
    'keeps both hashes stable for two turns %s',
    async (_label, worker) => {
      const result = await runTwoTurns(worker)

      expect(result.hashes[1]).toEqual(result.hashes[0])
      expect(result.debug).toHaveLength(2)
      expect(result.debug.every((line) => !line.includes('first stable request'))).toBe(true)
    },
    240_000,
  )
})

async function waitFor(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 120_000
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for two-turn invariant probe')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
