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
})
