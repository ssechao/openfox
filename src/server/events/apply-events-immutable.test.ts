import { expect, test } from 'vitest'
import { applyEvents } from './apply-events.js'
import { immutableSnapshot } from './immutable-snapshot.js'
import type { StoredEvent, TurnEvent } from './types.js'

const events: TurnEvent[] = [
  { type: 'tool.output', data: { messageId: 'a', toolCallId: 't', stream: 'stdout', content: 'next' } },
  { type: 'tool.preparing', data: { messageId: 'a', index: 1, name: 'read_file' } },
  {
    type: 'pattern.retry',
    data: { messageId: 'a', attempt: 2, maxAttempts: 3, pattern: '', field: '', matchedContent: '' },
  },
]

test.each(events)('replays $type without mutating nested arrays in a frozen snapshot', (event) => {
  const messages = [
    {
      id: 'a',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [
        {
          id: 't',
          name: 'read_file',
          arguments: {},
          streamingOutput: [{ stream: 'stdout' as const, content: 'first', timestamp: 1 }],
        },
      ],
      preparingToolCalls: [{ index: 0, name: 'read_file' }],
      formatRetries: [{ attempt: 1, maxAttempts: 3, timestamp: 1 }],
    },
  ]
  const frozen = immutableSnapshot(messages)
  const replay: StoredEvent[] = [{ ...event, seq: 2, sessionId: 's', timestamp: 2 }]
  const expected = applyEvents(structuredClone(messages), replay, { timestampAsNumber: true })
  expect(applyEvents(frozen, replay, { timestampAsNumber: true })).toEqual(expected)
  expect(frozen).toEqual(messages)
})
