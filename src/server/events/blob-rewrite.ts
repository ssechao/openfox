import type Database from 'better-sqlite3'
import { parkAtBlobBarrier } from './blob-barrier.js'

export function rewriteSessionPayloads(
  db: Database.Database,
  sessionId: string,
  options: {
    shouldRewrite: (payload: string) => boolean
    transform: (parsed: unknown) => unknown
    afterPrepBarrier: string
    beforeSwitchBarrier: string
    afterSwitchBarrier: string
    markPrepared: () => void
    markSwitched: () => void
  },
): { scanned: number; rewritten: number } {
  const rows = db.prepare('SELECT id, payload FROM events WHERE session_id = ?').all(sessionId) as Array<{
    id: number
    payload: string
  }>
  const updates: Array<{ id: number; payload: string }> = []
  for (const row of rows) {
    if (!options.shouldRewrite(row.payload)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    const next = JSON.stringify(options.transform(parsed))
    if (next !== row.payload) updates.push({ id: row.id, payload: next })
  }

  parkAtBlobBarrier(options.afterPrepBarrier)
  options.markPrepared()
  parkAtBlobBarrier(options.beforeSwitchBarrier)

  const switchTx = db.transaction(() => {
    const update = db.prepare('UPDATE events SET payload = ? WHERE id = ?')
    for (const row of updates) update.run(row.payload, row.id)
    options.markSwitched()
  })
  switchTx()
  parkAtBlobBarrier(options.afterSwitchBarrier)

  return { scanned: rows.length, rewritten: updates.length }
}
