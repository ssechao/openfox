import { describe, expect, it, vi } from 'vitest'
import { startContinuationServices } from './startup-order.js'

describe('startContinuationServices', () => {
  it('waits for supervisor readiness before enabling continuation services', async () => {
    let markReady!: () => void
    const supervisorReady = new Promise<void>((resolve) => {
      markReady = resolve
    })
    const calls: string[] = []
    const started = startContinuationServices({
      startSupervisor: async () => {
        calls.push('supervisor.start')
        await supervisorReady
        calls.push('supervisor.ready')
      },
      configureSupervisor: () => calls.push('supervisor.configure'),
      startQueueProcessor: () => calls.push('queue.start'),
      runBootAutoContinuations: () => calls.push('boot.continue'),
      startTaskScheduler: () => calls.push('tasks.start'),
    })

    await vi.waitFor(() => expect(calls).toEqual(['supervisor.start']))
    markReady()
    await started

    expect(calls).toEqual([
      'supervisor.start',
      'supervisor.ready',
      'supervisor.configure',
      'queue.start',
      'boot.continue',
      'tasks.start',
    ])
  })

  it('does not enable continuation services when supervisor readiness fails', async () => {
    const startQueueProcessor = vi.fn()
    const runBootAutoContinuations = vi.fn()
    const startTaskScheduler = vi.fn()

    await expect(
      startContinuationServices({
        startSupervisor: async () => {
          throw new Error('supervisor unavailable')
        },
        configureSupervisor: vi.fn(),
        startQueueProcessor,
        runBootAutoContinuations,
        startTaskScheduler,
      }),
    ).rejects.toThrow('supervisor unavailable')

    expect(startQueueProcessor).not.toHaveBeenCalled()
    expect(runBootAutoContinuations).not.toHaveBeenCalled()
    expect(startTaskScheduler).not.toHaveBeenCalled()
  })
})
