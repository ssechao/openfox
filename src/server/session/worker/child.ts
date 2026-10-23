/**
 * Session worker entry point (étape 6a). Forked by SessionWorkerManager.
 *
 * The worker attaches to the gateway's database WITHOUT the instance lock,
 * migrations, or any global maintenance (gateway/worker contract in
 * db/instance-lock.ts), writes its events through the fenced EventStore
 * (workerId + generation), and forwards WebSocket messages over IPC. It dies
 * with its parent (parent-exit guard) and records its exclusive shell
 * children in a sidecar file so the gateway can reap them after a crash.
 *
 * 6a scope: plain chat turns with the built-in tools. MCP tools are not
 * registered in the worker (the gateway owns the shared MCP connections) and
 * interactive prompts (ask_user / path confirmations) are not wired across
 * IPC — sessions that need them are not supported in the worker and must run
 * in-process.
 */

import { installParentExitGuard } from '../../utils/parent-exit-guard.js'

installParentExitGuard()

import { setRuntimeConfig } from '../../runtime-config.js'
import { attachWorkerDatabase } from '../../db/index.js'
import { attachWorkerEventStore } from '../../events/store.js'
import { createProviderManager } from '../../provider-manager.js'
import { SessionManager } from '../manager.js'
import { createMockLLMClient } from '../../llm/mock.js'
import type { WorkerToken } from './token.js'
import type { GatewayToWorkerMessage, WorkerToGatewayMessage } from './protocol.js'
import type { LLMClientWithModel } from '../../llm/client.js'
import type { StatsIdentity } from '../../../shared/types.js'
import { logger } from '../../utils/logger.js'
import { shutdownLspManager } from '../../lsp/index.js'
import { createWorkerDiagnosticsCollector } from '../../diagnostics/worker-collector.js'

const workerEnv = (() => {
  const workerId = process.env['OPENFOX_WORKER_ID']
  const generation = Number(process.env['OPENFOX_WORKER_GENERATION'])
  const dbPath = process.env['OPENFOX_WORKER_DB_PATH']
  const childrenPath = process.env['OPENFOX_WORKER_CHILDREN']
  if (!workerId || !Number.isFinite(generation) || generation <= 0 || !dbPath || !childrenPath) {
    process.stderr.write('worker: missing OPENFOX_WORKER_* environment\n')
    process.exit(2)
  }
  return { workerId, generation, dbPath, childrenPath }
})()

const token: WorkerToken = { workerId: workerEnv.workerId, generation: workerEnv.generation }
const healthCollector = createWorkerDiagnosticsCollector()

const send = (msg: WorkerToGatewayMessage, onFlush?: () => void): void => {
  try {
    if (process.send) process.send(msg, undefined, undefined, onFlush)
    else onFlush?.()
  } catch {
    onFlush?.()
  }
}

const controller = new AbortController()

process.on('message', (raw) => {
  const msg = raw as GatewayToWorkerMessage
  if (!msg || typeof msg !== 'object') return
  if (msg.workerId !== token.workerId || msg.generation !== token.generation) return
  if (msg.type === 'start') void runTurn(msg.sessionId, msg.config)
  if (msg.type === 'abort') controller.abort()
})

send({ ...token, type: 'ready', pid: process.pid })

async function runTurn(sessionId: string, config: import('../../../shared/types.js').Config): Promise<void> {
  healthCollector.start((data) => send({ ...token, type: 'health', data }))
  const finish = (ok: boolean, error?: string): void => {
    healthCollector.stop()
    send({ ...token, type: 'done', ok, ...(error ? { error } : {}) }, () => process.exit(ok ? 0 : 1))
    // Safety net if the IPC channel is already gone.
    setTimeout(() => process.exit(ok ? 0 : 1), 2000).unref()
  }

  let ok = false
  let failure: string | undefined
  try {
    setRuntimeConfig(config)
    const db = attachWorkerDatabase(workerEnv.dbPath)
    attachWorkerEventStore(db, token)

    const providerManager = createProviderManager(config)
    const sessionManager = new SessionManager(providerManager)

    const useMock = process.env['OPENFOX_MOCK_LLM'] === 'true'
    const effective = sessionManager.resolveEffectiveProviderModel(sessionId)

    const getSessionLLMClient = (): LLMClientWithModel => {
      if (useMock) return createMockLLMClient()
      const current = sessionManager.resolveEffectiveProviderModel(sessionId)
      if (current.providerId && current.model) {
        const resolvedModel = providerManager.resolveModel(current.providerId, current.model) ?? current.model
        const client = providerManager.createClient(current.providerId, resolvedModel, current.reasoningEffort)
        if (client) return client
      }
      return providerManager.getLLMClient()
    }

    const sessionClient = getSessionLLMClient()
    const sessionEffort = sessionClient.getReasoningEffort?.()
    const statsIdentity: StatsIdentity = {
      providerId: effective.providerId ?? `provider:${sessionClient.getModel()}`,
      providerName: 'Unknown Provider',
      backend: sessionClient.getBackend(),
      model: sessionClient.getModel(),
      ...(sessionEffort ? { reasoningEffort: sessionEffort } : {}),
    }

    const { runChatTurn } = await import('../../chat/orchestrator.js')
    await runChatTurn({
      sessionManager,
      sessionId,
      llmClient: sessionClient,
      getSessionLLMClient,
      statsIdentity,
      signal: controller.signal,
      onMessage: (msg) => send({ ...token, type: 'ws', msg }),
    })

    ok = true
    logger.info('Worker turn finished', { workerId: token.workerId, generation: token.generation, sessionId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'Aborted' || controller.signal.aborted) {
      ok = true
      logger.info('Worker turn aborted', { workerId: token.workerId, generation: token.generation, sessionId })
    } else {
      failure = message
      logger.error('Worker turn failed', {
        workerId: token.workerId,
        generation: token.generation,
        sessionId,
        error: message,
      })
    }
  }

  try {
    await shutdownLspManager(sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ok = false
    failure = `LSP shutdown failed: ${message}`
    logger.error('Worker LSP shutdown failed', { workerId: token.workerId, sessionId, error: message })
  }
  finish(ok, failure)
}
