import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { getDatabasePath } from '../../cli/paths.js'
import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from '../db/index.js'
import { assertTestDatabasePath, isolateTestEnvironment } from './test-environment.js'

describe('test isolation from real OpenFox databases', () => {
  afterEach(() => {
    closeDatabase()
  })

  it('never lets a test inherit the database of the server it runs under', () => {
    expect(process.env['OPENFOX_DB_PATH']).toBe(':memory:')
    expect(loadConfig().database.path).toBe(':memory:')
  })

  it('strips inherited server variables and keeps the test knobs', () => {
    const env: NodeJS.ProcessEnv = {
      OPENFOX_DB_PATH: '/Users/me/Library/Application Support/openfox/sessions.db',
      OPENFOX_PORT: '450',
      OPENFOX_HOST: '0.0.0.0',
      OPENFOX_WORKDIR: '/Users/me',
      OPENFOX_DEV: 'true',
      OPENFOX_TEST_VERBOSE: 'true',
      OPENFOX_E2E_MAX_WORKERS: '4',
      OPENFOX_PUBLISH_E2E_LLM: '1',
      PATH: '/usr/bin',
    }

    isolateTestEnvironment(env)

    expect(env).toEqual({
      OPENFOX_DB_PATH: ':memory:',
      OPENFOX_TEST_VERBOSE: 'true',
      OPENFOX_E2E_MAX_WORKERS: '4',
      OPENFOX_PUBLISH_E2E_LLM: '1',
      PATH: '/usr/bin',
    })
  })

  it('refuses the production and development databases with an explicit error, before touching them', () => {
    for (const mode of ['production', 'development'] as const) {
      const path = getDatabasePath(mode)
      const existedBefore = existsSync(path)
      expect(() => initDatabase({ ...loadConfig(), database: { path } })).toThrow(
        `Refusing to open the database ${path} from a test`,
      )
      expect(existsSync(path)).toBe(existedBefore)
    }
  })

  it('refuses to open a database outside the temporary directory from a test', () => {
    const realLooking = join(homedir(), `.openfox-isolation-${randomUUID()}`, 'sessions.db')

    expect(() => initDatabase({ ...loadConfig(), database: { path: realLooking } })).toThrow(/Refusing to open/)
    expect(() => assertTestDatabasePath('./openfox.db')).toThrow(/Refusing to open/)
  })

  it('still opens in-memory and temporary databases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-isolation-'))
    try {
      expect(() => assertTestDatabasePath(':memory:')).not.toThrow()
      expect(() => assertTestDatabasePath('')).not.toThrow()
      expect(() => assertTestDatabasePath(join(directory, 'sessions.db'))).not.toThrow()
      expect(initDatabase({ ...loadConfig(), database: { path: join(directory, 'sessions.db') } }).name).toBe(
        join(directory, 'sessions.db'),
      )
    } finally {
      closeDatabase()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets the server open any database outside the test runner', () => {
    expect(() => assertTestDatabasePath('./openfox.db', {})).not.toThrow()
  })
})
