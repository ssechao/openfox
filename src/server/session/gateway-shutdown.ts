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

export async function runGatewayShutdown(deps: GatewayShutdownDeps): Promise<GatewayShutdownResult> {
  const logger = deps.logger ?? defaultLogger
  try {
    await deps.workerManager.shutdown()
    deps.beforeSupervisorShutdown?.()
    await Promise.all([deps.ancillaryCleanup, deps.mcpManager.disconnectAll(), deps.processSupervisor?.shutdown()])
    return { clean: true }
  } catch (error) {
    logger.error('Gateway shutdown failed', { error: describe(error) })
    throw error
  }
}
