import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  MAX_PERSISTED_TOOL_OUTPUT_BYTES,
  TOOL_OUTPUT_TRUNCATED_MESSAGE,
  createToolProgressHandler,
  parseProgressMessage,
} from './tool-streaming.js'
import { EventStore } from '../events/store.js'
import Database from 'better-sqlite3'

let db: Database.Database
let eventStore: EventStore
let append: (event: import('../events/types.js').TurnEvent) => void

describe('tool streaming', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    eventStore = new EventStore(db)
    append = (event) => {
      eventStore.append('test-session', event)
    }
    ;(global as any).__eventStore = eventStore
  })

  afterEach(() => {
    db.close()
  })

  describe('parseProgressMessage', () => {
    it('parses [stdout] prefix correctly', () => {
      const result = parseProgressMessage('[stdout] hello world')

      expect(result).toEqual({
        stream: 'stdout',
        content: 'hello world',
      })
    })

    it('parses [stderr] prefix correctly', () => {
      const result = parseProgressMessage('[stderr] error occurred')

      expect(result).toEqual({
        stream: 'stderr',
        content: 'error occurred',
      })
    })

    it('preserves content with newlines', () => {
      const result = parseProgressMessage('[stdout] line1\nline2\nline3')

      expect(result).toEqual({
        stream: 'stdout',
        content: 'line1\nline2\nline3',
      })
    })

    it('returns null for malformed messages', () => {
      expect(parseProgressMessage('no prefix here')).toBeNull()
      expect(parseProgressMessage('[invalid] content')).toBeNull()
      expect(parseProgressMessage('')).toBeNull()
    })

    it('handles edge case of empty content after prefix', () => {
      const result = parseProgressMessage('[stdout] ')

      expect(result).toEqual({
        stream: 'stdout',
        content: '',
      })
    })

    it('handles content that looks like a prefix', () => {
      const result = parseProgressMessage('[stdout] [stderr] nested')

      expect(result).toEqual({
        stream: 'stdout',
        content: '[stderr] nested',
      })
    })
  })

  describe('createToolProgressHandler', () => {
    it('creates handler that emits tool.output events to EventStore', () => {
      const handler = createToolProgressHandler(append, 'msg-1', 'call-1', 'test-session')
      handler('[stdout] test output')

      const events = eventStore.getEvents('test-session')

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('tool.output')
      expect(events[0]!.data).toEqual({
        messageId: 'msg-1',
        toolCallId: 'call-1',
        stream: 'stdout',
        content: 'test output',
      })
    })

    it('handles multiple progress calls', () => {
      const handler = createToolProgressHandler(append, 'msg-1', 'call-1', 'test-session')
      handler('[stdout] line1')
      handler('[stdout] line2')
      handler('[stderr] warning')

      const events = eventStore.getEvents('test-session')

      expect(events).toHaveLength(3)
      expect(events[0]!.data).toMatchObject({ stream: 'stdout', content: 'line1' })
      expect(events[1]!.data).toMatchObject({ stream: 'stdout', content: 'line2' })
      expect(events[2]!.data).toMatchObject({ stream: 'stderr', content: 'warning' })
    })

    it('bounds persisted output and emits one explicit truncation marker', () => {
      const events: import('../events/types.js').TurnEvent[] = []
      const handler = createToolProgressHandler((event) => events.push(event), 'msg-1', 'call-1', 'test-session')
      const chunk = 'x'.repeat(64 * 1024)

      for (let index = 0; index < 20; index++) handler(`[stdout] ${chunk}`)
      handler('[stderr] ignored after truncation')

      const contents = events.map((event) => (event.data as { content: string }).content)
      const persistedBytes = contents.reduce((total, content) => total + Buffer.byteLength(content), 0)
      expect(persistedBytes).toBeLessThanOrEqual(
        MAX_PERSISTED_TOOL_OUTPUT_BYTES + Buffer.byteLength(TOOL_OUTPUT_TRUNCATED_MESSAGE),
      )
      expect(contents.filter((content) => content === TOOL_OUTPUT_TRUNCATED_MESSAGE)).toHaveLength(1)
      expect(contents.join('')).not.toContain('ignored after truncation')
    })

    it('ignores malformed progress messages', () => {
      const handler = createToolProgressHandler(append, 'msg-1', 'call-1', 'test-session')
      handler('not a valid progress message')
      handler('[invalid] prefix')

      const events = eventStore.getEvents('test-session')

      expect(events).toHaveLength(0)
    })

    it('passes correct messageId and callId for each call', () => {
      const handler1 = createToolProgressHandler(append, 'msg-A', 'call-A', 'test-session')
      const handler2 = createToolProgressHandler(append, 'msg-B', 'call-B', 'test-session')

      handler1('[stdout] from A')
      handler2('[stdout] from B')

      const events = eventStore.getEvents('test-session')

      expect(events[0]!.data).toMatchObject({
        messageId: 'msg-A',
        toolCallId: 'call-A',
        content: 'from A',
      })
      expect(events[1]!.data).toMatchObject({
        messageId: 'msg-B',
        toolCallId: 'call-B',
        content: 'from B',
      })
    })
  })
})
