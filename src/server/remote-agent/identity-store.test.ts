import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultIdentityPath, loadOrCreateIdentity, sanitizeAgentName } from './identity-store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ra-identity-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('identity path scoping', () => {
  it('scopes the default path per agent name (never per user)', () => {
    const a = defaultIdentityPath('build-box', home)
    const b = defaultIdentityPath('deploy-box', home)
    expect(a).not.toBe(b)
    expect(a).toBe(join(home, '.config', 'openfox', 'remote-agent', 'build-box.key'))
  })

  it('sanitizes unsafe names so two distinct names never collapse', () => {
    expect(sanitizeAgentName('build box')).toBe('build_box')
    expect(sanitizeAgentName('../../etc/passwd')).toBe('etc_passwd')
    expect(sanitizeAgentName('')).toBe('default')
    expect(sanitizeAgentName('  ')).toBe('default')
  })
})

describe('loadOrCreateIdentity', () => {
  it('generates, persists (0600) and reloads the SAME identity', () => {
    const first = loadOrCreateIdentity({ name: 'build-box', home })
    expect(first.created).toBe(true)
    expect(first.path).toBe(defaultIdentityPath('build-box', home))
    // Directory 0700, file 0600.
    expect(statSync(first.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.config', 'openfox', 'remote-agent')).mode & 0o777).toBe(0o700)

    const second = loadOrCreateIdentity({ name: 'build-box', home })
    expect(second.created).toBe(false)
    // THE point: the peer id (derived from the public key) is stable across
    // restarts, because the key is reloaded instead of regenerated.
    expect(second.identity.publicKeyB64).toBe(first.identity.publicKeyB64)
  })

  it('gives two agents on the same host two different identities', () => {
    const a = loadOrCreateIdentity({ name: 'agent-a', home })
    const b = loadOrCreateIdentity({ name: 'agent-b', home })
    expect(a.identity.publicKeyB64).not.toBe(b.identity.publicKeyB64)
  })

  it('fails closed when the key file is readable by group/others', () => {
    const { path } = loadOrCreateIdentity({ name: 'build-box', home })
    chmodSync(path, 0o644)
    expect(() => loadOrCreateIdentity({ name: 'build-box', home })).toThrow(/readable by group\/others/)
    // The unsafe key is NOT silently used: the error message tells how to fix it.
    expect(() => loadOrCreateIdentity({ name: 'build-box', home })).toThrow(/chmod 600/)
  })

  it('fails closed when the identity directory is group/world accessible', () => {
    const { path } = loadOrCreateIdentity({ name: 'build-box', home })
    chmodSync(join(home, '.config', 'openfox', 'remote-agent'), 0o755)
    expect(() => loadOrCreateIdentity({ name: 'build-box', home })).toThrow(/accessible to group\/others/)
    expect(existsSync(path)).toBe(true)
  })

  it('rotates the identity on demand (new key, old one replaced)', () => {
    const before = loadOrCreateIdentity({ name: 'build-box', home })
    const after = loadOrCreateIdentity({ name: 'build-box', home, rotate: true })
    expect(after.rotated).toBe(true)
    expect(after.identity.publicKeyB64).not.toBe(before.identity.publicKeyB64)
    // The rotated key is persisted (and private) too.
    expect(statSync(after.path).mode & 0o777).toBe(0o600)
    const reloaded = loadOrCreateIdentity({ name: 'build-box', home })
    expect(reloaded.identity.publicKeyB64).toBe(after.identity.publicKeyB64)
  })

  it('honours an explicit key path over the per-agent default', () => {
    const explicit = join(home, 'custom', 'my.key')
    const loaded = loadOrCreateIdentity({ name: 'build-box', home, explicitPath: explicit })
    expect(loaded.path).toBe(explicit)
    expect(existsSync(explicit)).toBe(true)
    expect(existsSync(defaultIdentityPath('build-box', home))).toBe(false)
  })

  it('rejects a corrupt key file instead of starting with a broken identity', () => {
    const { path } = loadOrCreateIdentity({ name: 'build-box', home })
    writeFileSync(path, Buffer.from('not a pkcs8 key'))
    chmodSync(path, 0o600)
    expect(() => loadOrCreateIdentity({ name: 'build-box', home })).toThrow()
    expect(readFileSync(path).length).toBeGreaterThan(0)
  })

  it('fails closed when the default directory already exists with a loose mode', () => {
    mkdirSync(join(home, '.config', 'openfox', 'remote-agent'), { recursive: true, mode: 0o755 })
    chmodSync(join(home, '.config', 'openfox', 'remote-agent'), 0o755)
    // A loose directory is refused (fail closed), never silently tightened.
    expect(() => loadOrCreateIdentity({ name: 'build-box', home })).toThrow(/accessible to group\/others/)
  })
})
