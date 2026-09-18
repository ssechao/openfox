import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HubClient } from './client.js'

const AGENTS_RESPONSE = {
  agents: [
    {
      peer_id: 'agent-a',
      title: 'build-box',
      workdir: '/srv/build',
      hostname: 'build-box',
      capabilities: ['run_command', 'read_file'],
      alive: true,
      last_activity: 1000,
    },
    {
      peer_id: 'agent-b',
      title: 'test-box',
      workdir: '/srv/test',
      hostname: 'test-box',
      capabilities: ['run_command'],
      alive: false,
      last_activity: 100,
    },
  ],
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  )
}

describe('HubClient', () => {
  const client = new HubClient({ hubUrl: 'http://hub:8848/mcp', hubToken: 'tok', callTimeoutMs: 5000 })

  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists agents with metadata', async () => {
    mockFetch(() => Response.json(AGENTS_RESPONSE))
    const agents = await client.listAgents()
    expect(agents).toHaveLength(2)
    expect(agents[0]!).toMatchObject({ peerId: 'agent-a', title: 'build-box', workdir: '/srv/build', alive: true })
    expect(agents[1]!.alive).toBe(false)
  })

  it('sends the Bearer token on every call', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(AGENTS_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    await client.listAgents()
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
  })

  it('executes a tool via the hub (execute + await)', async () => {
    mockFetch((url) => {
      if (url.includes('/ra/agents')) return Response.json(AGENTS_RESPONSE)
      if (url.includes('/ra/execute')) return Response.json({ request_id: 'req-1' })
      if (url.includes('/ra/await'))
        return Response.json({ success: true, output: 'remote-out', durationMs: 3, truncated: false })
      return new Response('not found', { status: 404 })
    })
    const result = await client.executeTool('sess-1', 'build-box', 'run_command', { command: 'pwd' })
    expect(result.success).toBe(true)
    expect(result.output).toBe('remote-out')
  })

  it('rejects an unknown remote with the available agents listed', async () => {
    mockFetch((url) =>
      url.includes('/ra/agents') ? Response.json(AGENTS_RESPONSE) : new Response('x', { status: 404 }),
    )
    await expect(client.executeTool('sess-1', 'ghost', 'run_command', {})).rejects.toThrow(
      /Unknown remote agent "ghost"/,
    )
    await expect(client.executeTool('sess-1', 'ghost', 'run_command', {})).rejects.toThrow(/build-box/)
  })

  it('rejects an offline remote with a 503', async () => {
    mockFetch((url) =>
      url.includes('/ra/agents') ? Response.json(AGENTS_RESPONSE) : new Response('x', { status: 404 }),
    )
    await expect(client.executeTool('sess-1', 'test-box', 'run_command', {})).rejects.toThrow(/offline/)
  })

  it('propagates hub errors as HubClientError', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
    await expect(client.listAgents()).rejects.toMatchObject({ name: 'HubClientError', status: 401 })
  })

  it('uses the control token on control routes and the hub token elsewhere', async () => {
    const controlClient = new HubClient({
      hubUrl: 'http://hub:8848/mcp',
      hubToken: 'hub-tok',
      controlToken: 'control-tok',
      callTimeoutMs: 5000,
    })
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/ra/agents')) return Response.json(AGENTS_RESPONSE)
      if (url.includes('/ra/execute')) return Response.json({ request_id: 'req-1' })
      if (url.includes('/ra/await'))
        return Response.json({ success: true, output: 'out', durationMs: 1, truncated: false })
      return new Response('x', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await controlClient.executeTool('sess-1', 'build-box', 'run_command', {})
    // /ra/agents (control) -> control token.
    const agentsAuth = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(agentsAuth['Authorization']).toBe('Bearer control-tok')
    // /ra/execute (control) -> control token.
    const execAuth = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>
    expect(execAuth['Authorization']).toBe('Bearer control-tok')
    // /ra/await (control) -> control token.
    const awaitAuth = (fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>
    expect(awaitAuth['Authorization']).toBe('Bearer control-tok')
  })

  it('falls back to the hub token on control routes when no control token is set', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(AGENTS_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    await client.listAgents()
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
  })
})
