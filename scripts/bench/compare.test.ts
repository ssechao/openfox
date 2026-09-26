import { describe, expect, it } from 'vitest'
import { NOISE_PCT, deltaPct, formatDelta, verdict } from './compare.js'

describe('deltaPct', () => {
  it('reports relative change', () => {
    expect(deltaPct(100, 50)).toBeCloseTo(-50)
    expect(deltaPct(100, 150)).toBeCloseTo(50)
    expect(deltaPct(200, 200)).toBe(0)
  })

  it('handles negative baselines by magnitude', () => {
    expect(deltaPct(-100, -50)).toBeCloseTo(50)
  })

  it('returns null when there is nothing to compare', () => {
    expect(deltaPct(null, 50)).toBeNull()
    expect(deltaPct(100, null)).toBeNull()
    expect(deltaPct(0, 50)).toBeNull()
  })
})

describe('verdict', () => {
  it('treats a large drop as better when lower is better', () => {
    expect(verdict(100, 50, false)).toBe('better')
    expect(verdict(100, 150, false)).toBe('worse')
  })

  it('treats a large rise as better when higher is better', () => {
    expect(verdict(60, 120, true)).toBe('better')
    expect(verdict(60, 30, true)).toBe('worse')
  })

  it('calls small changes noise', () => {
    const inside = 100 + NOISE_PCT / 2
    expect(verdict(100, inside, false)).toBe('same')
    expect(verdict(100, 100 - NOISE_PCT / 2, true)).toBe('same')
  })

  it('is same when there is no baseline', () => {
    expect(verdict(null, 42, false)).toBe('same')
    expect(verdict(0, 42, true)).toBe('same')
  })
})

describe('formatDelta', () => {
  it('signs and rounds the percentage', () => {
    expect(formatDelta(-42.34)).toBe('-42.3%')
    expect(formatDelta(7.5)).toBe('+7.5%')
    expect(formatDelta(0)).toBe('0.0%')
  })

  it('renders a missing delta', () => {
    expect(formatDelta(null)).toBe('n/a')
  })
})
