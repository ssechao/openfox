/** Offline export only: never loads user config, writes SQLite, or calls a model. */
import Database from 'better-sqlite3'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { buildContextMessagesFromEventHistory } from '../src/server/events/fold-messages.js'
import { convertMessages } from '../src/server/llm/client-pure.js'
import { buildResponsesRequest } from '../src/server/llm/responses-native.js'
import type { SessionSnapshot, StoredEvent } from '../src/server/events/types.js'

const { values } = parseArgs({
  options: { database: { type: 'string' }, session: { type: 'string' }, output: { type: 'string' } },
})
if (!values.database || !values.session || !values.output)
  throw new Error('--database, --session and --output are required')
const db = new Database(values.database, { readonly: true, fileMustExist: true })
try {
  db.pragma('query_only = ON')
  const rows = db
    .prepare('SELECT seq, timestamp, event_type, payload FROM events WHERE session_id = ? ORDER BY seq')
    .all(values.session) as Array<{ seq: number; timestamp: number; event_type: string; payload: string }>
  const events = rows.map((row) => ({
    sessionId: values.session,
    seq: row.seq,
    timestamp: row.timestamp,
    type: row.event_type,
    data: JSON.parse(row.payload),
  })) as StoredEvent[]
  const snapshot = [...events].reverse().find((event) => event.type === 'turn.snapshot')
  if (!snapshot || snapshot.type !== 'turn.snapshot') throw new Error('A reconstructible snapshot is required')
  const snapshotData = snapshot.data as SessionSnapshot
  const sourceMessages = buildContextMessagesFromEventHistory(events, snapshotData.currentContextWindowId)
  const converted = await convertMessages(sourceMessages, true, undefined, undefined, undefined, 'responses')
  const canonicalInput = buildResponsesRequest({ model: 'claude-opus-5', messages: converted, stream: false }).input
  const emptyAssistantWitnesses: Array<{ sourceMessageIndex: number; canonicalInputIndex: number }> = []
  for (const [sourceMessageIndex, message] of sourceMessages.entries()) {
    if (message.role !== 'assistant' || message.content !== '' || message.toolCalls?.length || !message.thinkingContent)
      continue
    const prefix = await convertMessages(
      sourceMessages.slice(0, sourceMessageIndex + 1),
      true,
      undefined,
      undefined,
      undefined,
      'responses',
    )
    const input = buildResponsesRequest({ model: 'claude-opus-5', messages: prefix, stream: false }).input
    emptyAssistantWitnesses.push({ sourceMessageIndex, canonicalInputIndex: input.length - 1 })
  }
  await writeFile(
    values.output,
    JSON.stringify({
      version: 1,
      sessionId: values.session,
      latestSeq: rows.at(-1)?.seq,
      sourceMessages,
      canonicalInput,
      emptyAssistantWitnesses,
    }),
    { flag: 'wx', mode: 0o600 },
  )
  console.log(
    JSON.stringify({ exported: values.output, messages: sourceMessages.length, inputItems: canonicalInput.length }),
  )
} finally {
  db.close()
}
