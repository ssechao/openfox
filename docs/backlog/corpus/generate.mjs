#!/usr/bin/env node
import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededBytes(rng, size) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  return buf
}

export function generateCorpus(dbPath, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const rng = mulberry32(manifest.seed)
  const db = new Database(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workdir TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workdir TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT,
      mode TEXT NOT NULL DEFAULT 'builder',
      is_running INTEGER NOT NULL DEFAULT 0,
      workflow_phase TEXT NOT NULL DEFAULT 'build',
      message_count INTEGER NOT NULL DEFAULT 0,
      recent_user_prompts TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
  `)
  const now = '2026-10-22T00:00:00.000Z'
  const projectId = '4a1-project'
  const sessionId = manifest.sessionId
  db.prepare('INSERT INTO projects (id, name, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    projectId,
    'corpus',
    options.workdir || '/tmp/openfox-4a1-corpus-workdir',
    now,
    now,
  )
  db.prepare(
    `INSERT INTO sessions (id, project_id, workdir, phase, created_at, updated_at, title, mode, is_running, workflow_phase, message_count, recent_user_prompts)
     VALUES (?, ?, ?, 'idle', ?, ?, 'synthetic heavy', 'builder', 0, 'build', ?, '[]')`,
  ).run(sessionId, projectId, options.workdir || '/tmp/openfox-4a1-corpus-workdir', now, now, manifest.messageCount)
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'display.maxVisibleItems',
    String(manifest.maxVisibleItems),
    now,
  )

  const messages = []
  for (let i = 0; i < manifest.messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const msg = {
      id: `m${i}`,
      role,
      content: role === 'user' ? `synthetic prompt ${i}` : `synthetic reply ${i}`,
      timestamp: now,
    }
    if (i < 8) {
      msg.thinkingContent = 't'.repeat(20_000)
    }
    messages.push(msg)
  }

  const last = messages.slice(-manifest.maxVisibleItems)
  const pngA = seededBytes(rng, manifest.pngBytesEach)
  const pngB = PNG_1X1
  last[last.length - 2].attachments = [
    {
      id: 'att-a',
      filename: 'shot-a.png',
      mimeType: 'image/png',
      size: pngA.length,
      data: `data:image/png;base64,${pngA.toString('base64')}`,
    },
  ]
  last[last.length - 1].attachments = [
    {
      id: 'att-b',
      filename: 'shot-b.png',
      mimeType: 'image/png',
      size: pngB.length,
      data: `data:image/png;base64,${pngB.toString('base64')}`,
    },
  ]
  const imageHash = createHash('sha256').update(pngB).digest('hex')
  for (let i = 0; i < manifest.base64ImagesInLast50; i++) {
    const bytes = seededBytes(rng, Math.floor(manifest.pngBytesEach / 2))
    const msg = last[i]
    msg.role = 'assistant'
    msg.toolCalls = [
      {
        id: `tc${i}`,
        name: 'read',
        arguments: { path: `shot-${i}.png` },
        result: {
          output: 'ok',
          metadata: { mimeType: 'image/png', base64Data: bytes.toString('base64') },
        },
      },
    ]
  }

  const snapshot = {
    mode: 'builder',
    phase: 'build',
    isRunning: false,
    messages,
    criteria: [],
    todos: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId: 'win-1',
    snapshotSeq: 1,
    snapshotAt: Date.parse(now),
    sessionInit: { projectId, workdir: options.workdir || '/tmp/openfox-4a1-corpus-workdir', contextWindowId: 'win-1' },
  }
  const payload = JSON.stringify(snapshot)
  db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'session.initialized', ?)`,
  ).run(
    sessionId,
    Date.parse(now),
    JSON.stringify({ projectId, workdir: snapshot.sessionInit.workdir, contextWindowId: 'win-1' }),
  )
  db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 2, ?, 'turn.snapshot', ?)`,
  ).run(sessionId, Date.parse(now), payload)
  db.close()
  return {
    dbPath,
    sessionId,
    snapshotBytes: payload.length,
    roundTripHash: imageHash,
    roundTripMime: 'image/png',
    roundTripBytes: pngB.length,
    manifest,
  }
}

const out = process.argv[2]
if (out) {
  const info = generateCorpus(out)
  process.stdout.write(JSON.stringify(info, null, 2) + '\n')
}
