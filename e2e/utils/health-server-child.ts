/**
 * Isolated OpenFox instance for the health dashboard demo. The parent sets
 * HOME, XDG_*, OPENFOX_DB_PATH and OPENFOX_GLOBAL_CONFIG_PATH to a temporary
 * directory before forking. OPENFOX_HEALTH_DEMO_MODE=development serves Vite.
 */
import { bootIsolatedChild } from './isolated-child-boot.js'

bootIsolatedChild('health-server-child')

const { createServerHandle } = await import('../../src/server/index.js')
const { loadConfig } = await import('../../src/server/config.js')

const config = loadConfig()
config.mode = process.env['OPENFOX_HEALTH_DEMO_MODE'] === 'development' ? 'development' : 'test'
config.globalConfigPath = process.env['OPENFOX_GLOBAL_CONFIG_PATH']!

const handle = await createServerHandle(config)
const { port } = await handle.start(Number(process.env['OPENFOX_PORT'] ?? 0))
process.send?.({ port })

process.on('message', (message) => {
  if (message === 'close') void handle.close().then(() => process.exit(0))
})
