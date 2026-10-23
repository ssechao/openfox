import { describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '../../../shared/types.js'
import type { McpRequestMessage, WorkerIpcIdentity, WorkerMcpResponseMessage } from './protocol.js'
import {
  MAX_MCP_GLOBAL_IN_FLIGHT,
  MAX_MCP_REQUEST_BYTES,
  MAX_MCP_RESPONSE_CHUNK_BYTES,
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_WORKER_IN_FLIGHT,
  WorkerMcpBroker,
} from './mcp-broker.js'

const identity: WorkerIpcIdentity = {
  sessionId: 'session-1',
  workerId: 'worker-1',
  generation: 1,
}

function request(overrides: Partial<McpRequestMessage> = {}): McpRequestMessage {
  return {
    ...identity,
    type: 'mcp.request',
    requestId: crypto.randomUUID(),
    serverName: 'server',
    toolName: 'tool',
    name: 'server_tool',
    args: {},
    messageId: 'message-1',
    toolCallId: 'call-1',
    deadlineMs: 60_000,
    ...overrides,
  }
}

function decode(messages: WorkerMcpResponseMessage[]): ToolResult {
  const chunks = messages.filter((message) => message.type === 'mcp.response.chunk')
  return JSON.parse(
    Buffer.concat(chunks.map((message) => Buffer.from(message.data, 'base64'))).toString('utf8'),
  ) as ToolResult
}

function deferredResult() {
  let resolve!: (value: ToolResult) => void
  const promise = new Promise<ToolResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('WorkerMcpBroker', () => {
  it('chunks responses below the IPC cap and preserves the request identity', async () => {
    const sent: WorkerMcpResponseMessage[] = []
    const output = 'é'.repeat(100_000)
    const broker = new WorkerMcpBroker({
      execute: vi.fn(async () => ({ success: true, output, durationMs: 1, truncated: false })),
      isCurrent: () => true,
      send: (message) => sent.push(message),
      reconcile: vi.fn(),
    })
    const input = request()

    broker.handleRequest(input)
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'mcp.response.end')).toBe(true))

    const chunks = sent.filter((message) => message.type === 'mcp.response.chunk')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((message) => Buffer.byteLength(message.data) <= MAX_MCP_RESPONSE_CHUNK_BYTES)).toBe(true)
    expect(
      chunks.every((message) => message.requestId === input.requestId && message.sessionId === input.sessionId),
    ).toBe(true)
    expect(decode(sent)).toMatchObject({ success: true, output })
  })

  it('rejects stale identities, invalid deadlines, and oversized requests before execution', async () => {
    const sent: WorkerMcpResponseMessage[] = []
    const execute = vi.fn(async () => ({ success: true, durationMs: 1, truncated: false }))
    let current = false
    const broker = new WorkerMcpBroker({
      execute,
      isCurrent: () => current,
      send: (message) => sent.push(message),
      reconcile: vi.fn(),
    })

    broker.handleRequest(request())
    await Promise.resolve()
    expect(execute).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)

    current = true
    broker.handleRequest(request({ deadlineMs: 3_600_001 }))
    broker.handleRequest(request({ args: { value: 'x'.repeat(MAX_MCP_REQUEST_BYTES) } }))
    await vi.waitFor(() => expect(sent.filter((message) => message.type === 'mcp.response.end')).toHaveLength(2))
    expect(execute).not.toHaveBeenCalled()
    expect(decode(sent.slice(0, 2))).toMatchObject({ success: false })
  })

  it('enforces per-worker and global in-flight caps', async () => {
    const sent: WorkerMcpResponseMessage[] = []
    const pending = deferredResult()
    const broker = new WorkerMcpBroker({
      execute: vi.fn(() => pending.promise),
      isCurrent: () => true,
      send: (message) => sent.push(message),
      reconcile: vi.fn(),
    })

    for (let index = 0; index < MAX_MCP_WORKER_IN_FLIGHT; index++) {
      broker.handleRequest(request({ requestId: `worker-${index}` }))
    }
    broker.handleRequest(request({ requestId: 'worker-overflow' }))
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'mcp.response.end')).toBe(true))
    expect(decode(sent)).toMatchObject({ success: false, error: expect.stringContaining('worker') })

    const globalSent: WorkerMcpResponseMessage[] = []
    const globalBroker = new WorkerMcpBroker({
      execute: vi.fn(() => pending.promise),
      isCurrent: () => true,
      send: (message) => globalSent.push(message),
      reconcile: vi.fn(),
    })
    for (let index = 0; index < MAX_MCP_GLOBAL_IN_FLIGHT; index++) {
      globalBroker.handleRequest(
        request({ sessionId: `session-${index}`, workerId: `worker-${index}`, requestId: `global-${index}` }),
      )
    }
    globalBroker.handleRequest(
      request({ sessionId: 'session-overflow', workerId: 'worker-overflow', requestId: 'global-overflow' }),
    )
    await vi.waitFor(() => expect(globalSent.some((message) => message.type === 'mcp.response.end')).toBe(true))
    expect(decode(globalSent)).toMatchObject({ success: false, error: expect.stringContaining('global') })
  })

  it('cancels without replay, records reconciliation, and drops late completion', async () => {
    const sent: WorkerMcpResponseMessage[] = []
    const reconcile = vi.fn()
    const pending = deferredResult()
    const broker = new WorkerMcpBroker({
      execute: vi.fn((_request, signal) => {
        expect(signal.aborted).toBe(false)
        return pending.promise
      }),
      isCurrent: () => true,
      send: (message) => sent.push(message),
      reconcile,
    })
    const input = request()

    broker.handleRequest(input)
    broker.handleCancel({ ...identity, type: 'mcp.cancel', requestId: input.requestId })
    pending.resolve({ success: true, output: 'late', durationMs: 1, truncated: false })
    await Promise.resolve()
    await Promise.resolve()

    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(input)
    expect(sent).toHaveLength(0)
    expect(broker.inFlightCount()).toBe(0)
  })

  it('reconciles a dispatched uncertain result once and refuses replay', async () => {
    const sent: WorkerMcpResponseMessage[] = []
    const reconcile = vi.fn()
    const execute = vi.fn(async () => ({
      success: false,
      error: 'transport disconnected',
      durationMs: 1,
      truncated: false,
      metadata: { reconciliationRequired: true },
    }))
    const broker = new WorkerMcpBroker({
      execute,
      isCurrent: () => true,
      send: (message) => sent.push(message),
      reconcile,
    })
    const input = request({ requestId: 'uncertain' })

    broker.handleRequest(input)
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'mcp.response.end')).toBe(true))
    broker.handleRequest(input)
    await vi.waitFor(() => expect(sent.filter((message) => message.type === 'mcp.response.end')).toHaveLength(2))

    expect(execute).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(input)
    expect(decode(sent.slice(-2))).toMatchObject({ success: false, error: expect.stringContaining('replay') })
  })

  it('marks deadline and oversized-response outcomes uncertain', async () => {
    vi.useFakeTimers()
    const sent: WorkerMcpResponseMessage[] = []
    const reconcile = vi.fn()
    const pending = deferredResult()
    const broker = new WorkerMcpBroker({
      execute: vi.fn((input) => {
        if (input.toolName === 'large') {
          return Promise.resolve({
            success: true,
            output: 'x'.repeat(MAX_MCP_RESPONSE_BYTES + 1),
            durationMs: 1,
            truncated: false,
          })
        }
        return pending.promise
      }),
      isCurrent: () => true,
      send: (message) => sent.push(message),
      reconcile,
    })
    const timed = request({ requestId: 'timed', deadlineMs: 10 })
    const large = request({ requestId: 'large', toolName: 'large' })

    broker.handleRequest(timed)
    await vi.advanceTimersByTimeAsync(10)
    broker.handleRequest(large)
    await vi.runAllTimersAsync()

    expect(reconcile).toHaveBeenCalledWith(timed)
    expect(reconcile).toHaveBeenCalledWith(large)
    expect(sent.filter((message) => message.type === 'mcp.response.end')).toHaveLength(2)
    vi.useRealTimers()
  })
})
