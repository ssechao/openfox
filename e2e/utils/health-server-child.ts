/**
 * Isolated OpenFox instance for the health dashboard demo. The parent sets
 * HOME, XDG_*, OPENFOX_DB_PATH and OPENFOX_GLOBAL_CONFIG_PATH to a temporary
 * directory before forking, so they are in place before any module opens
 * SQLite. The child refuses to start if any of them points outside tmpdir().
 * OPENFOX_HEALTH_DEMO_MODE=development serves the web UI through Vite.
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
    process.stderr.write(`[health-server-child] refusing to start: ${name} must point under ${tmpdir()}\n`)
    process.exit(2)
  }
}

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
