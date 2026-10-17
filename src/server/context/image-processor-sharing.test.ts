import { beforeEach, expect, test, vi } from 'vitest'
import { processContextImages, clearImageDescriptionCache } from './image-processor.js'
import { immutableSnapshot } from '../events/immutable-snapshot.js'
import type { SessionSnapshot, StoredEvent, TurnEvent, SnapshotMessage } from '../events/types.js'
import type { Attachment, ToolResult } from '../../shared/types.js'

vi.mock('../tools/pdf-utils.js', () => ({
  extractPdfContent: vi.fn().mockResolvedValue({ blocks: [{ type: 'text', content: 'PDF text' }] }),
}))

const image: Attachment = {
  id: 'img',
  filename: 'image.png',
  mimeType: 'image/png',
  size: 1,
  data: 'data:image/png;base64,eA==',
}
const pdf: Attachment = {
  id: 'pdf',
  filename: 'document.pdf',
  mimeType: 'application/pdf',
  size: 1,
  data: 'data:application/pdf;base64,eA==',
}
const described: Attachment = { ...image, id: 'known', description: 'Known image' }
const imageResult: ToolResult = {
  success: true,
  output: 'image result',
  durationMs: 1,
  truncated: false,
  metadata: { mimeType: 'image/png', dataUrl: image.data, path: 'tool.png', extra: { retained: true } },
}
function event(value: TurnEvent, seq = 1): StoredEvent {
  return { ...value, sessionId: 's', seq, timestamp: seq }
}
function snapshot(messages: SnapshotMessage[]): SessionSnapshot {
  return {
    mode: 'builder',
    phase: 'build',
    isRunning: true,
    messages,
    criteria: [],
    metadataEntries: {},
    todos: [],
    currentContextWindowId: 'w',
    snapshotAt: 1,
    snapshotSeq: 1,
    contextState: {
      currentTokens: 0,
      maxTokens: 1000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
  }
}
function user(attachments: Attachment[], id = 'u'): SnapshotMessage {
  return { id, role: 'user', content: 'TEXT', timestamp: 1, attachments, contextWindowId: 'w' }
}
beforeEach(() => {
  clearImageDescriptionCache()
  vi.restoreAllMocks()
})

test.each([
  { name: 'none', attachments: [] },
  { name: 'image', attachments: [image] },
  { name: 'pdf', attachments: [pdf] },
  { name: 'mixed', attachments: [image, pdf] },
])('preserves enrichment and persistence for $name with frozen input', async ({ attachments }) => {
  const input = immutableSnapshot([
    event({ type: 'message.start', data: { messageId: 'u', role: 'user', content: 'TEXT', attachments } }),
    event({ type: 'turn.snapshot', data: snapshot([user([], 'archive')]) }, 2),
  ])
  const before = JSON.stringify(input)
  const expected = structuredClone(input)
  const expectedData = expected[0]!.data as Extract<TurnEvent, { type: 'message.start' }>['data']
  const descriptions = new Map<string, string>()
  for (const att of expectedData.attachments!) {
    if (att.mimeType === 'application/pdf') att.pdfContent = '[PDF: document.pdf]\n\nPDF text'
    else att.description = '[Image: image.png]'
    descriptions.set(att.id, att.pdfContent ?? att.description!)
  }
  const clone = vi.spyOn(globalThis, 'structuredClone')
  const persistEvent = vi.fn()
  const result = await processContextImages(input, { modelSupportsVision: false, persistEvent })
  expect(result).toEqual({ events: expected, descriptions })
  expect(JSON.stringify(input)).toBe(before)
  expect(persistEvent.mock.calls).toEqual(attachments.length ? [['s', 1, expectedData]] : [])
  expect(result.events[1]).toBe(input[1])
  expect(clone).not.toHaveBeenCalled()
  if (attachments.length === 0) expect(result.events).toBe(input)
  else expect(persistEvent.mock.calls[0]![2]).toBe(result.events[0]!.data)
})

test('reuses an entirely described snapshot and every nested object', async () => {
  const input = immutableSnapshot([
    event({
      type: 'turn.snapshot',
      data: snapshot([
        user([described, { ...pdf, pdfContent: 'Known PDF' }]),
        {
          id: 'a',
          role: 'assistant',
          content: '',
          timestamp: 2,
          toolCalls: [
            {
              id: 't',
              name: 'read_file',
              arguments: {},
              result: { ...imageResult, metadata: { ...imageResult.metadata, description: 'Known tool image' } },
            },
          ],
        },
      ]),
    }),
  ])
  const persistEvent = vi.fn()
  const clone = vi.spyOn(globalThis, 'structuredClone')
  const result = await processContextImages(input, { modelSupportsVision: false, persistEvent })
  expect(result.events).toBe(input)
  expect(result.descriptions).toEqual(
    new Map([
      ['known', 'Known image'],
      ['pdf', 'Known PDF'],
      ['t', 'Known tool image'],
    ]),
  )
  expect(persistEvent).not.toHaveBeenCalled()
  expect(clone).not.toHaveBeenCalled()
})

test('copies only the path to a single new snapshot attachment', async () => {
  const data = snapshot([user([described], 'old'), user([image, described], 'new')])
  const input = immutableSnapshot([event({ type: 'turn.snapshot', data })])
  const original = input[0]!.data as SessionSnapshot
  const before = JSON.stringify(input)
  const persistEvent = vi.fn()
  const result = await processContextImages(input, { modelSupportsVision: false, persistEvent })
  const next = result.events[0]!.data as SessionSnapshot
  expect(next).toEqual({
    ...original,
    messages: [
      original.messages[0],
      { ...original.messages[1], attachments: [{ ...image, description: '[Image: image.png]' }, described] },
    ],
  })
  expect(result.events).not.toBe(input)
  expect(result.events[0]).not.toBe(input[0])
  expect(next).not.toBe(original)
  expect(next.messages).not.toBe(original.messages)
  expect(next.messages[0]).toBe(original.messages[0])
  expect(next.messages[1]).not.toBe(original.messages[1])
  expect(next.messages[1]!.attachments).not.toBe(original.messages[1]!.attachments)
  expect(next.messages[1]!.attachments![1]).toBe(original.messages[1]!.attachments![1])
  expect(next.contextState).toBe(original.contextState)
  expect(next.metadataEntries).toBe(original.metadataEntries)
  expect(JSON.stringify(input)).toBe(before)
  expect(persistEvent.mock.calls).toEqual([['s', 1, next]])
  expect(persistEvent.mock.calls[0]![2]).toBe(next)
  persistEvent.mockClear()
  const again = await processContextImages(result.events, { modelSupportsVision: false, persistEvent })
  expect(again.events).toBe(result.events)
  expect(again.descriptions).toEqual(result.descriptions)
  expect(persistEvent).not.toHaveBeenCalled()
})

test.each([false, true])('copies only the image result metadata path (snapshot=%s)', async (inSnapshot) => {
  const toolCall = { id: 't', name: 'read_file', arguments: { path: 'file' }, result: imageResult }
  const assistant: SnapshotMessage = {
    id: 'a',
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [toolCall, { id: 'other', name: 'read_file', arguments: {} }],
  }
  const input = immutableSnapshot([
    inSnapshot
      ? event({ type: 'turn.snapshot', data: snapshot([user([described]), assistant]) })
      : event({ type: 'tool.result', data: { messageId: 'a', toolCallId: 't', result: imageResult } }),
  ])
  const before = JSON.stringify(input)
  const originalResult = inSnapshot
    ? (input[0]!.data as SessionSnapshot).messages[1]!.toolCalls![0]!.result!
    : (input[0]!.data as Extract<TurnEvent, { type: 'tool.result' }>['data']).result
  const persistEvent = vi.fn()
  const result = await processContextImages(input, { modelSupportsVision: false, persistEvent })
  const next = result.events[0]!.data
  const nextResult = inSnapshot
    ? (next as SessionSnapshot).messages[1]!.toolCalls![0]!.result!
    : (next as Extract<TurnEvent, { type: 'tool.result' }>['data']).result
  expect(nextResult).toEqual({
    ...originalResult,
    metadata: { ...originalResult.metadata, description: '[Image: tool.png]' },
  })
  expect(nextResult).not.toBe(originalResult)
  expect(nextResult.metadata).not.toBe(originalResult.metadata)
  expect(nextResult.metadata!['extra']).toBe(originalResult.metadata!['extra'])
  if (inSnapshot) {
    const previous = input[0]!.data as SessionSnapshot
    const current = next as SessionSnapshot
    expect(current.messages[0]).toBe(previous.messages[0])
    expect(current.messages[1]).not.toBe(previous.messages[1])
    expect(current.messages[1]!.toolCalls![0]!.arguments).toBe(previous.messages[1]!.toolCalls![0]!.arguments)
    expect(current.messages[1]!.toolCalls![1]).toBe(previous.messages[1]!.toolCalls![1])
  }
  expect(JSON.stringify(input)).toBe(before)
  expect(persistEvent.mock.calls).toEqual([['s', 1, next]])
  expect(persistEvent.mock.calls[0]![2]).toBe(next)
  expect(result.descriptions.get('t')).toBe('[Image: tool.png]')
})
