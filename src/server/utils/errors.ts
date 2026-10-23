export class OpenFoxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'OpenFoxError'
  }
}

export class SessionNotFoundError extends OpenFoxError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND', { sessionId })
    this.name = 'SessionNotFoundError'
  }
}

export class InvalidPhaseTransitionError extends OpenFoxError {
  constructor(from: string, to: string) {
    super(`Invalid phase transition: ${from} -> ${to}`, 'INVALID_PHASE_TRANSITION', { from, to })
    this.name = 'InvalidPhaseTransitionError'
  }
}

export class ToolExecutionError extends OpenFoxError {
  constructor(tool: string, message: string, details?: unknown) {
    super(`Tool '${tool}' failed: ${message}`, 'TOOL_EXECUTION_ERROR', { tool, ...(details as object) })
    this.name = 'ToolExecutionError'
  }
}

export class LLMError extends OpenFoxError {
  constructor(message: string, details?: unknown) {
    super(message, 'LLM_ERROR', details)
    this.name = 'LLMError'
  }
}

export class ValidationError extends OpenFoxError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', details)
    this.name = 'ValidationError'
  }
}

export class SessionQueueFullError extends OpenFoxError {
  constructor(sessionId: string, limit: number) {
    super(`Session message queue reached its limit of ${limit}`, 'SESSION_QUEUE_FULL', { sessionId, limit })
    this.name = 'SessionQueueFullError'
  }
}

export class SessionWorkerQueueFullError extends OpenFoxError {
  constructor(sessionId: string) {
    super('Session worker queue is full', 'SESSION_WORKER_QUEUE_FULL', { sessionId })
    this.name = 'SessionWorkerQueueFullError'
  }
}

export class WorkspaceInUseError extends OpenFoxError {
  constructor(
    message: string,
    public readonly conflictingSessionIds: string[],
  ) {
    super(message, 'WORKSPACE_IN_USE')
    this.name = 'WorkspaceInUseError'
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenFoxError) {
    return ['LLM_ERROR', 'TOOL_EXECUTION_ERROR'].includes(error.code)
  }
  return false
}
