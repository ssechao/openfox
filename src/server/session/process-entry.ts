import { existsSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION_PROCESS_ENTRIES = {
  supervisor: {
    source: 'src/server/session/process-supervisor/child.ts',
    output: 'server/session/process-supervisor/child.js',
    label: 'Session process supervisor',
  },
  worker: {
    source: 'src/server/session/worker/child.ts',
    output: 'server/session/worker/child.js',
    label: 'Session worker',
  },
} as const

export const SESSION_PROCESS_BUILD_ENTRIES = Object.fromEntries(
  Object.values(SESSION_PROCESS_ENTRIES).map((entry) => [entry.output.slice(0, -3), entry.source]),
)

export interface SessionProcessEntry {
  path: string
  execArgv: string[]
}

export function resolveSessionProcessEntry(
  kind: keyof typeof SESSION_PROCESS_ENTRIES,
  importerUrl: string,
): SessionProcessEntry {
  const entry = SESSION_PROCESS_ENTRIES[kind]
  const importerPath = fileURLToPath(importerUrl)
  const sourceRuntime = extname(importerPath) === '.ts'
  const root = sourceRuntime ? resolve(dirname(importerPath), '../../../..') : dirname(importerPath)
  const path = resolve(root, sourceRuntime ? entry.source : entry.output)
  if (!existsSync(path)) {
    throw new Error(`${entry.label} entry not found at ${path} (${sourceRuntime ? 'source' : 'production'} runtime)`)
  }
  return { path, execArgv: sourceRuntime ? ['--import', 'tsx/esm'] : [] }
}
