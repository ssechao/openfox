export type ManualCompactionResult =
  | { status: 'compacted' }
  | { status: 'compaction_scheduled' }
  | { status: 'session_busy' }
  | { status: 'session_interrupted' }
  | { status: 'session_not_found' }

export interface ManualCompactionRequest {
  sessionId: string
  callerSessionId?: string
  projectId?: string
}

export interface ManualCompactionDependencies {
  getSession(sessionId: string): { isRunning: boolean; interruptedAt?: string | null } | undefined
  compactNow(sessionId: string): Promise<void>
  schedule(sessionId: string): boolean
}

export async function requestManualCompaction(
  _request: ManualCompactionRequest,
  _dependencies: ManualCompactionDependencies,
): Promise<ManualCompactionResult> {
  return { status: 'session_not_found' }
}
