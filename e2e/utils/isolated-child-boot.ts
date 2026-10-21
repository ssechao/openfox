/**
 * Shared boot guards for isolated OpenFox child processes.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative } from 'node:path'
import { installParentExitGuard } from './parent-exit-guard.js'

function isTemporary(path: string | undefined, isFile: boolean): boolean {
  if (!path || !isAbsolute(path)) return false
  try {
    const fromRoot = relative(realpathSync(tmpdir()), realpathSync(isFile ? dirname(path) : path))
    return !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
  } catch {
    return false
  }
}

export function bootIsolatedChild(label: string): void {
  const guarded: Array<[string, boolean]> = [
    ['HOME', false],
    ['OPENFOX_DB_PATH', true],
    ['OPENFOX_GLOBAL_CONFIG_PATH', true],
  ]
  for (const [name, isFile] of guarded) {
    if (!isTemporary(process.env[name], isFile)) {
      process.stderr.write(`[${label}] refusing to start: ${name} must point under ${tmpdir()}\n`)
      process.exit(2)
    }
  }
  installParentExitGuard()
}
