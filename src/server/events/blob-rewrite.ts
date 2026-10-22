import type Database from 'better-sqlite3'
import { parkAtBlobBarrier } from './blob-barrier.js'

export function sessionPayloadsNeedRewrite(
  db: Database.Database,
  sessionId: string,
  shouldRewrite: (payload: string) => boolean,
): { scanned: number; needed: boolean } {
  let scanned = 0
  let needed = false
  const stmt = db.prepare('SELECT payload FROM events WHERE session_id = ?')
  for (const row of stmt.iterate(sessionId) as IterableIterator<{ payload: string }>) {
    scanned++
    if (!needed && shouldRewrite(row.payload)) needed = true
  }
  return { scanned, needed }
}

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
  const updates: Array<{ id: number; payload: string }> = []
  let scanned = 0
  const stmt = db.prepare('SELECT id, payload FROM events WHERE session_id = ?')
  for (const row of stmt.iterate(sessionId) as IterableIterator<{ id: number; payload: string }>) {
    scanned++
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

  return { scanned, rewritten: updates.length }
}
