import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { EventStore } from './store.js'
import { buildSnapshotFromSessionState, foldContextState, foldSessionState } from './folding.js'
import { buildContextMessages } from '../chat/conversation-history.js'
import type { SessionSnapshot, StoredEvent } from './types.js'

const databases: Database.Database[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(path = ':memory:', hotPath = true) {
  const db = new Database(path)
  databases.push(db)
  const store = new EventStore(db, { diagnostics: true, hotPath })
  return { db, store }
}
function snapshot(window = 'w'): SessionSnapshot {
  return {
    mode: 'builder',
    phase: 'build',
    isRunning: true,
    criteria: [],
    metadataEntries: {},
    todos: [],
    readFiles: [],
    currentContextWindowId: window,
    snapshotAt: 1,
    snapshotSeq: 1,
    messages: [{ id: 'u', role: 'user', content: 'OLD', timestamp: 1, contextWindowId: window }],
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
function oldCount(events: StoredEvent[]) {
  return events.filter((event) => {
    const data = event.data as { role?: string; isSystemGenerated?: boolean }
    return event.type === 'message.start' && data.role === 'user' && !data.isSystemGenerated
  }).length
}
function assertEquivalent(store: EventStore, id = 's') {
  const before = store.getEvents(id),
    after = store.getReplayEvents(id)
  expect(after).toEqual(before)
  expect(store.getCurrentWindowId(id)).toBe(foldContextState(before, '').currentContextWindowId || undefined)
  expect(store.getUserMessageCount(id)).toBe(oldCount(before))
  expect(buildContextMessages(after, { type: 'toplevel', sessionId: id })).toEqual(
    buildContextMessages(before, { type: 'toplevel', sessionId: id }),
  )
  expect(
    buildContextMessages(after, { type: 'subagent', sessionId: id, subAgentId: 'sub', subAgentType: 'explorer' }),
  ).toEqual(
    buildContextMessages(before, { type: 'subagent', sessionId: id, subAgentId: 'sub', subAgentType: 'explorer' }),
  )
  expect(foldSessionState(after, '', 200000)).toEqual(foldSessionState(before, '', 200000))
  const session = { mode: 'builder', phase: 'build' as const, isRunning: true, criteria: [] }
  expect(buildSnapshotFromSessionState({ session, events: after, latestSeq: 20, snapshotAt: 1 })).toEqual(
    buildSnapshotFromSessionState({ session, events: before, latestSeq: 20, snapshotAt: 1 }),
  )
}
test('snapshot publication owns an immutable copy and cleanup never reparses the retained snapshot', () => {
  const { store } = fixture()
  store.append('s', { type: 'session.initialized', data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w' } })
  const data = snapshot()
  store.append('s', { type: 'turn.snapshot', data })
  data.messages[0]!.content = 'MUTATED'
  store.resetDiagnostics()
  const stored = store.getLatestSnapshot('s')!
  expect(stored.data.messages[0]!.content).toBe('OLD')
  expect(() => {
    stored.data.messages[0]!.content = 'MUTATED'
  }).toThrow()
  store.cleanupOldEvents('s')
  expect(store.getLatestSnapshot('s')).toBe(stored)
  store.cleanupOldEvents('s')
  expect(store.getLatestSnapshot('s')).toBe(stored)
  store.getReplayEvents('s')
  expect(store.getDiagnostics()?.snapshotParses).toBe(0)
})
test.each([false, true])(
  'functional equivalence with compaction, subagent, abort, truncate and tombstones (hot=%s)',
  (hot) => {
    const { store } = fixture(':memory:', hot)
    assertEquivalent(store)
    store.append('s', { type: 'session.initialized', data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w' } })
    store.append('s', {
      type: 'message.start',
      data: { messageId: 'u', role: 'user', content: 'OLD', contextWindowId: 'w' },
    })
    assertEquivalent(store)
    const snap = store.append('s', { type: 'turn.snapshot', data: snapshot() })
    assertEquivalent(store)
    const user = store.append('s', {
      type: 'message.start',
      data: { messageId: 'new', role: 'user', content: 'NEW', contextWindowId: 'w' },
    })
    store.append('s', { type: 'message.start', data: { messageId: 'a', role: 'assistant', contextWindowId: 'w' } })
    store.append('s', { type: 'message.delta', data: { messageId: 'a', content: 'PARTIAL' } })
    store.append('s', { type: 'chat.done', data: { messageId: 'a', reason: 'stopped' } })
    store.append('s', {
      type: 'context.compacted',
      data: {
        closedWindowId: 'sub-old',
        newWindowId: 'sub-new',
        beforeTokens: 10,
        afterTokens: 1,
        summary: '',
        subAgentId: 'sub',
      },
    })
    store.append('s', {
      type: 'message.start',
      data: {
        messageId: 'sub-msg',
        role: 'user',
        content: 'SUB',
        subAgentId: 'sub',
        subAgentType: 'explorer',
        contextWindowId: 'sub-new',
      },
    })
    assertEquivalent(store)
    expect(store.getCurrentWindowId('s')).toBe('w')
    store.append('s', {
      type: 'context.compacted',
      data: { closedWindowId: 'w', newWindowId: 'w2', beforeTokens: 10, afterTokens: 1, summary: 'SUMMARY' },
    })
    assertEquivalent(store)
    store.tombstoneEvents('s', [user.seq])
    assertEquivalent(store)
    store.updateEventPayload('s', snap.seq, snapshot('changed'))
    assertEquivalent(store)
    store.deleteEventsAfterSeq('s', snap.seq)
    assertEquivalent(store)
    store.tombstoneEvents('s', [snap.seq])
    assertEquivalent(store)
    store.deleteSession('s')
    assertEquivalent(store)
  },
)
test('hot readers do not parse the snapshot once warmed or on a new delta', () => {
  const { store } = fixture()
  store.append('s', { type: 'turn.snapshot', data: snapshot() })
  store.getReplayEvents('s')
  store.getCurrentWindowId('s')
  store.getUserMessageCount('s')
  store.resetDiagnostics()
  for (let n = 0; n < 5; n++) {
    store.append('s', {
      type: 'message.start',
      data: { messageId: 'u' + n, role: 'user', content: 'NEXT', contextWindowId: 'w' },
    })
    store.getReplayEvents('s')
    store.getCurrentWindowId('s')
    expect(store.getUserMessageCount('s')).toBe(n + 1)
  }
  expect(store.getDiagnostics()).toMatchObject({ snapshotParses: 0, fullReads: 0 })
})
test('an external writer invalidates snapshots and lightweight projections on the next read', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-external-'))
  dirs.push(root)
  const { store } = fixture(join(root, 'events.db'))
  store.append('s', { type: 'turn.snapshot', data: snapshot() })
  store.getReplayEvents('s')
  store.getCurrentWindowId('s')
  store.getUserMessageCount('s')
  const second = fixture(join(root, 'events.db')).store
  second.updateEventPayload('s', 1, snapshot('external'))
  expect(store.getCurrentWindowId('s')).toBe('external')
  expect(store.getLatestSnapshot('s')?.data.currentContextWindowId).toBe('external')
  second.append('s', { type: 'message.start', data: { messageId: 'u2', role: 'user', content: 'NEW' } })
  expect(store.getUserMessageCount('s')).toBe(1)
  assertEquivalent(store)
})
test('active snapshots bypass capacity eviction and become evictable on stop', () => {
  const { store } = fixture()
  for (let n = 0; n < 20; n++) {
    store.append(String(n), { type: 'running.changed', data: { isRunning: true } })
    store.append(String(n), { type: 'turn.snapshot', data: snapshot() })
  }
  store.resetDiagnostics()
  for (let n = 0; n < 20; n++) store.getLatestSnapshot(String(n))
  expect(store.getDiagnostics()?.snapshotParses).toBe(0)
  for (let n = 0; n < 20; n++) store.append(String(n), { type: 'running.changed', data: { isRunning: false } })
  store.resetDiagnostics()
  store.getLatestSnapshot('0')
  expect(store.getDiagnostics()?.snapshotParses).toBe(1)
})
test('batch and import publish only committed snapshots', () => {
  const { db, store } = fixture()
  store.appendBatch('s', [{ type: 'turn.snapshot', data: snapshot() }])
  store.importEvents('other', [{ seq: 1, timestamp: 1, sessionId: 'source', type: 'turn.snapshot', data: snapshot() }])
  store.resetDiagnostics()
  expect(store.getLatestSnapshot('s')).toBeDefined()
  expect(store.getLatestSnapshot('other')).toBeDefined()
  expect(store.getDiagnostics()?.snapshotParses).toBe(0)
  db.exec(
    "CREATE TRIGGER reject_snapshot BEFORE INSERT ON events WHEN NEW.event_type = 'turn.snapshot' BEGIN SELECT RAISE(ABORT, 'test rejection'); END",
  )
  expect(() => store.append('s', { type: 'turn.snapshot', data: snapshot('REJECTED') })).toThrow()
  expect(store.getLatestSnapshot('s')?.data.currentContextWindowId).toBe('w')
})

test('published snapshots match their JSON shape including absent optional values', () => {
  const { store } = fixture()
  const data = snapshot()
  data.messages[0]!.metadata = { omitted: undefined, kept: 'text' } as never
  store.append('s', { type: 'turn.snapshot', data })
  expect(store.getLatestSnapshot('s')?.data).toStrictEqual(JSON.parse(JSON.stringify(data)))
})

test.each(['0', '1'])('environment rollback selects the old full-reader path (%s)', (value) => {
  vi.stubEnv('OPENFOX_SNAPSHOT_HOT_PATH', value)
  try {
    const db = new Database(':memory:')
    databases.push(db)
    const store = new EventStore(db, { diagnostics: true })
    store.append('s', { type: 'turn.snapshot', data: snapshot() })
    store.resetDiagnostics()
    expect(store.getReplayEvents('s')).toEqual(store.getEvents('s'))
    const expectedFullReads = value === '0' ? 2 : 1
    expect(store.getDiagnostics()?.fullReads).toBe(expectedFullReads)
    expect(store.getCurrentWindowId('s')).toBe('w')
    expect(store.getUserMessageCount('s')).toBe(0)
  } finally {
    vi.unstubAllEnvs()
  }
})

test('snapshot publication measures cache-only memory overhead without exposing contents', () => {
  const { store } = fixture()
  store.append('s', { type: 'turn.snapshot', data: snapshot() })
  expect(store.getDiagnostics()?.cacheMemory.samples).toBe(1)
  expect(store.getDiagnostics()?.cacheMemory.heapDeltaBytes).toEqual(expect.any(Number))
  expect(store.getDiagnostics()?.cacheMemory.rssDeltaBytes).toEqual(expect.any(Number))
})

test('a technical import does not unpin an executing session under capacity pressure', () => {
  const { store } = fixture()
  store.append('active', { type: 'running.changed', data: { isRunning: true } })
  store.append('active', { type: 'turn.snapshot', data: snapshot() })
  const kept = store.getLatestSnapshot('active')
  store.importEvents('active', [
    { seq: 3, timestamp: 2, sessionId: 'source', type: 'message.delta', data: { messageId: 'a', content: 'delta' } },
  ])
  for (let n = 0; n < 20; n++) {
    store.append('idle-' + n, { type: 'turn.snapshot', data: { ...snapshot(), isRunning: false } })
  }
  store.resetDiagnostics()
  expect(store.getLatestSnapshot('active')).toBe(kept)
  expect(store.getDiagnostics()?.snapshotParses).toBe(0)
})

test.each(['update', 'deleteBefore', 'deleteAfter', 'tombstone'])(
  'local %s invalidates warmed projection and replay',
  (operation) => {
    const { store } = fixture()
    store.append('s', { type: 'session.initialized', data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w' } })
    const user = store.append('s', {
      type: 'message.start',
      data: { messageId: 'u', role: 'user', content: 'OLD', contextWindowId: 'w' },
    })
    const snap = store.append('s', { type: 'turn.snapshot', data: snapshot() })
    const tail = store.append('s', {
      type: 'message.start',
      data: { messageId: 'tail', role: 'user', content: 'TAIL', contextWindowId: 'w' },
    })
    assertEquivalent(store)
    if (operation === 'update')
      store.updateEventPayload('s', user.seq, {
        messageId: 'u',
        role: 'assistant',
        content: 'EDIT',
        contextWindowId: 'w',
      })
    if (operation === 'deleteBefore') store.deleteEventsUpToSeq('s', snap.seq)
    if (operation === 'deleteAfter') store.deleteEventsAfterSeq('s', snap.seq)
    if (operation === 'tombstone') store.tombstoneEvents('s', [tail.seq])
    assertEquivalent(store)
  },
)

test('cold projections reconstruct identically after reopening a database', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-reopen-'))
  dirs.push(root)
  const path = join(root, 'events.db')
  const first = fixture(path)
  first.store.append('s', { type: 'turn.snapshot', data: snapshot() })
  first.store.append('s', {
    type: 'context.compacted',
    data: { closedWindowId: 'w', newWindowId: 'w2', beforeTokens: 10, afterTokens: 1, summary: 'SUMMARY' },
  })
  first.store.append('s', {
    type: 'message.start',
    data: { messageId: 'new', role: 'user', content: 'NEXT', contextWindowId: 'w2' },
  })
  first.db.close()
  databases.splice(databases.indexOf(first.db), 1)
  const { store } = fixture(path)
  assertEquivalent(store)
  expect(store.getCurrentWindowId('s')).toBe('w2')
  expect(store.getUserMessageCount('s')).toBe(1)
})

test.each([false, true])('successive compacted and aborted tool histories remain equivalent (hot=%s)', (hotPath) => {
  const { store } = fixture(':memory:', hotPath)
  store.append('s', { type: 'session.initialized', data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w' } })
  const initial = snapshot()
  initial.messages.push({
    id: 'a',
    role: 'assistant',
    content: 'PARTIAL',
    timestamp: 2,
    contextWindowId: 'w',
    toolCalls: [{ id: 'pending', name: 'read_file', arguments: { path: 'test.txt' } }],
  })
  store.append('s', { type: 'turn.snapshot', data: initial })
  assertEquivalent(store)
  expect(store.getLatestSnapshot('s')?.data.messages[1]?.toolCalls?.[0]?.result).toBeUndefined()
  store.append('s', {
    type: 'tool.result',
    data: {
      messageId: 'a',
      toolCallId: 'pending',
      result: { success: true, output: 'RESULT', durationMs: 1, truncated: false },
    },
  })
  assertEquivalent(store)
  for (const [closed, next] of [
    ['w', 'w2'],
    ['w2', 'w3'],
  ]) {
    store.append('s', {
      type: 'context.compacted',
      data: {
        closedWindowId: closed!,
        newWindowId: next!,
        beforeTokens: 100,
        afterTokens: 10,
        summary: 'SUMMARY_' + next,
      },
    })
    store.append('s', {
      type: 'message.start',
      data: {
        messageId: 'summary-' + next,
        role: 'user',
        content: 'SUMMARY_' + next,
        contextWindowId: next!,
        isCompactionSummary: true,
      },
    })
    assertEquivalent(store)
    const data = buildSnapshotFromSessionState({
      session: { mode: 'builder', phase: 'build', isRunning: true, criteria: [] },
      events: store.getEvents('s'),
      latestSeq: store.getLatestSeq('s')!,
      snapshotAt: 10,
    })
    store.append('s', { type: 'turn.snapshot', data })
    store.cleanupOldEvents('s')
    assertEquivalent(store)
  }
  store.append('s', {
    type: 'message.start',
    data: {
      messageId: 'sub-user',
      role: 'user',
      content: 'SUB',
      subAgentId: 'sub',
      subAgentType: 'explorer',
      contextWindowId: 'w3',
    },
  })
  store.append('s', {
    type: 'message.start',
    data: { messageId: 'sub-a', role: 'assistant', subAgentId: 'sub', subAgentType: 'explorer', contextWindowId: 'w3' },
  })
  store.append('s', {
    type: 'tool.call',
    data: { messageId: 'sub-a', toolCall: { id: 'sub-tool', name: 'read_file', arguments: { path: 'test.txt' } } },
  })
  store.append('s', {
    type: 'tool.result',
    data: {
      messageId: 'sub-a',
      toolCallId: 'sub-tool',
      result: { success: true, output: 'SUB_RESULT', durationMs: 1, truncated: false },
    },
  })
  assertEquivalent(store)
  expect(store.getCurrentWindowId('s')).toBe('w3')
})

test('failed batch and import leave both the existing cache and the database intact', () => {
  const { store, db } = fixture()
  store.append('s', { type: 'turn.snapshot', data: snapshot() })
  const retained = store.getLatestSnapshot('s')
  db.exec(
    "CREATE TRIGGER reject_end BEFORE INSERT ON events WHEN NEW.event_type='message.done' BEGIN SELECT RAISE(ABORT, 'test rejection'); END",
  )
  expect(() =>
    store.appendBatch('s', [
      { type: 'turn.snapshot', data: snapshot('REJECTED') },
      { type: 'message.done', data: { messageId: 'end' } },
    ]),
  ).toThrow()
  expect(store.getLatestSnapshot('s')).toBe(retained)
  expect(store.getEvents('s')).toHaveLength(1)
  expect(() =>
    store.importEvents('s', [
      { seq: 2, sessionId: 'source', timestamp: 2, type: 'turn.snapshot', data: snapshot('REJECTED') },
      { seq: 3, sessionId: 'source', timestamp: 2, type: 'message.done', data: { messageId: 'end' } },
    ]),
  ).toThrow()
  expect(store.getLatestSnapshot('s')).toBe(retained)
  expect(store.getEvents('s')).toHaveLength(1)
})

test('diagnostics include retained pre-snapshot bytes and release them after cleanup', () => {
  const { store } = fixture()
  const initial = { projectId: 'p', workdir: '/tmp', contextWindowId: 'w' }
  store.append('s', { type: 'session.initialized', data: initial })
  const older = snapshot()
  older.messages[0]!.content = 'é'.repeat(4096)
  store.append('s', { type: 'turn.snapshot', data: older })
  store.append('s', { type: 'turn.snapshot', data: snapshot() })
  store.getReplayEvents('s')
  expect(store.getDiagnostics()?.replayPrefixes).toEqual({
    entries: 1,
    events: 2,
    serializedBytes: Buffer.byteLength(JSON.stringify(initial)) + Buffer.byteLength(JSON.stringify(older)),
  })
  store.resetDiagnostics()
  expect(store.getDiagnostics()?.replayPrefixes.entries).toBe(1)
  store.cleanupOldEvents('s')
  expect(store.getDiagnostics()?.replayPrefixes).toEqual({ entries: 0, events: 0, serializedBytes: 0 })
  store.getReplayEvents('s')
  expect(store.getDiagnostics()?.replayPrefixes.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(initial)))
  store.deleteSession('s')
  expect(store.getDiagnostics()?.replayPrefixes.entries).toBe(0)
})
