import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import tsupConfig from '../../../tsup.config.js'
import { resolveSessionProcessEntry, SESSION_PROCESS_ENTRIES } from './process-entry.js'

const outputDirectory = mkdtempSync(join(tmpdir(), 'openfox-build-entries-'))

describe('production process entries', () => {
  beforeAll(async () => {
    await build({
      ...tsupConfig,
      outDir: outputDirectory,
      dts: false,
      sourcemap: false,
      silent: true,
    })
  }, 60_000)

  afterAll(() => {
    rmSync(outputDirectory, { recursive: true, force: true })
  })

  it.each(Object.keys(SESSION_PROCESS_ENTRIES) as Array<keyof typeof SESSION_PROCESS_ENTRIES>)(
    'emits and resolves the %s entry without a TypeScript runtime',
    (kind) => {
      const importerUrl = pathToFileURL(join(outputDirectory, 'runtime-chunk.js')).href
      const entry = resolveSessionProcessEntry(kind, importerUrl)

      expect(entry.path).toBe(join(outputDirectory, SESSION_PROCESS_ENTRIES[kind].output))
      expect(entry.execArgv).toEqual([])
      expect(existsSync(entry.path)).toBe(true)
    },
  )

  it('reports the selected production entry when it is absent without trying a fallback', () => {
    const missingRoot = join(outputDirectory, 'missing')
    const importerUrl = pathToFileURL(join(missingRoot, 'runtime-chunk.js')).href
    const expectedPath = join(missingRoot, SESSION_PROCESS_ENTRIES.worker.output)

    expect(() => resolveSessionProcessEntry('worker', importerUrl)).toThrow(
      `Session worker entry not found at ${expectedPath} (production runtime)`,
    )
  })
})
