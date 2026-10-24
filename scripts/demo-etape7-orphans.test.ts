import { describe, expect, it } from 'vitest'
import {
  ORPHAN_WINDOW_MAX_MS,
  ORPHAN_WINDOW_MIN_MS,
  orphanAfterSignalMs,
  orphanDelayMs,
  orphanWindowSatisfied,
} from './demo-etape7-orphans.js'

describe('stage 7 zero-orphan observation window', () => {
  it('accepts a check inside [killAt + 2000, killAt + 2500]', () => {
    const killAt = 1_000_000
    const window = { killAt, capturedAt: killAt + 200, checkedAt: killAt + 2_300 }
    expect(orphanWindowSatisfied(window)).toBe(true)
    expect(orphanDelayMs(window)).toBe(2_100)
    expect(orphanAfterSignalMs(window)).toBe(2_300)
  })

  it('rejects a check that is late from the kill signal even when the inventory delta is in range', () => {
    const killAt = 1_000_000
    const window = { killAt, capturedAt: killAt + 800, checkedAt: killAt + 2_800 }
    expect(orphanDelayMs(window)).toBe(2_000)
    expect(orphanAfterSignalMs(window)).toBe(2_800)
    expect(orphanWindowSatisfied(window)).toBe(false)
  })

  it('rejects a check earlier than killAt + 2000', () => {
    const killAt = 1_000_000
    expect(orphanWindowSatisfied({ killAt, capturedAt: killAt + 200, checkedAt: killAt + 1_900 })).toBe(false)
  })

  it('exposes the accepted bounds', () => {
    expect(ORPHAN_WINDOW_MIN_MS).toBe(2_000)
    expect(ORPHAN_WINDOW_MAX_MS).toBe(2_500)
  })
})
