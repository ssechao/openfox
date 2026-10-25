import { describe, expect, it, vi } from 'vitest'
import { consumeAfterAdmission } from './resume-admission.js'

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

  it.each(['full', 'closed'] as const)('never consumes the marker for %s', (admission) => {
    const consume = vi.fn()
    expect(consumeAfterAdmission(() => admission, consume)).toEqual({ admission, consumed: false })
    expect(consume).not.toHaveBeenCalled()
  })
})
