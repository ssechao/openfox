import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from './index.js'
import { createProject } from './projects.js'
import { createSession } from './sessions.js'
import {
  enqueueOutboxItem,
  findOutboxItemByDedupKey,
  listPendingOutboxItems,
  markOutboxItemSent,
  markOutboxItemAttemptFailed,
} from './shared-memory-outbox.js'

describe('shared_memory_outbox', () => {
  let sessionId: string
  let projectId: string

  beforeEach(() => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    const project = createProject('Test', '/tmp/test-project')
    projectId = project.id
    const session = createSession(projectId, '/tmp/test-project')
    sessionId = session.id
  })

  afterEach(() => {
    closeDatabase()
  })

  it('enqueues an item as pending and finds it by dedup key', () => {
    const item = enqueueOutboxItem({
      sessionId,
      projectId,
      collection: 'ops',
      payload: { type: 'fact', subject: 's', facts: [{ key: 'k', value: 'v' }] },
      tags: ['a'],
      identifiers: ['host-x'],
      dedupKey: 'dedup-1',
    })
    expect(item.status).toBe('pending')
    expect(findOutboxItemByDedupKey(sessionId, 'dedup-1')?.id).toBe(item.id)
  })

  it('lists only pending items for the given session, oldest first', () => {
    const a = enqueueOutboxItem({
      sessionId,
      projectId,
      collection: 'ops',
      payload: { type: 'fact', subject: 'a', facts: [{ key: 'k', value: 'v' }] },
      tags: [],
      identifiers: [],
      dedupKey: 'dedup-a',
    })
    const b = enqueueOutboxItem({
      sessionId,
      projectId,
      collection: 'ops',
      payload: { type: 'fact', subject: 'b', facts: [{ key: 'k', value: 'v' }] },
      tags: [],
      identifiers: [],
      dedupKey: 'dedup-b',
    })
    markOutboxItemSent(a.id)
    const pending = listPendingOutboxItems(sessionId)
    expect(pending.map((p) => p.id)).toEqual([b.id])
  })

  it('keeps a failed attempt pending for idempotent retry until maxAttempts is reached', () => {
    const item = enqueueOutboxItem({
      sessionId,
      projectId,
      collection: 'ops',
      payload: { type: 'fact', subject: 's', facts: [{ key: 'k', value: 'v' }] },
      tags: [],
      identifiers: [],
      dedupKey: 'dedup-retry',
    })
    markOutboxItemAttemptFailed(item.id, 'transient error', 3)
    let stored = findOutboxItemByDedupKey(sessionId, 'dedup-retry')
    expect(stored?.status).toBe('pending')
    expect(stored?.attempts).toBe(1)

    markOutboxItemAttemptFailed(item.id, 'transient error', 3)
    markOutboxItemAttemptFailed(item.id, 'transient error', 3)
    stored = findOutboxItemByDedupKey(sessionId, 'dedup-retry')
    expect(stored?.status).toBe('failed')
    expect(stored?.attempts).toBe(3)
    expect(stored?.lastError).toBe('transient error')
  })

  it('marks an item sent and removes it from the pending list', () => {
    const item = enqueueOutboxItem({
      sessionId,
      projectId,
      collection: 'ops',
      payload: { type: 'fact', subject: 's', facts: [{ key: 'k', value: 'v' }] },
      tags: [],
      identifiers: [],
      dedupKey: 'dedup-sent',
    })
    markOutboxItemSent(item.id)
    expect(listPendingOutboxItems(sessionId)).toEqual([])
    expect(findOutboxItemByDedupKey(sessionId, 'dedup-sent')?.status).toBe('sent')
  })
})
