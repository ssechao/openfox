import { performance } from 'node:perf_hooks'
import { attachWorkerDatabase, closeDatabase } from '../db/index.js'
import { attachWorkerEventStore } from './store.js'

const dbPath = process.env['OPENFOX_BUSY_TEST_DB_PATH']
const sessionId = process.env['OPENFOX_BUSY_TEST_SESSION_ID']
const workerId = process.env['OPENFOX_BUSY_TEST_WORKER_ID']
const generation = Number(process.env['OPENFOX_BUSY_TEST_GENERATION'])
const eventCount = Number(process.env['OPENFOX_BUSY_TEST_EVENT_COUNT'])

if (!dbPath || !sessionId || !workerId || !Number.isInteger(generation) || !Number.isInteger(eventCount)) {
  throw new Error('Missing busy-test worker environment')
}

const db = attachWorkerDatabase(dbPath)
const store = attachWorkerEventStore(db, { workerId, generation })

process.on('message', (message) => {
  if (message !== 'start') return
  const durations: number[] = []
  let startedAt: number | null = null
  try {
    for (let index = 0; index < eventCount; index++) {
      startedAt = performance.now()
      store.append(sessionId, {
        type: 'message.start',
        data: { messageId: `${workerId}-${index}`, role: 'assistant', content: 'contention' },
      })
      durations.push(performance.now() - startedAt)
      startedAt = null
    }
    process.send?.({ ok: true, durations })
  } catch (error) {
    if (startedAt !== null) durations.push(performance.now() - startedAt)
    process.send?.({
      ok: false,
      durations,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: unknown }).code,
    })
  } finally {
    closeDatabase()
    process.disconnect()
  }
})

process.send?.({ type: 'ready', busyTimeoutMs: db.pragma('busy_timeout', { simple: true }) })
