import Database from 'better-sqlite3'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { EventStore } from '../../src/server/events/store.js'
import { buildContextMessages } from '../../src/server/chat/conversation-history.js'
import { buildSnapshotFromSessionState, foldContextState, foldSessionState } from '../../src/server/events/folding.js'

const path = resolve(process.argv[2] ?? '')
if (!path.startsWith(resolve('report/private') + sep) || !path.endsWith('.db'))
  throw new Error('Only a private database copy is allowed')
const db = new Database(path, { fileMustExist: true })
const sessions = db
  .prepare(
    `SELECT session_id, max(length(payload)) AS bytes FROM events
  WHERE event_type='turn.snapshot' GROUP BY session_id ORDER BY bytes DESC LIMIT 7`,
  )
  .all() as { session_id: string; bytes: number }[]
const results = []
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const equal = (left: unknown, right: unknown, stage: string) => assert.equal(digest(left), digest(right), stage)
function deterministic<T>(work: () => T): T {
  const original = globalThis.crypto.randomUUID
  let counter = 0
  globalThis.crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  try {
    return work()
  } finally {
    globalThis.crypto.randomUUID = original
  }
}
try {
  for (const row of sessions) {
    const store = new EventStore(db, { diagnostics: true, hotPath: true })
    const oldEvents = store.getEvents(row.session_id)
    const newEvents = store.getReplayEvents(row.session_id)
    equal(newEvents, oldEvents, 'raw replay')
    const oldWindow = foldContextState(oldEvents, '').currentContextWindowId || undefined
    assert.equal(store.getCurrentWindowId(row.session_id), oldWindow)
    const count = oldEvents.filter((event) => {
      const data = event.data as { role?: string; isSystemGenerated?: boolean }
      return event.type === 'message.start' && data.role === 'user' && !data.isSystemGenerated
    }).length
    assert.equal(store.getUserMessageCount(row.session_id), count)
    const scope = { type: 'toplevel' as const, sessionId: row.session_id }
    equal(
      deterministic(() => buildContextMessages(newEvents, scope)),
      deterministic(() => buildContextMessages(oldEvents, scope)),
      'LLM messages with seeded transient attachment UUIDs',
    )
    equal(foldSessionState(newEvents, '', 200000), foldSessionState(oldEvents, '', 200000), 'folded state')
    const session = { mode: 'builder', phase: 'build' as const, isRunning: false, criteria: [] }
    equal(
      buildSnapshotFromSessionState({ session, events: newEvents, latestSeq: 1, snapshotAt: 1 }),
      buildSnapshotFromSessionState({ session, events: oldEvents, latestSeq: 1, snapshotAt: 1 }),
      'snapshot',
    )
    store.resetDiagnostics()
    store.getReplayEvents(row.session_id)
    store.getCurrentWindowId(row.session_id)
    store.getUserMessageCount(row.session_id)
    assert.equal(store.getDiagnostics()?.snapshotParses, 0)
    const reloaded = new EventStore(db, { hotPath: false })
    equal(reloaded.getReplayEvents(row.session_id), oldEvents, 'legacy switch')
    results.push({
      sessionHash: createHash('sha256').update(row.session_id).digest('hex').slice(0, 16),
      snapshotJsonUnits: row.bytes,
      events: oldEvents.length,
      equivalent: true,
      warmedSnapshotParses: 0,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  process.stdout.write(
    JSON.stringify(
      {
        source: 'private consistent copy',
        cases: results,
        sourceContentPublished: false,
        comparison: 'Exact digests; fresh attachment UUID sequence seeded identically in each LLM fold',
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  db.close()
}
