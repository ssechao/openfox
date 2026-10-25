import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { SESSION_PROCESS_BUILD_ENTRIES } from './src/server/session/process-entry.js'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
  },
  entry: {
    'cli/index': 'src/cli/index.ts',
    'cli/dev': 'src/cli/dev.ts',
    'server/index': 'src/server/index.ts',
    ...SESSION_PROCESS_BUILD_ENTRIES,
    'shared/index': 'src/shared/index.ts',
    'provider/index': 'src/provider/index.ts',
    'plugin/index': 'src/plugin/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3', 'vscode-jsonrpc', 'vscode-languageserver-protocol', 'ws', 'node-pty', 'undici'],
  noExternal: ['@clack/prompts', '@clack/core', 'sisteransi'],
})
