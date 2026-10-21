/**
 * Isolated OpenFox instance for the instance-collision e2e test.
 *
 * The parent sets HOME, XDG_*, OPENFOX_DB_PATH and OPENFOX_GLOBAL_CONFIG_PATH
 * to a temporary directory before forking, so they are in place before any
 * module opens SQLite. The child refuses to start if any of them points outside
 * tmpdir().
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative } from 'node:path'

function isTemporary(path: string | undefined, isFile: boolean): boolean {
  if (!path || !isAbsolute(path)) return false
  try {
    const fromRoot = relative(realpathSync(tmpdir()), realpathSync(isFile ? dirname(path) : path))
    return !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
  } catch {
    return false
  }
}

const guarded: Array<[string, boolean]> = [
  ['HOME', false],
  ['OPENFOX_DB_PATH', true],
  ['OPENFOX_GLOBAL_CONFIG_PATH', true],
]
for (const [name, isFile] of guarded) {
  if (!isTemporary(process.env[name], isFile)) {
    process.stderr.write(`[instance-collision-child] refusing to start: ${name} must point under ${tmpdir()}\n`)
    process.exit(2)
  }
}

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
try {
  handle = await createServerHandle(config)
  const { port } = await handle.start(Number(process.env['OPENFOX_PORT'] ?? 0))
  process.send?.({ port, pid: process.pid })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.send?.({ error: message, pid: process.pid })
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
