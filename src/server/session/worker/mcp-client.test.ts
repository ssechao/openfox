import { describe, expect, it, vi } from 'vitest'
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerMcpTool, WorkerToGatewayMessage } from './protocol.js'
import { WorkerMcpClient } from './mcp-client.js'
import { MAX_MCP_REQUEST_BYTES } from './mcp-broker.js'

const identity: WorkerIpcIdentity = { sessionId: 'session-1', workerId: 'worker-1', generation: 2 }
const descriptor: WorkerMcpTool = {
  name: 'server_tool',
  serverName: 'server',
  toolName: 'tool',
  definition: {
    type: 'function',
    function: { name: 'server_tool', description: 'tool', parameters: { type: 'object' } },
  },
}

describe('WorkerMcpClient', () => {
  it('executes a gateway MCP tool and rejects stale response identities', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const tool = client.createTools([descriptor])[0]!
    const pending = tool.execute(
      { value: 1 },
      {
        sessionId: identity.sessionId,
        workdir: '/tmp',
        sessionManager: {} as never,
        toolCallId: 'call-1',
        messageId: 'message-1',
        agentTimeout: 1234,
      },
    )
    const request = sent[0]
    expect(request).toMatchObject({
      ...identity,
      type: 'mcp.request',
      serverName: 'server',
      toolName: 'tool',
      deadlineMs: 1234,
    })
    if (request?.type !== 'mcp.request') throw new Error('request not sent')

    const encoded = Buffer.from(
      JSON.stringify({ success: true, output: 'ok', durationMs: 4, truncated: false }),
    ).toString('base64')
    client.handleMessage({
      ...identity,
      generation: identity.generation + 1,
      type: 'mcp.response.chunk',
      requestId: request.requestId,
      index: 0,
      data: encoded,
    })
    client.handleMessage({
      ...identity,
      type: 'mcp.response.chunk',
      requestId: request.requestId,
      index: 0,
      data: encoded,
    })
    client.handleMessage({
      ...identity,
      type: 'mcp.response.end',
      requestId: request.requestId,
      chunks: 1,
    })

    await expect(pending).resolves.toMatchObject({ success: true, output: 'ok' })
  })

  it('injects the worker session id before sending a proxied MCP request', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const proxy = {
      ...descriptor,
      sessionIdInjection: { 'llm-aether': 'openfox_session_id' },
    }
    const inner = { peer_id: 'peer', openfox_session_id: 'shared-fallback' }
    const tool = client.createTools([proxy])[0]!
    const pending = tool.execute(
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: inner },
      {
        sessionId: identity.sessionId,
        workdir: '/tmp',
        sessionManager: {} as never,
        toolCallId: 'call-proxy',
        messageId: 'message-proxy',
      },
    )

    expect(sent[0]).toMatchObject({
      type: 'mcp.request',
      args: {
        server_name: 'llm-aether',
        tool_name: 'ht_send_to_peer',
        arguments: { peer_id: 'peer', openfox_session_id: identity.sessionId },
      },
    })
    expect(inner).toEqual({ peer_id: 'peer', openfox_session_id: 'shared-fallback' })
    client.cancelAll()
    await pending
  })

  it('refuses a proxied MCP request that cannot carry the worker session id', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const proxy = {
      ...descriptor,
      sessionIdInjection: { 'llm-aether': 'openfox_session_id' },
    }
    const pending = client.createTools([proxy])[0]!.execute(
      { server_name: 'llm-aether', tool_name: 'ht_send_to_peer', arguments: 'invalid' },
      {
        sessionId: identity.sessionId,
        workdir: '/tmp',
        sessionManager: {} as never,
        toolCallId: 'call-invalid-proxy',
        messageId: 'message-invalid-proxy',
      },
    )

    await Promise.resolve()
    if (sent.length > 0) client.cancelAll()
    await expect(pending).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('must be an object'),
    })
    expect(sent).toEqual([])
  })

  it('rejects oversized requests before IPC emission', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const tool = client.createTools([descriptor])[0]!

    await expect(
      tool.execute(
        { value: 'x'.repeat(MAX_MCP_REQUEST_BYTES) },
        {
          sessionId: identity.sessionId,
          workdir: '/tmp',
          sessionManager: {} as never,
          toolCallId: 'call-oversized',
          messageId: 'message-oversized',
        },
      ),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('exceeds') })
    expect(sent).toEqual([])
    expect(client.pendingCount()).toBe(0)
  })

  it('cancels one request through IPC without terminating the client', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const tool = client.createTools([descriptor])[0]!
    const controller = new AbortController()
    const pending = tool.execute(
      {},
      {
        sessionId: identity.sessionId,
        workdir: '/tmp',
        sessionManager: {} as never,
        toolCallId: 'call-1',
        messageId: 'message-1',
        signal: controller.signal,
      },
    )
    controller.abort()

    await expect(pending).resolves.toMatchObject({
      success: false,
      metadata: { reconciliationRequired: true },
    })
    expect(sent.map((message) => message.type)).toEqual(['mcp.request', 'mcp.cancel'])
    expect(client.pendingCount()).toBe(0)
  })

  it('rejects malformed, oversized, and incomplete response chunks', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const tool = client.createTools([descriptor])[0]!
    const pending = tool.execute(
      {},
      {
        sessionId: identity.sessionId,
        workdir: '/tmp',
        sessionManager: {} as never,
        toolCallId: 'call-1',
        messageId: 'message-1',
      },
    )
    const request = sent[0]
    if (request?.type !== 'mcp.request') throw new Error('request not sent')

    client.handleMessage({
      ...identity,
      type: 'mcp.response.end',
      requestId: request.requestId,
      chunks: 1,
    })

    await expect(pending).resolves.toMatchObject({ success: false })
    expect(sent.at(-1)?.type).toBe('mcp.cancel')
  })

  it('drops late responses after cancellation', async () => {
    const sent: WorkerToGatewayMessage[] = []
    const client = new WorkerMcpClient(identity, (message) => sent.push(message))
    const tool = client.createTools([descriptor])[0]!
    const controller = new AbortController()
    const pending = tool.execute(
      {},
      {
        sessionId: identity.sessionId,
        workdir: '/tmp',
        sessionManager: {} as never,
        toolCallId: 'call-1',
        messageId: 'message-1',
        signal: controller.signal,
      },
    )
    const request = sent[0]
    if (request?.type !== 'mcp.request') throw new Error('request not sent')
    controller.abort()
    await pending

    const spy = vi.spyOn(JSON, 'parse')
    const late: GatewayToWorkerMessage = {
      ...identity,
      type: 'mcp.response.chunk',
      requestId: request.requestId,
      index: 0,
      data: Buffer.from('{}').toString('base64'),
    }
    client.handleMessage(late)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
