import { availableParallelism } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { SessionTurnScheduler, resolveSessionWorkerEnabled, resolveWorkerPoolSize } from './scheduler.js'

describe('SessionTurnScheduler', () => {
  it('enables worker mode by default and honors an explicit disable', () => {
    expect(resolveSessionWorkerEnabled(undefined, undefined)).toBe(true)
    expect(resolveSessionWorkerEnabled('false', undefined)).toBe(false)
    expect(resolveSessionWorkerEnabled(undefined, 'false')).toBe(false)
    expect(resolveSessionWorkerEnabled('true', 'false')).toBe(true)
    expect(resolveSessionWorkerEnabled(undefined, undefined, false)).toBe(false)
  })

  it('uses the bounded default and clamps configured capacity', () => {
    expect(resolveWorkerPoolSize(undefined, 12)).toBe(4)
    expect(resolveWorkerPoolSize(undefined, 2)).toBe(1)
    expect(resolveWorkerPoolSize('0', 12)).toBe(1)
    expect(resolveWorkerPoolSize('99', 12)).toBe(32)
    expect(resolveWorkerPoolSize('7', 12)).toBe(7)
    expect(resolveWorkerPoolSize('invalid', 12)).toBe(Math.min(4, Math.max(1, availableParallelism() - 1)))
  })

  it('starts distinct sessions concurrently only up to the configured maximum', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 2, maxWaitingSessions: 64 })
    const starts: string[] = []

    expect(scheduler.admit('a', () => starts.push('a'))).toBe('started')
    expect(scheduler.admit('b', () => starts.push('b'))).toBe('started')
    expect(scheduler.admit('c', () => starts.push('c'))).toBe('waiting')
    expect(starts).toEqual(['a', 'b'])
    expect(scheduler.snapshot()).toEqual({ active: ['a', 'b'], waiting: ['c'], closed: false })

    scheduler.release('a')
    expect(starts).toEqual(['a', 'b', 'c'])
  })

  it('queues repeated commands per session and rotates that session to the FIFO tail', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 64 })
    const starts: string[] = []

    expect(scheduler.admit('a', () => starts.push('a1'))).toBe('started')
    expect(scheduler.admit('a', () => starts.push('a2'))).toBe('waiting')
    expect(scheduler.admit('b', () => starts.push('b1'))).toBe('waiting')
    expect(scheduler.admit('b', () => starts.push('b2'))).toBe('waiting')
    expect(scheduler.admit('c', () => starts.push('c1'))).toBe('waiting')

    scheduler.release('a')
    expect(starts).toEqual(['a1', 'b1'])
    scheduler.release('b')
    expect(starts).toEqual(['a1', 'b1', 'c1'])
    scheduler.release('c')
    expect(starts).toEqual(['a1', 'b1', 'c1', 'a2'])
    scheduler.release('a')
    expect(starts).toEqual(['a1', 'b1', 'c1', 'a2', 'b2'])
  })

  it('rejects saturation before start and cancels a waiting session without allocating a slot', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 2 })
    const start = vi.fn()

    expect(scheduler.admit('active', start)).toBe('started')
    expect(scheduler.admit('waiting-1', start)).toBe('waiting')
    expect(scheduler.admit('waiting-2', start)).toBe('waiting')
    expect(scheduler.admit('rejected', start)).toBe('full')
    expect(scheduler.cancel('waiting-1')).toBe('waiting')
    expect(scheduler.cancel('missing')).toBe('none')

    scheduler.release('active')
    expect(scheduler.snapshot()).toEqual({ active: ['waiting-2'], waiting: [], closed: false })
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('refuses only after a session command queue reaches its explicit limit', () => {
    const scheduler = new SessionTurnScheduler({
      maxConcurrent: 1,
      maxWaitingSessions: 64,
      maxQueuedCommandsPerSession: 2,
    })

    expect(scheduler.admit('active', () => {})).toBe('started')
    expect(scheduler.admit('active', () => {})).toBe('waiting')
    expect(scheduler.admit('active', () => {})).toBe('waiting')
    expect(scheduler.canAccept('active')).toBe(false)
    expect(scheduler.admit('active', () => {})).toBe('full')
  })

  it('closes admissions atomically and removes all waiting tickets', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 2 })
    scheduler.admit('active', () => {})
    scheduler.admit('waiting', () => {})

    expect(scheduler.closeAdmissions()).toEqual(['waiting'])
    expect(scheduler.admit('late', () => {})).toBe('closed')
    expect(scheduler.snapshot()).toEqual({ active: ['active'], waiting: [], closed: true })
  })

  it('rolls back an immediate start failure and admits the next session', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 64 })
    const starts: string[] = []

    const broken = scheduler.admit('broken', () => {
      throw new Error('start failed')
    }) as string
    expect(broken).toBe('start_failed')
    expect(scheduler.snapshot().active).not.toContain('broken')

    const next = scheduler.admit('next', () => starts.push('next')) as string
    expect(next).toBe('started')
    expect(starts).toEqual(['next'])
    expect(scheduler.snapshot()).toEqual({ active: ['next'], waiting: [], closed: false })
  })

  it('skips a failed awakened start and continues the FIFO queue', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 64 })
    const starts: string[] = []

    expect(scheduler.admit('active', () => starts.push('active'))).toBe('started')
    expect(
      scheduler.admit('broken', () => {
        throw new Error('start failed')
      }),
    ).toBe('waiting')
    expect(scheduler.admit('next', () => starts.push('next'))).toBe('waiting')

    scheduler.release('active')
    expect(starts).toEqual(['active', 'next'])
    expect(scheduler.snapshot()).toEqual({ active: ['next'], waiting: [], closed: false })
  })

  it.fails('keeps the replacement reservation when an awakened start releases and throws', () => {
    const scheduler = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 64 })
    const starts: string[] = []

    expect(scheduler.admit('A', () => starts.push('A'))).toBe('started')
    expect(
      scheduler.admit('B', () => {
        starts.push('B1')
        scheduler.release('B')
        scheduler.admit('C', () => starts.push('C'))
        throw new Error('start failed')
      }),
    ).toBe('waiting')
    expect(scheduler.admit('B', () => starts.push('B2'))).toBe('waiting')

    scheduler.release('A')

    expect(scheduler.snapshot()).toEqual({ active: ['B'], waiting: ['C'], closed: false })
    expect(starts.filter((name) => name === 'B2')).toHaveLength(1)
    expect(starts).toEqual(['A', 'B1', 'B2'])
  })
})
