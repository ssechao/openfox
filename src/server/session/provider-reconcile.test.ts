/**
 * Session Provider Reconciliation Tests
 *
 * A deleted provider used to leave its sessions pinned to an id that no longer resolves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { loadConfig } from '../config.js'
import { createProject } from '../db/projects.js'
import { initEventStore } from '../events/index.js'
import { createSession, getSession } from '../db/sessions.js'
import { clearSessionsForDeletedProvider, reconcileSessionProviders } from './provider-reconcile.js'
import { setLogLevel, logger } from '../utils/logger.js'

describe('session provider reconciliation', () => {
  let projectId: string
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    initEventStore(getDatabase())

    projectId = createProject('Test', '/tmp/test').id
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy?.mockRestore()
    errorSpy?.mockRestore()
    setLogLevel('info')
    closeDatabase()
  })

  it('clears the sessions that referenced a deleted provider', () => {
    const orphaned = createSession(projectId, '/tmp/test', 'orphaned', 'deleted-provider', 'some-model')
    const alsoOrphaned = createSession(projectId, '/tmp/test', 'also orphaned', 'deleted-provider', 'other-model')
    const untouched = createSession(projectId, '/tmp/test', 'untouched', 'kept-provider', 'kept-model')

    expect(clearSessionsForDeletedProvider('deleted-provider')).toBe(2)

    expect(getSession(orphaned.id)?.providerId).toBeNull()
    expect(getSession(orphaned.id)?.providerModel).toBeNull()
    expect(getSession(alsoOrphaned.id)?.providerId).toBeNull()
    expect(getSession(untouched.id)?.providerId).toBe('kept-provider')
    expect(getSession(untouched.id)?.providerModel).toBe('kept-model')
  })

  it('clears a provider that is not configured and leaves a configured one alone', () => {
    const dead = createSession(projectId, '/tmp/test', 'dead', 'gone-provider', 'gone-model')
    const live = createSession(projectId, '/tmp/test', 'live', 'live-provider', 'live-model')
    const unpinned = createSession(projectId, '/tmp/test', 'unpinned')

    expect(reconcileSessionProviders(['live-provider'])).toBe(1)

    expect(getSession(dead.id)?.providerId).toBeNull()
    expect(getSession(dead.id)?.providerModel).toBeNull()
    expect(getSession(live.id)?.providerId).toBe('live-provider')
    expect(getSession(live.id)?.providerModel).toBe('live-model')
    expect(getSession(unpinned.id)?.providerId).toBeNull()
  })

  it('repairs nothing when every pinned provider is configured', () => {
    const pinned = createSession(projectId, '/tmp/test', 'pinned', 'live-provider', 'live-model')

    expect(reconcileSessionProviders(['live-provider', 'another-provider'])).toBe(0)

    expect(getSession(pinned.id)?.providerId).toBe('live-provider')
  })

  it('does not clear providers when no providers are configured and sessions have pins', () => {
    const pinned = createSession(projectId, '/tmp/test', 'pinned', 'live-provider', 'live-model')

    expect(reconcileSessionProviders([])).toBe(0)

    expect(getSession(pinned.id)?.providerId).toBe('live-provider')
    expect(getSession(pinned.id)?.providerModel).toBe('live-model')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Provider reconciliation skipped'),
      expect.objectContaining({
        sessions: 1,
        pinnedProviderIds: ['live-provider'],
        configuredProviderIds: [],
        databasePath: ':memory:',
      }),
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not clear providers when the only configured provider is unknown to sessions', () => {
    const pinned = createSession(projectId, '/tmp/test', 'pinned', 'prod-provider', 'prod-model')

    expect(reconcileSessionProviders(['dev-unknown-provider'])).toBe(0)

    expect(getSession(pinned.id)?.providerId).toBe('prod-provider')
    expect(getSession(pinned.id)?.providerModel).toBe('prod-model')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Provider reconciliation skipped'),
      expect.objectContaining({
        sessions: 1,
        pinnedProviderIds: ['prod-provider'],
        configuredProviderIds: ['dev-unknown-provider'],
        databasePath: ':memory:',
      }),
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not alert when no sessions are pinned', () => {
    createSession(projectId, '/tmp/test', 'unpinned')

    expect(reconcileSessionProviders([])).toBe(0)
    expect(reconcileSessionProviders(['some-provider'])).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still clears an isolated orphan when other sessions reference unknown providers', () => {
    const isolated = createSession(projectId, '/tmp/test', 'isolated', 'orphan-provider', 'orphan-model')
    const mismatched = createSession(projectId, '/tmp/test', 'mismatched', 'unknown-provider', 'unknown-model')

    // Configuration recognizes only one provider, and it is not the mismatched one.
    expect(reconcileSessionProviders(['orphan-provider'])).toBe(1)

    expect(getSession(isolated.id)?.providerId).toBe('orphan-provider')
    expect(getSession(mismatched.id)?.providerId).toBeNull()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('prints the skip on stderr at logging.level error', () => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    setLogLevel('error')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pinned = createSession(projectId, '/tmp/test', 'pinned', 'prod-provider', 'prod-model')

    expect(reconcileSessionProviders(['dev-unknown-provider'], '/tmp/prod/sessions.db')).toBe(0)
    expect(getSession(pinned.id)?.providerId).toBe('prod-provider')
    const line = consoleError.mock.calls.map((call) => String(call[0])).join('\n')
    expect(line).toContain('Provider reconciliation skipped')
    expect(line).toContain('prod-provider')
    expect(line).toContain('dev-unknown-provider')
    expect(line).toContain('/tmp/prod/sessions.db')
    expect(consoleWarn).not.toHaveBeenCalled()
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
