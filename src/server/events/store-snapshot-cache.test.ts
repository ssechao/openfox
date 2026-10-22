import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventStore, SNAPSHOT_CACHE_DEFAULT_MAX_BYTES, SNAPSHOT_CACHE_DEFAULT_MAX_ENTRIES } from './store.js'
import type { SessionSnapshot } from './types.js'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.unstubAllEnvs()
})

function fixture(options: ConstructorParameters<typeof EventStore>[1] = {}) {
  const db = new Database(':memory:')
  databases.push(db)
  return { db, store: new EventStore(db, { hotPath: true, ...options }) }
}

function snapshot(content: string, isRunning = false): SessionSnapshot {
  return {
    mode: 'builder',
    phase: 'build',
    isRunning,
    criteria: [],
    metadataEntries: {},
    todos: [],
    readFiles: [],
    currentContextWindowId: 'w',
    snapshotAt: 1,
    snapshotSeq: 1,
    messages: [{ id: 'u', role: 'user', content, timestamp: 1, contextWindowId: 'w' }],
    contextState: {
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
  }
}

describe('EventStore snapshot cache sizing', () => {
  it('defaults to 128 MiB / 16 and prefers constructor options over env', () => {
    vi.stubEnv('OPENFOX_SNAPSHOT_CACHE_MAX_BYTES', '1000')
    vi.stubEnv('OPENFOX_SNAPSHOT_CACHE_MAX_ENTRIES', '3')
    const envStore = fixture().store
    expect(envStore.getSnapshotCacheStats()).toMatchObject({ limitBytes: 1000, entries: 0 })
    const opted = fixture({ snapshotCacheMaxBytes: 200, snapshotCacheMaxEntries: 2 }).store
    expect(opted.getSnapshotCacheStats().limitBytes).toBe(200)
  })

  it('falls back to defaults for zero, negative or non-numeric bounds', () => {
    vi.stubEnv('OPENFOX_SNAPSHOT_CACHE_MAX_BYTES', '0')
    vi.stubEnv('OPENFOX_SNAPSHOT_CACHE_MAX_ENTRIES', '-2')
    const fromEnv = fixture().store
    expect(fromEnv.getSnapshotCacheStats().limitBytes).toBe(SNAPSHOT_CACHE_DEFAULT_MAX_BYTES)
    const fromOption = fixture({ snapshotCacheMaxBytes: -1, snapshotCacheMaxEntries: Number.NaN }).store
    expect(fromOption.getSnapshotCacheStats().limitBytes).toBe(SNAPSHOT_CACHE_DEFAULT_MAX_BYTES)
    expect(SNAPSHOT_CACHE_DEFAULT_MAX_ENTRIES).toBe(16)
  })

  it('counts hits, misses, bytes and capacity evictions without OPENFOX_SNAPSHOT_DIAGNOSTICS', () => {
    const { store } = fixture({
      diagnostics: false,
      snapshotCacheMaxBytes: 900,
      snapshotCacheMaxEntries: 2,
    })
    const pad = 'n'.repeat(250)
    store.append('a', { type: 'turn.snapshot', data: snapshot(pad) })
    store.append('b', { type: 'turn.snapshot', data: snapshot(pad) })
    store.append('c', { type: 'turn.snapshot', data: snapshot(pad) })
    store.resetDiagnostics()
    store.getLatestSnapshot('c')
    store.getLatestSnapshot('c')
    store.getLatestSnapshot('a')
    const stats = store.getSnapshotCacheStats()
    expect(store.getDiagnostics()).toBeNull()
    expect(stats.hits).toBeGreaterThanOrEqual(1)
    expect(stats.misses).toBeGreaterThanOrEqual(1)
    expect(stats.evictions).toBeGreaterThanOrEqual(1)
    expect(stats.bytes).toBeLessThanOrEqual(900)
    expect(stats.limitBytes).toBe(900)
  })

  it('does not keep an inactive payload larger than the byte limit', () => {
    const { store } = fixture({ snapshotCacheMaxBytes: 200, snapshotCacheMaxEntries: 8 })
    store.append('heavy', { type: 'turn.snapshot', data: snapshot('H'.repeat(2000)) })
    store.resetDiagnostics()
    expect(store.getLatestSnapshot('heavy')).toBeDefined()
    expect(store.getLatestSnapshot('heavy')).toBeDefined()
    const stats = store.getSnapshotCacheStats()
    expect(stats.bytes).toBe(0)
    expect(stats.entries).toBe(0)
    expect(stats.hits).toBe(0)
    expect(stats.misses).toBe(2)
    expect(store.inspectSnapshotCacheEntry('heavy')).toBeUndefined()
  })

  it('keeps a running snapshot above the limit and evicts it on stop', () => {
    const { store } = fixture({ snapshotCacheMaxBytes: 200, snapshotCacheMaxEntries: 8 })
    store.append('hot', { type: 'running.changed', data: { isRunning: true } })
    store.append('hot', { type: 'turn.snapshot', data: snapshot('R'.repeat(2000), true) })
    const cached = store.getSnapshotCacheStats()
    expect(cached.bytes).toBeGreaterThan(200)
    expect(store.inspectSnapshotCacheEntry('hot')?.keys).toEqual(['bytes', 'stored'])
    store.resetDiagnostics()
    expect(store.getLatestSnapshot('hot')).toBeDefined()
    expect(store.getSnapshotCacheStats().hits).toBe(1)
    store.append('hot', { type: 'running.changed', data: { isRunning: false } })
    expect(store.getSnapshotCacheStats().bytes).toBe(0)
    expect(store.getSnapshotCacheStats().evictions).toBeGreaterThanOrEqual(1)
  })

  it('does not count write invalidation as a capacity eviction', () => {
    const { store } = fixture({ snapshotCacheMaxBytes: 50_000, snapshotCacheMaxEntries: 8 })
    store.append('s', { type: 'turn.snapshot', data: snapshot('one') })
    const afterInsert = store.getSnapshotCacheStats().evictions
    store.append('s', { type: 'turn.snapshot', data: snapshot('two') })
    expect(store.getSnapshotCacheStats().evictions).toBe(afterInsert)
    expect(store.getLatestSnapshot('s')?.data.messages[0]?.content).toBe('two')
  })

  it('stores the parsed snapshot without retaining a JSON payload string on the entry', () => {
    const { store } = fixture({ snapshotCacheMaxBytes: 50_000 })
    store.append('s', { type: 'turn.snapshot', data: snapshot('cached') })
    const inspect = store.inspectSnapshotCacheEntry('s')
    expect(inspect).toEqual({ keys: ['bytes', 'stored'], bytes: expect.any(Number) })
    expect(inspect!.bytes).toBeGreaterThan(0)
  })
})
