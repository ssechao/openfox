import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { EventStore } from './store.js'
import type { SessionSnapshot } from './types.js'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture(diagnostics = true) {
  const db = new Database(':memory:')
  databases.push(db)
  const store = new EventStore(db, { diagnostics, hotPath: false })
  const snapshot: SessionSnapshot = {
    mode: 'builder',
    phase: 'build',
    isRunning: true,
    messages: [{ id: 'u', role: 'user', content: 'PRIVATE_é', timestamp: 1 }],
    criteria: [],
    todos: [],
    readFiles: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId: 'w',
    snapshotSeq: 1,
    snapshotAt: 1,
  }
  store.append('s', { type: 'turn.snapshot', data: snapshot })
  return { store, snapshot }
}

test('counts full reads, real snapshot parses, cache hits and misses separately', () => {
  const { store, snapshot } = fixture()
  store.resetDiagnostics()
  store.getEvents('s')
  store.getEvents('s', 2)
  store.getLatestSnapshot('s')
  store.getLatestSnapshot('s')
  const stats = store.getDiagnostics()
  expect(stats).toMatchObject({
    fullReads: 1,
    snapshotParses: 2,
    snapshotCacheHits: 1,
    snapshotCacheMisses: 1,
    snapshotParsedBytes: 2 * Buffer.byteLength(JSON.stringify(snapshot)),
  })
  expect(JSON.stringify(stats)).not.toContain('PRIVATE')
  store.resetDiagnostics()
  expect(store.getDiagnostics()).toMatchObject({ fullReads: 0, snapshotParses: 0, snapshotParsedBytes: 0 })
})

test('records snapshot serialization and append durations without payloads', () => {
  const { store } = fixture()
  const stats = store.getDiagnostics()
  expect(stats?.timings.snapshotStringify.count).toBe(1)
  expect(stats?.timings.snapshotAppend.count).toBe(1)
  expect(stats?.timings.snapshotStringify.totalMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(stats)).not.toContain('PRIVATE')
})

test('disabled instrumentation neither allocates diagnostic state nor reports counters', () => {
  const { store } = fixture(false)
  store.getEvents('s')
  store.getLatestSnapshot('s')
  store.resetDiagnostics()
  expect(store.getDiagnostics()).toBeNull()
})
