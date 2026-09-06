import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { EventStore } from '../events/store.js'
import { applyEvents } from '../events/apply-events.js'
import type { TurnEvent, SnapshotMessage } from '../events/types.js'
import type { PureStreamResult } from './stream-pure.js'
import { coalesceStreamEvents, STREAM_FLUSH_INTERVAL_MS } from './coalesce-stream.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initEventStore } from '../events/store.js'

const result: PureStreamResult = {
  content: '',
  toolCalls: [],
  segments: [],
  aborted: false,
  finishReason: 'stop',
  usage: { promptTokens: 0, completionTokens: 0 },
  timing: { ttft: 0, completionTime: 0, tps: 0, prefillTps: 0 },
}

afterEach(() => vi.useRealTimers())

describe('stream persistence coalescing', () => {
  it('recovers the last durable flush after the producer process is killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openfox-stream-crash-'))
    const path = join(directory, 'test.db')
    const script = `
      import Database from 'better-sqlite3';
      import { EventStore } from ${JSON.stringify(new URL('../events/store.ts', import.meta.url).href)};
      import { coalesceStreamEvents } from ${JSON.stringify(new URL('./coalesce-stream.ts', import.meta.url).href)};
      Date.now = () => 1700000000000;
      const db = new Database(process.argv[1]);
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0)');
      db.prepare('INSERT INTO sessions (id,is_running) VALUES (?,1)').run('session');
      const store = new EventStore(db);
      store.append('session', {type:'running.changed',data:{isRunning:true}});
      store.append('session', {type:'message.start',data:{messageId:'message',role:'assistant'}});
      async function* source() {
        for (let i=0; i<1000; i++) yield {type:'message.thinking',data:{messageId:'message',content:'part;'}};
        await new Promise(() => {});
      }
      setInterval(() => {}, 1000);
      for await (const event of coalesceStreamEvents(source())) {
        store.append('session', event);
        process.stdout.write('persisted\\n');
      }
    `
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const exited = once(child, 'exit')
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`No durable flush from child: ${stderr}`)), 10000)
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('exit', () => {
          clearTimeout(timeout)
          reject(new Error(`Child exited before flush: ${stderr}`))
        })
        child.stdout.once('data', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      child.kill('SIGKILL')
      expect((await exited)[1]).toBe('SIGKILL')
      const db = new Database(path)
      try {
        const store = initEventStore(db)
        const events = store.getEvents('session')
        expect(applyEvents([], events, { timestampAsNumber: true })[0]).toMatchObject({
          thinkingContent: 'part;'.repeat(1000),
          isStreaming: false,
          partial: true,
        })
        expect(events.at(-1)?.data).toEqual({ isRunning: false })
        expect(events.filter((event) => event.type === 'message.thinking')).toHaveLength(1)
      } finally {
        db.close()
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it('persists 4000 thinking deltas in four flushes, with identical streamed and fetched content', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const statements: string[] = []
    const db = new Database(':memory:', { verbose: (sql) => statements.push(String(sql)) })
    try {
      const store = new EventStore(db)
      store.append('session', { type: 'message.start', data: { messageId: 'message', role: 'assistant' } })
      statements.length = 0
      const observed: TurnEvent[] = []
      async function* source(): AsyncGenerator<TurnEvent, PureStreamResult> {
        for (let batch = 0; batch < 4; batch++) {
          vi.setSystemTime(batch * STREAM_FLUSH_INTERVAL_MS)
          for (let i = 0; i < 1000; i++) {
            yield { type: 'message.thinking', data: { messageId: 'message', content: `${batch}:${i};` } }
          }
        }
        return result
      }
      for await (const event of coalesceStreamEvents(source())) {
        observed.push(event)
        store.append('session', event)
      }
      const inserts = statements.filter((sql) => /^INSERT INTO events/.test(sql))
      expect(inserts).toHaveLength(4)
      expect(observed).toHaveLength(4)
      const expected = Array.from({ length: 4 }, (_, batch) =>
        Array.from({ length: 1000 }, (_, i) => `${batch}:${i};`).join(''),
      ).join('')
      const fetched = applyEvents<SnapshotMessage>([], store.getEvents('session'), { timestampAsNumber: true })
      expect(fetched[0]?.thinkingContent).toBe(expected)
      expect(observed.map((event) => (event.data as { content: string }).content).join('')).toBe(expected)
      expect(statements.some((sql) => /UPDATE events|turn.snapshot|message.checkpoint/.test(sql))).toBe(false)
    } finally {
      db.close()
    }
  })

  it('flushes while the producer is awaiting its next chunk, and closes without a pending timer', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    async function* source(): AsyncGenerator<TurnEvent, PureStreamResult> {
      yield { type: 'message.delta', data: { messageId: 'message', content: 'tail' } }
      await gate
      return result
    }
    const observed: TurnEvent[] = []
    const consuming = (async () => {
      for await (const event of coalesceStreamEvents(source())) observed.push(event)
    })()
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_INTERVAL_MS - 1)
    expect(observed).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(observed).toHaveLength(1)
    finish()
    await consuming
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves event ordering across thinking, text, tools and terminal boundaries', async () => {
    const events: TurnEvent[] = [
      { type: 'message.thinking', data: { messageId: 'message', content: 'think' } },
      { type: 'message.delta', data: { messageId: 'message', content: 'answer' } },
      { type: 'tool.preparing', data: { messageId: 'message', index: 0, name: 'run_command', arguments: '{' } },
      { type: 'tool.preparing', data: { messageId: 'message', index: 0, name: 'run_command', arguments: '{}' } },
      { type: 'message.done', data: { messageId: 'message' } },
    ]
    async function* source(): AsyncGenerator<TurnEvent, PureStreamResult> {
      yield* events
      return result
    }
    const observed: TurnEvent[] = []
    for await (const event of coalesceStreamEvents(source())) observed.push(event)
    expect(observed).toEqual([events[0], events[1], events[3], events[4]])
  })

  it('flushes the remaining content before propagating a producer exception', async () => {
    async function* source(): AsyncGenerator<TurnEvent, PureStreamResult> {
      yield { type: 'message.thinking', data: { messageId: 'message', content: 'partial' } }
      throw new Error('disconnected')
    }
    const observed: TurnEvent[] = []
    await expect(
      (async () => {
        for await (const event of coalesceStreamEvents(source())) observed.push(event)
      })(),
    ).rejects.toThrow('disconnected')
    expect(observed).toEqual([{ type: 'message.thinking', data: { messageId: 'message', content: 'partial' } }])
  })
})
