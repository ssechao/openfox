import { describe, expect, it, vi, beforeEach } from 'vitest'

// Distinct client instances per spawn (unlike manager.test.ts's singleton),
// plus a record of every stdio transport created, so a test can assert which
// session id each child was actually handed.
const h = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  transports: [] as Array<{ params: { command?: string; env?: Record<string, string> } }>,
  // When set, every connect() parks on this promise, so a test can hold two
  // callers inside connect at the same time and observe a real race.
  connectGate: null as Promise<void> | null,
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function () {
    const client: Record<string, unknown> = {
      transport: undefined,
      onclose: undefined as (() => void) | undefined,
      connect: vi.fn(async (transport: unknown) => {
        if (h.connectGate) await h.connectGate
        client['transport'] = transport
      }),
      close: vi.fn(async () => {
        client['transport'] = undefined
      }),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: 'ht_send_to_peer',
            description: 'Send a message',
            inputSchema: { type: 'object', properties: { peer_id: { type: 'string' } } },
          },
        ],
      })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
    }
    h.clients.push(client)
    return client
  }),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function (params: { command?: string; env?: Record<string, string> }) {
    const transport = { params, start: vi.fn(), close: vi.fn() }
    h.transports.push(transport)
    return transport
  }),
}))

import { McpManager } from './manager.js'
import { createMcpTools } from './tool-adapter.js'
import type { ToolContext } from '../tools/types.js'

const PER_SESSION = {
  transport: 'stdio' as const,
  command: 'llm-aether',
  perSession: true,
  cachedTools: [
    {
      name: 'ht_send_to_peer',
      description: 'Send a message',
      inputSchema: { type: 'object', properties: { peer_id: { type: 'string' } } },
      estimatedTokens: 10,
    },
  ],
}

beforeEach(() => {
  h.clients.length = 0
  h.transports.length = 0
  h.connectGate = null
})

/** Hold every connect() open until the returned release is called. */
function gateConnections(): () => void {
  let release!: () => void
  h.connectGate = new Promise<void>((resolve) => {
    release = resolve
  })
  return release
}

