import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createServerHandle } from './index.js'
import type { ServerHandle } from './context.js'
import type { Config, Provider } from '../shared/types.js'

const SUMMARY = 'SYNTHETIC_COMPACT_SUMMARY'

interface CapturedRequest {
  path: string
  body: Record<string, unknown>
}

async function startResponsesProvider(): Promise<{
  server: Server
  url: string
  requests: CapturedRequest[]
  holdNext: () => () => void
}> {
  const requests: CapturedRequest[] = []
  let responseIndex = 0
  let pendingHold: Promise<void> | null = null
  let releaseHold: (() => void) | null = null
  const holdNext = () => {
    pendingHold = new Promise<void>((resolve) => {
      releaseHold = resolve
    })
    return () => releaseHold?.()
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    req.on('end', async () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      requests.push({ path: req.url ?? '', body })
      responseIndex += 1
      const id = `resp_${responseIndex}`
      const input = JSON.stringify(body['input'] ?? body['messages'] ?? [])
      const text = input.includes('summarizing conversations for continuation')
        ? SUMMARY
        : `MOCK_ANSWER_${responseIndex}`
      const promptTokens = input.includes('NEAR_LIMIT_U1') ? 185_000 : 10
      const completionTokens = input.includes('NEAR_LIMIT_U1') ? 4_000 : 5
      const hold = pendingHold
      pendingHold = null
      if (hold) await hold
      releaseHold = null
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (req.url?.endsWith('/chat/completions')) {
        res.write(
          `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({
            id,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: id, delta: text })}\n\n`)
      res.write(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id,
            status: 'completed',
            output: [],
            usage: {
              input_tokens: promptTokens,
              output_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          },
        })}\n\n`,
      )
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, url: `http://127.0.0.1:${port}/v1`, requests, holdNext }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForIdle(baseUrl: string, sessionId: string, requestCount: () => number, expected: number) {
  await waitFor(() => requestCount() >= expected)
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    if (!response.ok) return false
    const body = (await response.json()) as { session: { isRunning: boolean } }
    return !body.session.isRunning
  })
}

async function createSession(baseUrl: string, projectId: string): Promise<string> {
  const response = await postJson(`${baseUrl}/api/sessions`, { projectId })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { session: { id: string } }
  return body.session.id
}

async function compact(baseUrl: string, sessionId: string): Promise<void> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(wsUrl)
  const messages: Array<Record<string, unknown>> = []
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ id: 'compact', type: 'context.compact', payload: { sessionId } }))
  await waitFor(() => messages.some((message) => message['id'] === 'compact' && message['type'] === 'ack'))
  await waitFor(() => messages.some((message) => message['type'] === 'chat.done'))
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
  ws.close()
  await closed
}

