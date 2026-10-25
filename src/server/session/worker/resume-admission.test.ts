import { describe, expect, it, vi } from 'vitest'
import { admitWithStartFailure, consumeAfterAdmission } from './resume-admission.js'

describe('interrupted workflow resume admission', () => {
  it('keeps the marker on saturation and consumes it only after a retry is queued', () => {
    let interrupted = true
    const consume = vi.fn(() => {
      interrupted = false
    })
    const admissions = ['full', 'waiting'] as const
    let attempt = 0

    const refused = consumeAfterAdmission(() => admissions[attempt++]!, consume)
    expect(refused).toEqual({ admission: 'full', consumed: false })
    expect(interrupted).toBe(true)
    expect(consume).not.toHaveBeenCalled()

    const accepted = consumeAfterAdmission(() => admissions[attempt++]!, consume)
    expect(accepted).toEqual({ admission: 'waiting', consumed: true })
    expect(interrupted).toBe(false)
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('throws an immediate start failure before admission can consume the marker', () => {
    const deferredFailure = vi.fn()
    expect(() =>
      admitWithStartFailure(
        (start) => {
          start()
          return 'started'
        },
        () => {
          throw new Error('spawn failed')
        },
        deferredFailure,
      ),
    ).toThrow('spawn failed')
    expect(deferredFailure).not.toHaveBeenCalled()
  })

  it('reports a start failure that occurs after a waiting admission returns', () => {
    let start: (() => void) | undefined
    const deferredFailure = vi.fn()
    expect(
      admitWithStartFailure(
        (admittedStart) => {
          start = admittedStart
          return 'waiting'
        },
        () => {
          throw new Error('token failed')
        },
        deferredFailure,
      ),
    ).toBe('waiting')

    start?.()
    expect(deferredFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'token failed' }))
  })

  it.each(['full', 'closed'] as const)('never consumes the marker for %s', (admission) => {
    const consume = vi.fn()
    expect(consumeAfterAdmission(() => admission, consume)).toEqual({ admission, consumed: false })
    expect(consume).not.toHaveBeenCalled()
  })
})
