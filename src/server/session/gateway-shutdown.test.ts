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
    interruptedAt: '2026-11-18T12:00:00.000Z',
    workerManager: {
      shutdown: async () => {
        order.push('workers')
        return { sessions: [], stopped: 0, failed: 0 }
      },
    },
    mcpManager: {
      beginShutdown: () => {
        order.push('mcp:begin')
      },
      disconnectAll: async () => {
        order.push('mcp:disconnect')
        return { disconnected: 1, errors: [] }
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
  it('a gateway shutdown raises no unhandled rejection', async () => {
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

  it('the MCP servers are disconnected in order', async () => {
    const { deps, order, logger } = createHarness()

    const result = await runGatewayShutdown(deps)

    expect(result.clean).toBe(true)
    expect(order).toEqual(['mcp:begin', 'workers', 'mcp:disconnect', 'supervisor'])
    const disconnectLines = logger.info.mock.calls.filter(([message]) => message === 'MCP servers disconnected')
    expect(disconnectLines).toHaveLength(1)
    expect(disconnectLines[0]?.[1]).toEqual({ count: 1 })
  })

  it('observes an immediate ancillary rejection while worker shutdown is deferred', async () => {
    let releaseWorker: (() => void) | undefined
    const workerWait = new Promise<void>((resolve) => {
      releaseWorker = resolve
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const { deps, order } = createHarness({
      workerManager: {
        shutdown: async (request) => {
          expect(request).toEqual({ interruptedAt: '2026-11-18T12:00:00.000Z', verdict: 'deferred' })
          order.push('workers:start')
          await workerWait
          order.push('workers:done')
          return { sessions: [{ sessionId: 'active' }], stopped: 1, failed: 0 }
        },
      },
      ancillaryCleanup: Promise.reject(new Error('ancillary failed immediately')),
    })

    let shutdown: ReturnType<typeof runGatewayShutdown> | undefined
    try {
      shutdown = runGatewayShutdown(deps)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      expect(order).toEqual(['mcp:begin', 'workers:start'])
      releaseWorker?.()
      const result = await shutdown

      expect(unhandled).not.toHaveBeenCalled()
      expect(order).toEqual(['mcp:begin', 'workers:start', 'workers:done', 'mcp:disconnect', 'supervisor'])
      expect(result).toMatchObject({
        clean: false,
        interruptedSessionIds: ['active'],
        ancillaryError: 'ancillary failed immediately',
      })
    } finally {
      releaseWorker?.()
      await shutdown?.catch(() => undefined)
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the global verdict blocked when MCP and ancillary cleanup fail', async () => {
    const { deps } = createHarness({
      workerManager: {
        shutdown: async () => ({
          sessions: [{ sessionId: 'active', cleanupError: 'sidecar retained' }],
          stopped: 0,
          failed: 1,
        }),
      },
      mcpManager: {
        beginShutdown: vi.fn(),
        disconnectAll: async () => ({
          disconnected: 1,
          errors: [{ name: 'first', error: 'close failed' }],
        }),
      },
      ancillaryCleanup: Promise.reject(new Error('ancillary failed')),
    })

    const result = await runGatewayShutdown(deps)

    expect(result).toMatchObject({
      clean: false,
      interruptedSessionIds: ['active'],
      workerError: 'active: sidecar retained',
      mcpError: 'first: close failed',
      ancillaryError: 'ancillary failed',
    })
  })
})
