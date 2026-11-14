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
  request: ManualCompactionRequest,
  dependencies: ManualCompactionDependencies,
): Promise<ManualCompactionResult> {
  const session = dependencies.getSession(request.sessionId)
  if (!session) return { status: 'session_not_found' }
  if (session.interruptedAt) return { status: 'session_interrupted' }
  if (session.isRunning) {
    if (request.callerSessionId !== request.sessionId) return { status: 'session_busy' }
    if (!dependencies.schedule(request.sessionId)) return { status: 'session_busy' }
    return { status: 'compaction_scheduled' }
  }
  await dependencies.compactNow(request.sessionId)
  return { status: 'compacted' }
}
