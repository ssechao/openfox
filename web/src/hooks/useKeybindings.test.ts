// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDoublePressBinding } from './useKeybindings'
import type { DoublePressBinding } from '../lib/keybindings'

const SHIFT_BINDING: DoublePressBinding = { type: 'double-press', key: 'Shift', threshold: 300 }

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, ...init })
}

describe('useDoublePressBinding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Start at a non-zero clock so the first press (lastPressRef === 0) is
    // treated as a fresh press rather than a "double-press" within threshold.
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('activates on a pure double-press within the threshold', () => {
    const onActivate = vi.fn()
    renderHook(() => useDoublePressBinding(SHIFT_BINDING, onActivate))

    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })
    vi.advanceTimersByTime(100)
    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })

    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('does NOT activate when a character keydown occurs between the two presses', () => {
    const onActivate = vi.fn()
    renderHook(() => useDoublePressBinding(SHIFT_BINDING, onActivate))

    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })
    // Typing a Shift-character (e.g. "." / "*" on AZERTY) fires a character keydown
    // between the two Shift presses — this must break the double-press.
    vi.advanceTimersByTime(50)
    act(() => {
      window.dispatchEvent(keydown('.'))
    })
    vi.advanceTimersByTime(50)
    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })

    expect(onActivate).not.toHaveBeenCalled()
  })

  it('does NOT activate when the character keydown falls outside the threshold', () => {
    const onActivate = vi.fn()
    renderHook(() => useDoublePressBinding(SHIFT_BINDING, onActivate))

    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })
    vi.advanceTimersByTime(50)
    act(() => {
      window.dispatchEvent(keydown('m'))
    })
    // Second target press arrives well past the threshold after the reset.
    vi.advanceTimersByTime(1000)
    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })

    expect(onActivate).not.toHaveBeenCalled()
  })

  it('still activates on a pure double-press after an earlier, out-of-window character key', () => {
    const onActivate = vi.fn()
    renderHook(() => useDoublePressBinding(SHIFT_BINDING, onActivate))

    // A stray character key, then a fresh pure double-press.
    act(() => {
      window.dispatchEvent(keydown('a'))
    })
    vi.advanceTimersByTime(100)
    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })
    vi.advanceTimersByTime(100)
    act(() => {
      window.dispatchEvent(keydown('Shift'))
    })

    expect(onActivate).toHaveBeenCalledTimes(1)
  })
})
