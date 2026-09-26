import { describe, expect, it } from 'vitest'
import { PERFORMANCE_SETTINGS, PERFORMANCE_SETTING_ALIASES, resolvePerformanceSettings } from './settings.js'

describe('resolvePerformanceSettings', () => {
  it('applies nothing when unset or empty', () => {
    expect(resolvePerformanceSettings(undefined)).toEqual({})
    expect(resolvePerformanceSettings('')).toEqual({})
    expect(resolvePerformanceSettings('  ')).toEqual({})
  })

  it('applies every setting for 1 or all', () => {
    expect(resolvePerformanceSettings('1')).toEqual(PERFORMANCE_SETTINGS)
    expect(resolvePerformanceSettings('all')).toEqual(PERFORMANCE_SETTINGS)
    expect(Object.keys(resolvePerformanceSettings('all'))).toHaveLength(5)
  })

  it('applies a single aliased setting', () => {
    expect(resolvePerformanceSettings('virtualization')).toEqual({ 'display.feedVirtualization': 'true' })
  })

  it('applies a comma-separated subset, ignoring blanks', () => {
    expect(resolvePerformanceSettings('virtualization, defer-highlight')).toEqual({
      'display.feedVirtualization': 'true',
      'display.deferCodeHighlightWhileStreaming': 'true',
    })
    expect(resolvePerformanceSettings('virtualization,')).toEqual({ 'display.feedVirtualization': 'true' })
  })

  it('covers every perf setting with an alias', () => {
    const aliased = new Set(Object.values(PERFORMANCE_SETTING_ALIASES))
    for (const key of Object.keys(PERFORMANCE_SETTINGS)) {
      expect(aliased.has(key)).toBe(true)
    }
  })

  it('writes a setting off with the no- prefix', () => {
    expect(resolvePerformanceSettings('no-virtualization')).toEqual({ 'display.feedVirtualization': 'false' })
    expect(resolvePerformanceSettings('no-virtualization,no-native-scrollbars')).toEqual({
      'display.feedVirtualization': 'false',
      'display.useNativeScrollbars': 'false',
    })
  })

  it('rejects an unknown alias behind the no- prefix too', () => {
    expect(() => resolvePerformanceSettings('no-native-scrollbar')).toThrow(/Unknown BENCH_PERF_SETTINGS entry/)
  })

  it('throws on an unknown alias instead of silently measuring nothing', () => {
    expect(() => resolvePerformanceSettings('native-scrollbar')).toThrow(/Unknown BENCH_PERF_SETTINGS entry/)
    expect(() => resolvePerformanceSettings('native-scrollbar')).toThrow(/native-scrollbars/)
  })
})
