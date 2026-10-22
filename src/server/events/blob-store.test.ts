import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertMessages } from '../llm/client-pure.js'
import { buildResponsesRequest } from '../llm/responses-native.js'
import { decodeDataUrl } from '../utils/data-url.js'
import { EventStore } from './store.js'
import {
  BlobCorruptError,
  BlobMissingError,
  FileBlobStore,
  MemoryBlobStore,
  hashBytes,
  setBlobStore,
} from './blob-store.js'
import { hydrateAttachmentData } from './blob-codec.js'
import {
  CRASH_HASH,
  CRASH_PNG,
  CRASH_PNG_URL,
  assertResolvablePng,
  eventPayloads,
  killAtBarrier,
  reopenCrashStore,
  seedCrashDatabase,
} from './blob-crash-harness.js'
import type { Attachment } from '../../shared/types.js'
import type { LLMMessage } from '../llm/types.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8')

function pngDataUrl(): string {
  return `data:image/png;base64,${PNG.toString('base64')}`
}

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    filename: 'dot.png',
    mimeType: 'image/png',
    size: PNG.length,
    data: pngDataUrl(),
    ...over,
  }
}

describe('blob store', () => {
  let dir: string
  let store: FileBlobStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blobs-'))
    store = new FileBlobStore(dir)
    setBlobStore(store)
  })

  afterEach(() => {
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('dedups the same bytes under one SHA-256 hash', () => {
    const a = store.put(PNG, 'image/png')
    const b = store.put(Buffer.from(PNG), 'image/png')
    expect(a.hash).toBe(hashBytes(PNG))
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(store.get(a.hash).bytes.equals(PNG)).toBe(true)
  })

  it('stores png, jpeg and pdf and round-trips bytes', () => {
    const png = store.put(PNG, 'image/png')
    const jpeg = store.put(JPEG, 'image/jpeg')
    const pdf = store.put(PDF, 'application/pdf')
    expect(store.get(png.hash).mime).toBe('image/png')
    expect(store.get(jpeg.hash).bytes.equals(JPEG)).toBe(true)
    expect(store.get(pdf.hash).mime).toBe('application/pdf')
  })

  it('throws BlobMissingError and never hydrates a missing blob', () => {
    const hash = hashBytes(PNG)
    expect(() => store.get(hash)).toThrow(BlobMissingError)
    expect(() =>
      hydrateAttachmentData({
        id: 'x',
        filename: 'x.png',
        mimeType: 'image/png',
        size: PNG.length,
        blob: { hash, mime: 'image/png', size: PNG.length },
      }),
    ).toThrow(BlobMissingError)
  })

  it('recomputes the hash on read and refuses corrupt bytes', () => {
    const ref = store.put(PNG, 'image/png')
    store.corruptForTest(ref.hash)
    expect(() => store.get(ref.hash)).toThrow(BlobCorruptError)
  })
})

