import { describe, expect, it, vi } from 'vitest'
import { runGatewayShutdown, type GatewayShutdownDeps } from './gateway-shutdown.js'

interface Harness {
  deps: GatewayShutdownDeps
  order: string[]
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
}

function createHarness(overrides: Partial<GatewayShutdownDeps> = {}): Harness {
  const order: string[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: GatewayShutdownDeps = {
    workerManager: {
      shutdown: async () => {
        order.push('workers')
      },
    },
    mcpManager: {
      beginShutdown: () => {
        order.push('mcp:begin')
      },
      disconnectAll: async () => {
        order.push('mcp:disconnect')
        return 1
      },
    },
    processSupervisor: {
      shutdown: async () => {
        order.push('supervisor')
      },
    },
    ancillaryCleanup: Promise.resolve(),
    logger,
    ...overrides,
  }
  return { deps, order, logger }
}

describe('gateway shutdown', () => {
  it.fails('a gateway shutdown raises no unhandled rejection', async () => {
    const failure = Object.assign(new Error('Worker child cleanup failed: sidecar retained'), {
      code: 'WORKER_SHUTDOWN_FAILED',
    })
    const { deps, order, logger } = createHarness({
      workerManager: {
        shutdown: async () => {
          order.push('workers')
          throw failure
        },
      },
    })

    const result = await runGatewayShutdown(deps)

    expect(result.clean).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(
      'Session worker shutdown failed',
      expect.objectContaining({ code: 'WORKER_SHUTDOWN_FAILED' }),
    )
    expect(order).toEqual(['mcp:begin', 'workers', 'mcp:disconnect', 'supervisor'])
  })

  it.fails('the MCP servers are disconnected in order', async () => {
    const { deps, order, logger } = createHarness()

    const result = await runGatewayShutdown(deps)

    expect(result.clean).toBe(true)
    expect(order).toEqual(['mcp:begin', 'workers', 'mcp:disconnect', 'supervisor'])
    const disconnectLines = logger.info.mock.calls.filter(([message]) => message === 'MCP servers disconnected')
    expect(disconnectLines).toHaveLength(1)
    expect(disconnectLines[0]?.[1]).toEqual({ count: 1 })
  })
})
