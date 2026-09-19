export const MIN_HEAP_MB = 6_144
export const DEFAULT_HEAP_MB = 8_192

export function getCurrentHeapMB(execArgv: readonly string[], nodeOptions: string | undefined): number {
  const arg = execArgv.find((a) => a.startsWith('--max-old-space-size='))
  if (arg) return Number.parseInt(arg.split('=')[1]!, 10)
  const match = (nodeOptions ?? '').match(/--max-old-space-size=(\d+)/)
  return match ? Number.parseInt(match[1]!, 10) : 0
}

export function shouldIncreaseHeap(input: {
  argv: readonly string[]
  execArgv: readonly string[]
  env: Record<string, string | undefined>
}): boolean {
  if (input.env['OPENFOX_HEAP_INCREASED']) return false
  if (input.argv.slice(2).includes('remote-agent')) return false
  return getCurrentHeapMB(input.execArgv, input.env['NODE_OPTIONS']) < MIN_HEAP_MB
}
