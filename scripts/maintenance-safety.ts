export interface ProcessProbeResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export function assertDatabaseIsClosed(result: ProcessProbeResult): void {
  if (result.status === 1) return
  if (result.error) {
    throw new Error(`lsof probe failed: ${result.error.message}`)
  }
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Database is open by PID(s) ${result.stdout.trim()}`)
  }
  const detail = result.stderr.trim() || `unexpected exit status ${String(result.status)}`
  throw new Error(`lsof probe failed: ${detail}`)
}
