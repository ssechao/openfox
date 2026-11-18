import { logger as defaultLogger } from '../utils/logger.js'

export interface GatewayShutdownLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export interface GatewayShutdownWorkerManager {
  shutdown(): Promise<void>
}

export interface GatewayShutdownMcpManager {
  beginShutdown(): void
  disconnectAll(): Promise<number>
}

export interface GatewayShutdownSupervisor {
  shutdown(): Promise<void>
}

export interface GatewayShutdownDeps {
  workerManager: GatewayShutdownWorkerManager
  mcpManager: GatewayShutdownMcpManager
  processSupervisor?: GatewayShutdownSupervisor | null | undefined
  ancillaryCleanup: Promise<unknown>
  beforeSupervisorShutdown?: (() => void) | undefined
  logger?: GatewayShutdownLogger
}

export interface GatewayShutdownResult {
  clean: boolean
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
  const logger = deps.logger ?? defaultLogger
  const result: GatewayShutdownResult = { clean: true }

  deps.mcpManager.beginShutdown()

  try {
    await deps.workerManager.shutdown()
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
    const count = await deps.mcpManager.disconnectAll()
    logger.info('MCP servers disconnected', { count })
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

  try {
    await deps.ancillaryCleanup
  } catch (error) {
    result.clean = false
    result.ancillaryError = describe(error)
    logger.warn('Gateway ancillary shutdown step failed', { error: result.ancillaryError })
  }

  return result
}
