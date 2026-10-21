/**
 * Isolated OpenFox instance for the instance-collision e2e test.
 */
import { InstanceLockError, instanceLockRefusalTx } from '../../src/server/db/instance-lock.js'
import { bootIsolatedChild } from './isolated-child-boot.js'

bootIsolatedChild('instance-collision-child')

const { createServerHandle } = await import('../../src/server/index.js')
const { loadConfig } = await import('../../src/server/config.js')
const { loadGlobalConfig, getActiveProvider, getDefaultModel } = await import('../../src/cli/config.js')

const mode: 'development' | 'test' = process.env['OPENFOX_MODE'] === 'development' ? 'development' : 'test'
const globalConfig = await loadGlobalConfig(mode, process.env['OPENFOX_GLOBAL_CONFIG_PATH'])
const activeProvider = getActiveProvider(globalConfig)
const defaultModel = getDefaultModel(globalConfig)

const envConfig = loadConfig()
const config = {
  ...envConfig,
  mode,
  globalConfigPath: process.env['OPENFOX_GLOBAL_CONFIG_PATH']!,
  providers: globalConfig.providers,
  activeProviderId: globalConfig.activeProviderId,
  defaultModelSelection: globalConfig.defaultModelSelection,
  llm: {
    ...envConfig.llm,
    baseUrl: activeProvider?.url ?? envConfig.llm.baseUrl,
    model: defaultModel ?? envConfig.llm.model,
    backend: activeProvider?.backend ?? envConfig.llm.backend,
  },
}

let handle: Awaited<ReturnType<typeof createServerHandle>> | null = null
const lockStarted = Date.now()
try {
  handle = await createServerHandle(config)
  const { port } = await handle.start(Number(process.env['OPENFOX_PORT'] ?? 0))
  process.send?.({ port, pid: process.pid })
} catch (error) {
  const refuseMs = Date.now() - lockStarted
  if (error instanceof InstanceLockError) {
    const message = instanceLockRefusalTx(error).en
    process.stderr.write(`${message}\n`)
    process.send?.({ error: message, pid: process.pid, refuseMs })
  } else {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.send?.({ error: message, pid: process.pid, refuseMs })
  }
  process.exit(1)
}

process.on('message', (message) => {
  if (message === 'close') {
    void handle?.close().then(() => process.exit(0))
    return
  }
  if (message && typeof message === 'object' && (message as { type?: string }).type === 'set-running') {
    const sessionId = (message as { sessionId?: string }).sessionId
    if (sessionId && handle) {
      handle.ctx.sessionManager.setRunning(sessionId, true)
      process.send?.({ running: true, sessionId })
    }
  }
})
