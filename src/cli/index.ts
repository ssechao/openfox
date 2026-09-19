#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { totalmem } from 'node:os'
import { DEFAULT_HEAP_MB, shouldIncreaseHeap } from './heap.js'
import { runCli } from './main.js'
import { logger } from '../server/utils/logger.js'

if (shouldIncreaseHeap({ argv: process.argv, execArgv: process.execArgv, env: process.env })) {
  const heapMB = Math.min(DEFAULT_HEAP_MB, Math.max(4_096, Math.floor((totalmem() / (1024 * 1024)) * 0.55)))
  const env: Record<string, string | undefined> = { ...process.env, OPENFOX_HEAP_INCREASED: '1' }
  const cleanNodeOptions = (env['NODE_OPTIONS'] ?? '').replace(/--max-old-space-size=\d+/g, '').trim()
  env['NODE_OPTIONS'] = cleanNodeOptions || undefined
  const scriptPath = process.argv[1] as string
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=' + heapMB, ...process.execArgv, scriptPath, ...process.argv.slice(2)],
    { stdio: 'inherit', env: env as Record<string, string>, windowsHide: true },
  )
  process.exit(result.status ?? 0)
}

const mode = (process.env['OPENFOX_MODE'] ?? 'production') as 'production' | 'development' | 'test'
runCli({ mode }).catch((error) => {
  logger.error('CLI fatal error', { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