describe('event persistence keeps only blob refs', () => {
  let db: Database.Database
  let events: EventStore
  let blobs: MemoryBlobStore

  beforeEach(() => {
    db = new Database(':memory:')
    blobs = new MemoryBlobStore()
    events = new EventStore(db, { blobStore: blobs })
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)`)
    db.exec(`INSERT INTO sessions (id) VALUES ('s1')`)
  })

  afterEach(() => {
    setBlobStore(null)
    db.close()
  })

  it('writes attachments and base64Data as {hash,mime,size} without inline data URLs', () => {
    const stored = events.append('s1', {
      type: 'message.start',
      data: {
        messageId: 'm1',
        role: 'user',
        content: 'see',
        attachments: [attachment()],
      },
    })
    const payload = db.prepare(`SELECT payload FROM events WHERE session_id='s1'`).get() as { payload: string }
    expect(payload.payload).not.toContain('data:image')
    expect(payload.payload).not.toContain('base64Data')
    const att = (stored.data as { attachments: Attachment[] }).attachments[0]!
    expect(att.data).toBeUndefined()
    expect(att.blob?.hash).toBe(hashBytes(PNG))
    expect(att.blob?.mime).toBe('image/png')
    expect(att.blob?.size).toBe(PNG.length)
    expect(blobs.get(att.blob!.hash).bytes.equals(PNG)).toBe(true)
  })

  it('extracts tool result metadata.base64Data', () => {
    events.append('s1', {
      type: 'turn.snapshot',
      data: {
        mode: 'builder',
        phase: 'build',
        isRunning: false,
        messages: [
          {
            id: 'm',
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [
              {
                id: 't1',
                name: 'read',
                arguments: {},
                result: {
                  output: 'ok',
                  success: true,
                  durationMs: 1,
                  truncated: false,
                  metadata: { mimeType: 'image/png', base64Data: PNG.toString('base64') },
                },
              },
            ],
          },
        ],
        currentContextWindowId: 'win-1',
        criteria: [],
        todos: [],
        metadataEntries: {},
        contextState: {
          currentTokens: 0,
          maxTokens: 1,
          compactionCount: 0,
          dangerZone: false,
          canCompact: false,
          dynamicContextChanged: false,
        },
        snapshotSeq: 1,
        snapshotAt: Date.now(),
      },
    })
    const payload = db.prepare(`SELECT payload FROM events WHERE event_type='turn.snapshot'`).get() as {
      payload: string
    }
    expect(payload.payload).not.toContain('base64Data')
    expect(payload.payload).not.toContain('data:image')
    expect(payload.payload).toContain(hashBytes(PNG))
  })
})

describe('LLM rehydration', () => {
  let blobs: MemoryBlobStore

  beforeEach(() => {
    blobs = new MemoryBlobStore()
    setBlobStore(blobs)
  })

  afterEach(() => {
    setBlobStore(null)
  })

  async function chatAndResponses(att: Attachment) {
    const messages: LLMMessage[] = [{ role: 'user', content: 'What is this?', attachments: [att] }]
    const chat = await convertMessages(messages, true)
    const content = chat[0]?.content as Array<{ type: string; image_url?: { url: string } }>
    const image = content.find((part) => part.type === 'image_url')
    expect(image?.image_url?.url).toBeDefined()
    const bytes = decodeDataUrl(image!.image_url!.url)
    expect(bytes?.equals(PNG)).toBe(true)
    const responses = buildResponsesRequest({
      model: 'gpt-test',
      messages: chat,
    })
    const input = JSON.stringify(responses.input)
    expect(input).toContain('input_image')
    const match = input.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
    expect(match?.[1]).toBeDefined()
    expect(Buffer.from(match![1]!, 'base64').equals(PNG)).toBe(true)
  }

  it('rehydrates Chat and Responses image bytes from a blob ref', async () => {
    const ref = blobs.put(PNG, 'image/png')
    await chatAndResponses({
      id: 'a',
      filename: 'dot.png',
      mimeType: 'image/png',
      size: PNG.length,
      blob: ref,
    })
  })

  it('throws an explicit error when the blob is missing', async () => {
    await expect(
      convertMessages(
        [
          {
            role: 'user',
            content: 'x',
            attachments: [
              {
                id: 'a',
                filename: 'dot.png',
                mimeType: 'image/png',
                size: 1,
                blob: { hash: hashBytes(PNG), mime: 'image/png', size: 1 },
              },
            ],
          },
        ],
        true,
      ),
    ).rejects.toBeInstanceOf(BlobMissingError)
  })
})

describe('C1 SIGKILL after durable blob write', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openfox-blob-sigkill-c1-'))
  })

  afterEach(() => {
    setBlobStore(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('SIGKILL after blob write leaves no event reference, then resume stores one resolvable blob', async () => {
    const dbPath = join(dir, 'sessions.db')
    seedCrashDatabase(dbPath, 's1', false)
    const marker = join(dir, 'barrier')
    await killAtBarrier(
      {
        OPENFOX_DB_PATH: dbPath,
        OPENFOX_BLOB_CRASH_MODE: 'append',
        OPENFOX_BLOB_SESSION: 's1',
      },
      'after-blob-write',
      marker,
    )
    const { db, events, blobs } = reopenCrashStore(dbPath)
    try {
      const payloads = eventPayloads(db, 's1')
      expect(payloads).toEqual([])
      expect(payloads.join('')).not.toContain(CRASH_HASH)
      expect(blobs.has(CRASH_HASH)).toBe(true)
      assertResolvablePng(blobs)

      const stored = events.append('s1', {
        type: 'message.start',
        data: {
          messageId: 'm1',
          role: 'user',
          content: 'see',
          attachments: [
            { id: 'a', filename: 'dot.png', mimeType: 'image/png', size: CRASH_PNG.length, data: CRASH_PNG_URL },
          ],
        },
      })
      const after = eventPayloads(db, 's1')
      expect(after).toHaveLength(1)
      expect(after[0]).not.toContain('data:image')
      expect(after[0]).toContain(CRASH_HASH)
      const att = (stored.data as { attachments: Array<{ blob?: { hash: string; mime: string; size: number } }> })
        .attachments[0]
      expect(att?.blob).toEqual({ hash: CRASH_HASH, mime: 'image/png', size: CRASH_PNG.length })
      assertResolvablePng(blobs)
    } finally {
      db.close()
    }
  }, 20_000)
})
