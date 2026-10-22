import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import { createDiagnosticsCollector } from './collector.js'
import type { SessionSnapshot } from '../events/types.js'

function snapshot(content: string): SessionSnapshot {
  return {
    mode: 'builder',
    phase: 'build',
    isRunning: false,
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

describe('snapshot cache health', () => {
  const databases: Database.Database[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('exposes live hits, misses, bytes, evictions and limit on diagnostics', () => {
    const db = new Database(':memory:')
    databases.push(db)
    const store = new EventStore(db, { snapshotCacheMaxBytes: 800, snapshotCacheMaxEntries: 2, hotPath: true })
    const collector = createDiagnosticsCollector({
      enableLoopSampler: false,
      snapshotCacheStats: () => store.getSnapshotCacheStats(),
    })
    store.setHealthCollector(collector)
    collector.start()
    const pad = 'n'.repeat(250)
    store.append('a', { type: 'turn.snapshot', data: snapshot(pad) })
    store.append('b', { type: 'turn.snapshot', data: snapshot(pad) })
    store.append('c', { type: 'turn.snapshot', data: snapshot(pad) })
    store.getLatestSnapshot('c')
    store.getLatestSnapshot('c')
    store.getLatestSnapshot('a')
    const series = collector.getData().series
    expect(series.snapshotCacheLimitBytes).toMatchObject({ unit: 'bytes', value: 800 })
    expect(series.snapshotCacheBytes.unit).toBe('bytes')
    expect(series.snapshotCacheBytes.value).toBeLessThanOrEqual(800)
    expect(series.snapshotCacheHits.value).toBeGreaterThanOrEqual(1)
    expect(series.snapshotCacheMisses.value).toBeGreaterThanOrEqual(1)
    expect(series.snapshotCacheEvictions.value).toBeGreaterThanOrEqual(1)
    expect(series.snapshotCacheHits.samples).toBeGreaterThanOrEqual(1)
    collector.stop()
  })
})