describe('per-session MCP servers', () => {
  it('connects no shared client and serves its catalogue from the cache', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    expect(h.clients).toHaveLength(0)
    expect(h.transports).toHaveLength(0)
    const server = manager.getServer('llm-aether')
    expect(server?.status).toBe('connected')
    expect(server?.tools.map((t) => t.name)).toEqual(['ht_send_to_peer'])
  })

  it('spawns one child per session, each handed its own OPENFOX_SESSION_ID', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    await manager.ensureSessionClients('session-a')
    await manager.ensureSessionClients('session-b')

    expect(h.clients).toHaveLength(2)
    expect(h.transports).toHaveLength(2)
    const ids = h.transports.map((t) => t.params.env?.['OPENFOX_SESSION_ID']).sort()
    expect(ids).toEqual(['session-a', 'session-b'])
    expect(manager.sessionServerNames('session-a')).toEqual(['llm-aether'])
    expect(manager.sessionServerNames('session-b')).toEqual(['llm-aether'])
  })

  it('is idempotent: a repeated ensure reuses the live child instead of spawning another', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    await manager.ensureSessionClients('session-a')
    await manager.ensureSessionClients('session-a')

    expect(h.clients).toHaveLength(1)
    expect(h.transports).toHaveLength(1)
  })

  it('spawns a single child when two ensures race for the same session', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    const release = gateConnections()
    const first = manager.ensureSessionClients('session-a')
    const second = manager.ensureSessionClients('session-a')
    release()
    await Promise.all([first, second])

    expect(h.clients).toHaveLength(1)
    expect(h.transports).toHaveLength(1)
    expect(manager.sessionServerNames('session-a')).toEqual(['llm-aether'])
  })

  it('leaves no unclosed child behind when a raced session is released', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    const release = gateConnections()
    const first = manager.ensureSessionClients('session-a')
    const second = manager.ensureSessionClients('session-a')
    release()
    await Promise.all([first, second])

    await manager.releaseSessionClients('session-a')

    expect(manager.sessionServerNames('session-a')).toEqual([])
    // Every child that was spawned must be closed: an unclosed one is an
    // orphan process, which on the Aether side is a ghost peer.
    for (const client of h.clients) {
      expect(client['close']).toHaveBeenCalled()
    }
  })

  it('forgets a failed connection so a later ensure can retry', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    const failing = h.clients.length
    h.connectGate = Promise.reject(new Error('spawn failed'))
    await manager.ensureSessionClients('session-a')
    expect(manager.sessionServerNames('session-a')).toEqual([])

    h.connectGate = null
    await manager.ensureSessionClients('session-a')
    expect(manager.sessionServerNames('session-a')).toEqual(['llm-aether'])
    expect(h.clients.length).toBeGreaterThan(failing)
  })

  it('closes the child of a server disconnected while its connect was in flight', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    const release = gateConnections()
    const ensure = manager.ensureSessionClients('session-a')
    const disconnect = manager.disconnectAll()
    release()
    await Promise.all([ensure, disconnect])

    expect(h.clients).toHaveLength(1)
    expect(h.clients[0]?.['close']).toHaveBeenCalled()
    expect(manager.sessionServerNames('session-a')).toEqual([])
  })

  it('closes the child of a server removed from the manager while its connect was in flight', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })

    const release = gateConnections()
    const ensure = manager.ensureSessionClients('session-a')
    manager.removeServer('llm-aether')
    release()
    await ensure

    expect(h.clients).toHaveLength(1)
    expect(h.clients[0]?.['close']).toHaveBeenCalled()
    expect(manager.sessionServerNames('session-a')).toEqual([])
  })

  it('disconnects one per-session server without disturbing its sibling in the same session', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })
    await manager.addServer('other-peer', { ...PER_SESSION, command: 'other-peer' })

    await manager.ensureSessionClients('session-a')
    expect(h.clients).toHaveLength(2)

    await manager.disconnectServer('llm-aether')

    expect(manager.sessionServerNames('session-a')).toEqual(['other-peer'])
    const closed = h.clients.filter((c) => (c['close'] as { mock: { calls: unknown[] } }).mock.calls.length > 0)
    expect(closed).toHaveLength(1)
  })

  it('routes a call to the calling session’s own child', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })
    await manager.ensureSessionClients('session-a')
    await manager.ensureSessionClients('session-b')

    const clientA = h.clients[0]
    const clientB = h.clients[1]

    const result = await manager.callTool('llm-aether', 'ht_send_to_peer', { peer_id: 'x' }, 'session-b')

    expect(result.success).toBe(true)
    expect(clientB?.['callTool']).toHaveBeenCalledTimes(1)
    expect(clientA?.['callTool']).not.toHaveBeenCalled()
  })

  it('refuses a call with no session id instead of guessing a sibling', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })
    await manager.ensureSessionClients('session-a')

    const result = await manager.callTool('llm-aether', 'ht_send_to_peer', { peer_id: 'x' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('session id is required')
    expect(h.clients[0]?.['callTool']).not.toHaveBeenCalled()
  })

  it('releases only the named session’s children', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })
    await manager.ensureSessionClients('session-a')
    await manager.ensureSessionClients('session-b')

    await manager.releaseSessionClients('session-a')

    expect(manager.sessionServerNames('session-a')).toEqual([])
    expect(manager.sessionServerNames('session-b')).toEqual(['llm-aether'])
    expect(h.clients[0]?.['close']).toHaveBeenCalledTimes(1)
    expect(h.clients[1]?.['close']).not.toHaveBeenCalled()
  })

  it('leaves a non-per-session server on its single shared client', async () => {
    const manager = new McpManager()
    await manager.addServer('shared', {
      transport: 'stdio',
      command: 'other-server',
      cachedTools: [],
    })

    expect(h.clients).toHaveLength(1)
    const result = await manager.callTool('shared', 'ht_send_to_peer', { peer_id: 'x' })
    expect(result.success).toBe(true)
  })

  it('threads the calling session into the tool execute path', async () => {
    const manager = new McpManager()
    await manager.addServer('llm-aether', { ...PER_SESSION })
    const tools = createMcpTools(manager)
    const tool = tools.find((t) => t.name === 'llm-aether_ht_send_to_peer')
    expect(tool).toBeDefined()

    await manager.ensureSessionClients('session-z')
    const context = { sessionId: 'session-z', workdir: '/tmp' } as unknown as ToolContext
    await tool!.execute({ peer_id: 'peer' }, context)

    expect(h.transports).toHaveLength(1)
    expect(h.transports[0]?.params.env?.['OPENFOX_SESSION_ID']).toBe('session-z')
    expect(h.clients[0]?.['callTool']).toHaveBeenCalledTimes(1)
  })
})
