import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  clients: [] as Array<{ callTool: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function () {
    const client = {
      transport: undefined as unknown,
      onclose: undefined as (() => void) | undefined,
      connect: vi.fn(async (transport: unknown) => {
        client.transport = transport
      }),
      close: vi.fn(async () => {
        client.transport = undefined
      }),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: 'mcp_execute_tool',
            description: 'Execute a target MCP tool',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                server_name: { type: 'string' },
                arguments: { type: 'object' },
              },
            },
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
  StdioClientTransport: vi.fn(function () {
    return { start: vi.fn(), close: vi.fn() }
  }),
}))

import { McpManager } from './manager.js'
import { createMcpTools } from './tool-adapter.js'
import type { McpServerConfig } from './types.js'
import type { ToolContext } from '../tools/types.js'

const PROXY: McpServerConfig = {
  transport: 'stdio',
  command: 'mcp-lazy',
  sessionIdInjection: { 'llm-aether': 'session_id' },
}

function forwardedArgs(): Record<string, unknown> {
  const call = h.clients[0]!.callTool.mock.calls.at(-1)![0] as { arguments: Record<string, unknown> }
  return call.arguments
}

async function proxyManager(config: McpServerConfig = PROXY): Promise<McpManager> {
  const manager = new McpManager()
  await manager.addServer('mcp-lazy', config)
  return manager
}

beforeEach(() => {
  h.clients.length = 0
})

describe('session id injection through a proxy server', () => {
  it('writes the calling session into the arguments forwarded to the targeted server', async () => {
    const manager = await proxyManager()

    const result = await manager.callTool(
      'mcp-lazy',
      'mcp_execute_tool',
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: { peer_id: 'p', message: 'm' } },
      'session-a',
    )

    expect(result.success).toBe(true)
    expect(forwardedArgs()).toEqual({
      server_name: 'llm-aether',
      tool_name: 'ht_send_to_peer',
      arguments: { peer_id: 'p', message: 'm', session_id: 'session-a' },
    })
  })

  it('overwrites a session id supplied by the model', async () => {
    const manager = await proxyManager()

    await manager.callTool(
      'mcp-lazy',
      'mcp_execute_tool',
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: { session_id: 'session-other' } },
      'session-a',
    )

    expect((forwardedArgs()['arguments'] as Record<string, unknown>)['session_id']).toBe('session-a')
  })

  it('creates the arguments object when the model omitted it', async () => {
    const manager = await proxyManager()

    await manager.callTool(
      'mcp-lazy',
      'mcp_execute_tool',
      { server_name: 'llm-aether', tool_name: 'ht_get_contact_info' },
      'session-a',
    )

    expect(forwardedArgs()['arguments']).toEqual({ session_id: 'session-a' })
  })

  it('leaves calls to other downstream servers untouched', async () => {
    const manager = await proxyManager()
    const args = { server_name: 'playwright', tool_name: 'browser_navigate', arguments: { url: 'https://x' } }

    await manager.callTool('mcp-lazy', 'mcp_execute_tool', args, 'session-a')

    expect(forwardedArgs()).toEqual({
      server_name: 'playwright',
      tool_name: 'browser_navigate',
      arguments: { url: 'https://x' },
    })
  })

  it('ignores a downstream name that only matches an inherited object key', async () => {
    const manager = await proxyManager()
    const args = { server_name: 'toString', tool_name: 't', arguments: { a: 1 } }

    const result = await manager.callTool('mcp-lazy', 'mcp_execute_tool', args, 'session-a')

    expect(result.success).toBe(true)
    expect(forwardedArgs()).toEqual({ server_name: 'toString', tool_name: 't', arguments: { a: 1 } })
  })

  it('leaves a server without sessionIdInjection untouched', async () => {
    const manager = await proxyManager({ transport: 'stdio', command: 'mcp-lazy' })

    await manager.callTool(
      'mcp-lazy',
      'mcp_execute_tool',
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: { peer_id: 'p' } },
      'session-a',
    )

    expect(forwardedArgs()['arguments']).toEqual({ peer_id: 'p' })
  })

  it('refuses a targeted call made without a calling session', async () => {
    const manager = await proxyManager()

    const result = await manager.callTool('mcp-lazy', 'mcp_execute_tool', {
      server_name: 'llm-aether',
      tool_name: 'ht_send_to_peer',
      arguments: { peer_id: 'p', session_id: 'session-forged' },
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/session id is required/)
    expect(h.clients[0]!.callTool).not.toHaveBeenCalled()
  })

  it.each([
    ['a string', 'x'],
    ['an array', ['x']],
    ['null', null],
  ])('refuses a targeted call whose arguments are %s', async (_label, value) => {
    const manager = await proxyManager()

    const result = await manager.callTool(
      'mcp-lazy',
      'mcp_execute_tool',
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: value },
      'session-a',
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/must be an object/)
    expect(h.clients[0]!.callTool).not.toHaveBeenCalled()
  })

  it('does not mutate the arguments it was given', async () => {
    const manager = await proxyManager()
    const inner = { peer_id: 'p', session_id: 'session-other' }
    const args = { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: inner }

    await manager.callTool('mcp-lazy', 'mcp_execute_tool', args, 'session-a')

    expect(inner).toEqual({ peer_id: 'p', session_id: 'session-other' })
    expect(args.arguments).toBe(inner)
  })

  it('attributes a model tool call to the session executing it, not to the id the model wrote', async () => {
    const manager = await proxyManager()
    const tool = createMcpTools(manager).find((t) => t.name === 'mcp-lazy_mcp_execute_tool')
    expect(tool).toBeDefined()

    const context = { sessionId: 'session-real', workdir: '/tmp' } as unknown as ToolContext
    const result = await tool!.execute(
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: { peer_id: 'p', session_id: 'forged' } },
      context,
    )

    expect(result.success).toBe(true)
    expect(forwardedArgs()['arguments']).toEqual({ peer_id: 'p', session_id: 'session-real' })
  })
})
