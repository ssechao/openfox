import { logger as defaultLogger } from '../utils/logger.js'

export interface GatewayShutdownLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export interface GatewayShutdownWorkerSession {
  sessionId: string
  cleanupError?: string
}

export interface GatewayShutdownWorkerResult {
  sessions: GatewayShutdownWorkerSession[]
  stopped: number
  failed: number
}

export interface GatewayShutdownWorkerManager {
  shutdown(request: { interruptedAt: string; verdict: 'deferred' }): Promise<GatewayShutdownWorkerResult>
}

export interface GatewayShutdownMcpError {
  name: string
  error: string
}

export interface GatewayShutdownMcpResult {
  disconnected: number
  errors: GatewayShutdownMcpError[]
}

export interface GatewayShutdownMcpManager {
  beginShutdown(): void
  disconnectAll(): Promise<GatewayShutdownMcpResult>
}

export interface GatewayShutdownSupervisor {
  shutdown(): Promise<void>
}

export interface GatewayShutdownDeps {
  interruptedAt: string
  workerManager: GatewayShutdownWorkerManager
  mcpManager: GatewayShutdownMcpManager
  processSupervisor?: GatewayShutdownSupervisor | null | undefined
  ancillaryCleanup: Promise<unknown>
  beforeSupervisorShutdown?: (() => void) | undefined
  logger?: GatewayShutdownLogger
}

export interface GatewayShutdownResult {
  clean: boolean
  interruptedSessionIds: string[]
  workerError?: string
  mcpError?: string
  supervisorError?: string
  ancillaryError?: string
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : fallback
}

export async function runGatewayShutdown(deps: GatewayShutdownDeps): Promise<GatewayShutdownResult> {
  const ancillaryOutcome = deps.ancillaryCleanup.then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  )
  const logger = deps.logger ?? defaultLogger
  const result: GatewayShutdownResult = { clean: true, interruptedSessionIds: [] }

  deps.mcpManager.beginShutdown()

  try {
    const workerResult = await deps.workerManager.shutdown({
      interruptedAt: deps.interruptedAt,
      verdict: 'deferred',
    })
    result.interruptedSessionIds = workerResult.sessions.map((session) => session.sessionId)
    if (workerResult.failed > 0) {
      result.clean = false
      result.workerError = workerResult.sessions
        .filter((session) => session.cleanupError)
        .map((session) => `${session.sessionId}: ${session.cleanupError}`)
        .join('; ')
      logger.error('Session worker shutdown failed', {
        code: 'WORKER_SHUTDOWN_FAILED',
        error: result.workerError,
      })
    }
  } catch (error) {
    result.clean = false
    result.workerError = describe(error)
    logger.error('Session worker shutdown failed', {
      code: errorCode(error, 'WORKER_SHUTDOWN_FAILED'),
      error: result.workerError,
    })
  }

  try {
    deps.beforeSupervisorShutdown?.()
  } catch (error) {
    logger.warn('Gateway shutdown hook failed', { error: describe(error) })
  }

  try {
    const mcpResult = await deps.mcpManager.disconnectAll()
    logger.info('MCP servers disconnected', { count: mcpResult.disconnected })
    if (mcpResult.errors.length > 0) {
      result.clean = false
      result.mcpError = mcpResult.errors.map(({ name, error }) => `${name}: ${error}`).join('; ')
      logger.error('MCP servers failed to disconnect', {
        code: 'MCP_DISCONNECT_FAILED',
        error: result.mcpError,
      })
    }
  } catch (error) {
    result.clean = false
    result.mcpError = describe(error)
    logger.error('MCP servers failed to disconnect', {
      code: errorCode(error, 'MCP_DISCONNECT_FAILED'),
      error: result.mcpError,
    })
  }

  try {
    await deps.processSupervisor?.shutdown()
  } catch (error) {
    result.clean = false
    result.supervisorError = describe(error)
    logger.error('Session process supervisor shutdown failed', {
      code: errorCode(error, 'SUPERVISOR_SHUTDOWN_FAILED'),
      error: result.supervisorError,
    })
  }

  const ancillaryResult = await ancillaryOutcome
  if (ancillaryResult.status === 'rejected') {
    result.clean = false
    result.ancillaryError = describe(ancillaryResult.error)
    logger.warn('Gateway ancillary shutdown step failed', { error: result.ancillaryError })
  }

  return result
}
