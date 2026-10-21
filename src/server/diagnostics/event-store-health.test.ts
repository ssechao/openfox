import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import { createDiagnosticsCollector } from './collector.js'
import type { DiagnosticsCollector } from './types.js'

const running = (isRunning: boolean) => ({ type: 'running.changed' as const, data: { isRunning } })

describe('EventStore health hooks', () => {
  let db: Database.Database
  let collector: DiagnosticsCollector

  beforeEach(() => {
    db = new Database(':memory:')
    collector = createDiagnosticsCollector({ enableLoopSampler: false })
  })

  afterEach(() => {
    db.close()
  })

  it.each([true, false])('counts running sessions from running.changed events (hot path %s)', (hotPath) => {
    const store = new EventStore(db, { hotPath })
    expect(store.countRunningSessions()).toBe(0)
    store.append('a', running(true))
    store.append('b', running(true))
    store.append('b', running(true))
    expect(store.countRunningSessions()).toBe(2)
    store.append('a', running(false))
    expect(store.countRunningSessions()).toBe(1)
    store.deleteSession('b')
    expect(store.countRunningSessions()).toBe(0)
  })

  it('keeps the running count when caches are dropped', () => {
    const store = new EventStore(db)
    store.append('a', running(true))
    store.tombstoneEvents('a', [1])
    expect(store.countRunningSessions()).toBe(1)
  })

  it('times EventStore reads and writes into the collector only when attached', () => {
    const store = new EventStore(db)
    store.append('a', running(true))
    store.getEvents('a')
    expect(collector.getData().series.eventStoreWriteP99.samples).toBe(0)

    store.setHealthCollector(collector)
    store.append('a', running(false))
    store.appendBatch('a', [running(true), running(false)])
    store.getEvents('a')
    store.getEvents('a', 2)
    const { eventStoreReadP99, eventStoreWriteP99 } = collector.getData().series
    expect(eventStoreWriteP99.samples).toBe(2)
    expect(eventStoreReadP99.samples).toBe(2)
    expect(eventStoreWriteP99.value).not.toBeNull()

    store.setHealthCollector(null)
    store.getEvents('a')
    expect(collector.getData().series.eventStoreReadP99.samples).toBe(2)
  })
})
