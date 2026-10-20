import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const KEPT_PREFIXES = ['OPENFOX_TEST_', 'OPENFOX_E2E_', 'OPENFOX_PUBLISH_']
const IN_MEMORY_PATHS = new Set([':memory:', ''])

export function isolateTestEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('OPENFOX_') && !KEPT_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key]
  }
  env['OPENFOX_DB_PATH'] = ':memory:'
}

function realDirectory(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isInside(path: string, root: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

export function assertTestDatabasePath(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env['VITEST'] || IN_MEMORY_PATHS.has(path)) return
  const directory = dirname(resolve(path))
  const candidates = [directory, realDirectory(directory)]
  const roots = [tmpdir(), '/tmp'].flatMap((root) => [resolve(root), realDirectory(root)])
  if (candidates.some((candidate) => roots.some((root) => isInside(candidate, root)))) return
  throw new Error(
    `Refusing to open the database ${path} from a test: tests may only use in-memory or temporary databases`,
  )
}
