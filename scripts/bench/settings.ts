/**
 * Display settings the UI groups under "Performance"
 * (`PERF_TOGGLES` in web/src/components/settings/tabs/DisplayTab.tsx).
 *
 * Kept as literals so the benchmark never imports web UI code. Each entry has a
 * short alias so `BENCH_PERF_SETTINGS` can enable any subset for an ablation:
 *
 *   BENCH_PERF_SETTINGS=all
 *   BENCH_PERF_SETTINGS=virtualization
 *   BENCH_PERF_SETTINGS=defer-highlight,feed-window
 */

export const PERFORMANCE_SETTINGS: Record<string, string> = {
  'display.useNativeScrollbars': 'true',
  'display.useNativeScrollbarsCodeBlocks': 'true',
  'display.collapseLargeToolCalls': 'true',
  'display.deferCodeHighlightWhileStreaming': 'true',
  'display.feedVirtualization': 'true',
}

/** Short alias → setting key, in the order the UI lists them. */
export const PERFORMANCE_SETTING_ALIASES: Record<string, string> = {
  'native-scrollbars': 'display.useNativeScrollbars',
  'native-scrollbars-code': 'display.useNativeScrollbarsCodeBlocks',
  'collapse-large-tools': 'display.collapseLargeToolCalls',
  'defer-highlight': 'display.deferCodeHighlightWhileStreaming',
  virtualization: 'display.feedVirtualization',
}

/** `BENCH_PERF_SETTINGS=no-virtualization` writes the setting off instead. */
export const DISABLED_PREFIX = 'no-'

/**
 * Resolve `BENCH_PERF_SETTINGS` into the settings to apply.
 * Accepts `1`/`all` for every setting, or a comma-separated list of aliases.
 * Prefix an alias with `no-` to write it off, so an ablation works in both
 * directions (several of these are on by default now).
 * An unknown alias throws — measuring nothing while reporting a preset would be
 * worse than failing.
 */
export function resolvePerformanceSettings(value: string | undefined): Record<string, string> {
  if (value === undefined) return {}
  const trimmed = value.trim()
  if (trimmed === '') return {}
  if (trimmed === '1' || trimmed === 'all') return { ...PERFORMANCE_SETTINGS }

  const resolved: Record<string, string> = {}
  for (const rawAlias of trimmed.split(',')) {
    const alias = rawAlias.trim()
    if (alias === '') continue
    const disabled = alias.startsWith(DISABLED_PREFIX)
    const name = disabled ? alias.slice(DISABLED_PREFIX.length) : alias
    const key = PERFORMANCE_SETTING_ALIASES[name]
    const enabled = key === undefined ? undefined : PERFORMANCE_SETTINGS[key]
    if (!key || enabled === undefined) {
      throw new Error(
        `Unknown BENCH_PERF_SETTINGS entry "${alias}". Valid entries: ${Object.keys(PERFORMANCE_SETTING_ALIASES).join(', ')}, all (prefix any with "no-").`,
      )
    }
    resolved[key] = disabled ? 'false' : enabled
  }
  return resolved
}