describe('replay before compaction', () => {
  let directory: string
  let provider: Awaited<ReturnType<typeof startResponsesProvider>>
  let handle: ServerHandle
  let config: Config
  let baseUrl: string
  let projectId: string
  let persistedSessionId: string | undefined
  let persistedFirstAnswer: string | undefined
  let persistedReplayAnswer: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openfox-replay-compaction-'))
    provider = await startResponsesProvider()
    const model = 'gpt-5.6-sol'
    const fakeProvider: Provider = {
      id: 'fake-responses',
      name: 'Fake Responses',
      url: provider.url,
      backend: 'openai',
      apiKey: 'test-key',
      apiProtocol: 'responses',
      models: [{ id: model, contextWindow: 200_000, source: 'user' }],
      isActive: true,
      createdAt: new Date().toISOString(),
    }
    const fakeChatProvider: Provider = {
      ...fakeProvider,
      id: 'fake-chat',
      name: 'Fake Chat',
      apiProtocol: 'chat-completions',
      models: [{ id: 'chat-model', contextWindow: 200_000, source: 'user' }],
      isActive: false,
    }
    config = {
      llm: {
        baseUrl: provider.url,
        model,
        timeout: 5_000,
        idleTimeout: 5_000,
        backend: 'openai',
        apiKey: 'test-key',
        apiProtocol: 'responses',
      },
      context: { maxTokens: 200_000, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 5_000 },
      server: { port: 0, host: '127.0.0.1', openBrowser: false },
      database: { path: join(directory, 'sessions.db') },
      logging: { level: 'error' },
      mode: 'test',
      workdir: directory,
      providers: [fakeProvider, fakeChatProvider],
      defaultModelSelection: `${fakeProvider.id}/${model}`,
      activeProviderId: fakeProvider.id,
      globalConfigPath: join(directory, 'config.json'),
      disableAutoSessionTitle: true,
    }
    handle = await createServerHandle(config)
    const { port } = await handle.start(0)
    baseUrl = `http://127.0.0.1:${port}`
    const projectResponse = await postJson(`${baseUrl}/api/projects`, { name: 'Replay', workdir: directory })
    expect(projectResponse.status).toBe(201)
    const project = (await projectResponse.json()) as { project: { id: string } }
    projectId = project.project.id
  }, 30_000)

  afterAll(async () => {
    await handle?.close()
    await new Promise<void>((resolve) => provider?.server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })

  it('sends the preserved prefix and replacement after replaying before a compaction', async () => {
    const sessionId = await createSession(baseUrl, projectId)

    let requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'U1_BEFORE_COMPACTION' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'U2_TO_REPLAY' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

    const beforeCompaction = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ id: string; role: string; content: string }>
    }
    const firstUserIndex = beforeCompaction.messages.findIndex((message) => message.content === 'U1_BEFORE_COMPACTION')
    const secondUserIndex = beforeCompaction.messages.findIndex((message) => message.content === 'U2_TO_REPLAY')
    const firstAnswer = beforeCompaction.messages
      .slice(firstUserIndex + 1, secondUserIndex)
      .find((message) => message.role === 'assistant')
    const secondAnswer = beforeCompaction.messages
      .slice(secondUserIndex + 1)
      .find((message) => message.role === 'assistant')
    const replayedMessage = beforeCompaction.messages[secondUserIndex]
    expect(firstAnswer).toBeDefined()
    expect(secondAnswer).toBeDefined()
    expect(replayedMessage).toBeDefined()

    requestCount = provider.requests.length
    await compact(baseUrl, sessionId)
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'U3_AFTER_COMPACTION' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    const normalContinuationWire = JSON.stringify(provider.requests.at(-1)!.body)
    expect(normalContinuationWire).toContain(SUMMARY)
    expect(normalContinuationWire).toContain('U3_AFTER_COMPACTION')
    expect(normalContinuationWire).not.toContain('U1_BEFORE_COMPACTION')
    expect(normalContinuationWire).not.toContain('U2_TO_REPLAY')

    const chatSwitch = await postJson(`${baseUrl}/api/sessions/${sessionId}/provider`, {
      providerId: 'fake-chat',
      model: 'chat-model',
    })
    expect(chatSwitch.status).toBe(200)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'FUTURE_CHAT_BRANCH' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    expect(provider.requests.at(-1)!.path).toBe('/v1/chat/completions')

    const responsesSwitch = await postJson(`${baseUrl}/api/sessions/${sessionId}/provider`, {
      providerId: 'fake-responses',
      model: 'gpt-5.6-sol',
    })
    expect(responsesSwitch.status).toBe(200)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'FUTURE_RESPONSES_BRANCH' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    expect(provider.requests.at(-1)!.path).toBe('/v1/responses')

    const forkResponse = await postJson(`${baseUrl}/api/sessions/${sessionId}/fork`, {
      messageId: firstAnswer!.id,
      title: 'Historical fork',
    })
    expect(forkResponse.status).toBe(201)
    const fork = (await forkResponse.json()) as { session: { id: string } }
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${fork.session.id}/message`, { content: 'FORK_ONLY_BRANCH' })
    await waitForIdle(baseUrl, fork.session.id, () => provider.requests.length, requestCount + 1)

    requestCount = provider.requests.length
    const replayResponse = await postJson(`${baseUrl}/api/sessions/${sessionId}/replay`, {
      messageId: replayedMessage!.id,
      content: 'U2_REPLACEMENT',
    })
    expect(replayResponse.status).toBe(200)
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

    const replayRequest = provider.requests.at(-1)!
    const wire = JSON.stringify(replayRequest.body)
    expect(replayRequest.path).toBe('/v1/responses')
    expect(replayRequest.body['previous_response_id']).toBeUndefined()
    expect(wire).toContain('U1_BEFORE_COMPACTION')
    expect(wire).toContain(firstAnswer!.content)
    expect(wire).toContain('U2_REPLACEMENT')
    expect(wire).not.toContain('U2_TO_REPLAY')
    expect(wire).not.toContain(secondAnswer!.content)
    expect(wire).not.toContain(SUMMARY)
    expect(wire).not.toContain('U3_AFTER_COMPACTION')
    expect(wire).not.toContain('FUTURE_CHAT_BRANCH')
    expect(wire).not.toContain('FUTURE_RESPONSES_BRANCH')
    expect(wire).not.toContain('FORK_ONLY_BRANCH')

    const afterReplay = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ role: string; content: string }>
    }
    const replacementIndex = afterReplay.messages.findIndex((message) => message.content === 'U2_REPLACEMENT')
    const replayAnswer = afterReplay.messages
      .slice(replacementIndex + 1)
      .find((message) => message.role === 'assistant')
    expect(replayAnswer).toBeDefined()
    persistedSessionId = sessionId
    persistedFirstAnswer = firstAnswer!.content
    persistedReplayAnswer = replayAnswer!.content
  }, 30_000)

  it('uses restored provider usage to compact before the first replay request near the model limit', async () => {
    const sessionId = await createSession(baseUrl, projectId)
    config.context.compactionThreshold = 0
    try {
      let requestCount = provider.requests.length
      await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'NEAR_LIMIT_U1' })
      await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
      requestCount = provider.requests.length
      await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'NEAR_LIMIT_U2' })
      await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

      const before = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
        messages: Array<{ id: string; content: string }>
      }
      const target = before.messages.find((message) => message.content === 'NEAR_LIMIT_U2')!
      await compact(baseUrl, sessionId)
      config.context.compactionThreshold = 0.85

      requestCount = provider.requests.length
      const replay = await postJson(`${baseUrl}/api/sessions/${sessionId}/replay`, {
        messageId: target.id,
        content: 'NEAR_LIMIT_REPLACEMENT',
      })
      expect(replay.status).toBe(200)
      await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

      const requests = provider.requests.slice(requestCount)
      expect(requests.length).toBeGreaterThanOrEqual(1)
      const firstRequest = requests[0]!
      const wire = JSON.stringify(firstRequest.body)
      expect(firstRequest.path).toBe('/v1/responses')
      expect(wire).toContain('summarizing conversations for continuation')
      expect(wire).toContain('NEAR_LIMIT_U1')
      expect(wire).toContain('NEAR_LIMIT_REPLACEMENT')
      expect(firstRequest.body['max_output_tokens']).toBeLessThanOrEqual(8_192)
    } finally {
      config.context.compactionThreshold = 0.85
    }
  }, 30_000)

  it('uses the same restored prefix through Chat Completions without compaction', async () => {
    const sessionId = await createSession(baseUrl, projectId)
    const switchResponse = await postJson(`${baseUrl}/api/sessions/${sessionId}/provider`, {
      providerId: 'fake-chat',
      model: 'chat-model',
    })
    expect(switchResponse.status).toBe(200)

    let requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'CHAT_U1' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'CHAT_U2' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

    const beforeReplay = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ id: string; role: string; content: string }>
    }
    const firstIndex = beforeReplay.messages.findIndex((message) => message.content === 'CHAT_U1')
    const secondIndex = beforeReplay.messages.findIndex((message) => message.content === 'CHAT_U2')
    const firstAnswer = beforeReplay.messages
      .slice(firstIndex + 1, secondIndex)
      .find((message) => message.role === 'assistant')
    const secondAnswer = beforeReplay.messages.slice(secondIndex + 1).find((message) => message.role === 'assistant')
    expect(firstAnswer).toBeDefined()
    expect(secondAnswer).toBeDefined()

    requestCount = provider.requests.length
    const replay = await postJson(`${baseUrl}/api/sessions/${sessionId}/replay`, {
      messageId: beforeReplay.messages[secondIndex]!.id,
      content: 'CHAT_U2_REPLACEMENT',
    })
    expect(replay.status).toBe(200)
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

    const request = provider.requests.at(-1)!
    const wire = JSON.stringify(request.body)
    expect(request.path).toBe('/v1/chat/completions')
    expect(wire).toContain('CHAT_U1')
    expect(wire).toContain(firstAnswer!.content)
    expect(wire).toContain('CHAT_U2_REPLACEMENT')
    expect(wire).not.toContain('"content":"CHAT_U2"')
    expect(wire).not.toContain(secondAnswer!.content)
  }, 30_000)

  it('invalidates Responses continuity after an idle truncate', async () => {
    const sessionId = await createSession(baseUrl, projectId)
    let requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'TRUNCATE_U1' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'TRUNCATE_U2' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

    const before = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ role: string; content: string }>
    }
    const firstUserIndex = before.messages.findIndex((message) => message.content === 'TRUNCATE_U1')
    const secondUserIndex = before.messages.findIndex((message) => message.content === 'TRUNCATE_U2')
    const firstAnswerIndex = before.messages.findIndex(
      (message, index) => index > firstUserIndex && index < secondUserIndex && message.role === 'assistant',
    )
    const firstAnswer = before.messages[firstAnswerIndex]!
    const secondAnswer = before.messages.slice(secondUserIndex + 1).find((message) => message.role === 'assistant')!

    const truncate = await postJson(`${baseUrl}/api/sessions/${sessionId}/truncate`, {
      messageIndex: firstAnswerIndex,
    })
    expect(truncate.status).toBe(200)
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'AFTER_TRUNCATE' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)

    const request = provider.requests.at(-1)!
    const wire = JSON.stringify(request.body)
    expect(request.path).toBe('/v1/responses')
    expect(request.body['previous_response_id']).toBeUndefined()
    expect(wire).toContain('TRUNCATE_U1')
    expect(wire).toContain(firstAnswer.content)
    expect(wire).toContain('AFTER_TRUNCATE')
    expect(wire).not.toContain('TRUNCATE_U2')
    expect(wire).not.toContain(secondAnswer.content)
  }, 30_000)

  it('rejects replay while a turn is active and lets the held response finish normally', async () => {
    const sessionId = await createSession(baseUrl, projectId)
    let requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'ACTIVE_U1' })
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    const state = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ id: string; content: string }>
    }
    const target = state.messages.find((message) => message.content === 'ACTIVE_U1')!

    const release = provider.holdNext()
    requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${sessionId}/message`, { content: 'HELD_ACTIVE_TURN' })
    await waitFor(() => provider.requests.length >= requestCount + 1)
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
      const body = (await response.json()) as { session: { isRunning: boolean } }
      return body.session.isRunning
    })

    const replay = await postJson(`${baseUrl}/api/sessions/${sessionId}/replay`, {
      messageId: target.id,
      content: 'MUST_NOT_RUN',
    })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toEqual({ error: 'Cannot replay while session is running' })

    const truncate = await postJson(`${baseUrl}/api/sessions/${sessionId}/truncate`, { messageIndex: 0 })
    expect(truncate.status).toBe(409)
    expect(await truncate.json()).toEqual({ error: 'Cannot truncate while session is running' })
    expect(provider.requests).toHaveLength(requestCount + 1)

    release()
    await waitForIdle(baseUrl, sessionId, () => provider.requests.length, requestCount + 1)
    const after = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ content: string }>
    }
    expect(after.messages.some((message) => message.content === 'ACTIVE_U1')).toBe(true)
    expect(after.messages.some((message) => message.content === 'HELD_ACTIVE_TURN')).toBe(true)
    expect(after.messages.some((message) => message.content === 'MUST_NOT_RUN')).toBe(false)
  }, 30_000)

  it('keeps the restored history after restarting on the same database', async () => {
    expect(persistedSessionId).toBeDefined()
    expect(persistedFirstAnswer).toBeDefined()
    expect(persistedReplayAnswer).toBeDefined()

    await handle.close()
    handle = await createServerHandle(config)
    const { port } = await handle.start(0)
    baseUrl = `http://127.0.0.1:${port}`

    const requestCount = provider.requests.length
    await postJson(`${baseUrl}/api/sessions/${persistedSessionId}/message`, { content: 'AFTER_RESTART' })
    await waitForIdle(baseUrl, persistedSessionId!, () => provider.requests.length, requestCount + 1)

    const request = provider.requests.at(-1)!
    const wire = JSON.stringify(request.body)
    expect(request.path).toBe('/v1/responses')
    expect(request.body['previous_response_id']).toBeUndefined()
    expect(wire).toContain('U1_BEFORE_COMPACTION')
    expect(wire).toContain(persistedFirstAnswer!)
    expect(wire).toContain('U2_REPLACEMENT')
    expect(wire).toContain(persistedReplayAnswer!)
    expect(wire).toContain('AFTER_RESTART')
    expect(wire).not.toContain('U2_TO_REPLAY')
    expect(wire).not.toContain(SUMMARY)
  }, 30_000)
})
