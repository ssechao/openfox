#!/usr/bin/env node
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const DATA_URL_PREFIX = 'data:image/png;base64,'

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
  const buf = Buffer.allocUnsafe(size)
  const seed = Math.floor(rng() * 0xffffffff) >>> 0
  buf.fill(0)
  for (let i = 0; i + 4 <= size; i += 4) buf.writeUInt32LE((seed + i) >>> 0, i)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  return buf
}

function dataUrlFrom(bytes) {
  return `${DATA_URL_PREFIX}${bytes.toString('base64')}`
}

function rawForEncodedLength(target) {
  return Math.max(32, Math.floor(((target - DATA_URL_PREFIX.length) * 3) / 4))
}

function toolImage(id, bytes) {
  return {
    id,
    name: 'read',
    arguments: { path: `${id}.png` },
    result: {
      output: 'ok',
      metadata: { mimeType: 'image/png', base64Data: bytes.toString('base64') },
    },
  }
}

export function generateCorpus(dbPath, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const rng = mulberry32(manifest.seed)
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
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
  const workdir = options.workdir || '/tmp/openfox-4a1-corpus-workdir'
  db.prepare('INSERT INTO projects (id, name, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    projectId,
    'corpus',
    workdir,
    now,
    now,
  )
  db.prepare(
    `INSERT INTO sessions (id, project_id, workdir, phase, created_at, updated_at, title, mode, is_running, workflow_phase, message_count, recent_user_prompts)
     VALUES (?, ?, ?, 'idle', ?, ?, 'synthetic heavy', 'builder', 0, 'build', ?, '[]')`,
  ).run(sessionId, projectId, workdir, now, now, manifest.messageCount)
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'display.maxVisibleItems',
    String(manifest.maxVisibleItems),
    now,
  )

  const messages = []
  for (let i = 0; i < manifest.messageCount; i++) {
    messages.push({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0 ? `synthetic prompt ${i}` : `synthetic reply ${i}`,
      timestamp: now,
    })
  }

  const last = messages.slice(-manifest.maxVisibleItems)
  const last50Target = manifest.last50BinaryBytes
  const totalBinaryTarget = Math.round(manifest.targetSnapshotBytes * manifest.binaryFraction)
  const attachmentBudget = Math.floor(last50Target * 0.12)
  const perAttachment = Math.floor(attachmentBudget / 2)
  const pngA = seededBytes(rng, rawForEncodedLength(perAttachment))
  const pngB = PNG_1X1
  last[last.length - 2].attachments = [
    {
      id: 'att-a',
      filename: 'shot-a.png',
      mimeType: 'image/png',
      size: pngA.length,
      data: dataUrlFrom(pngA),
    },
  ]
  last[last.length - 1].attachments = [
    {
      id: 'att-b',
      filename: 'shot-b.png',
      mimeType: 'image/png',
      size: pngB.length,
      data: dataUrlFrom(pngB),
    },
  ]
  const roundTripHash = createHash('sha256').update(pngB).digest('hex')
  const lastToolBudget = last50Target - dataUrlFrom(pngA).length - dataUrlFrom(pngB).length
  const perLastTool = Math.floor(lastToolBudget / manifest.base64ImagesInLast50)
  for (let i = 0; i < manifest.base64ImagesInLast50; i++) {
    const msg = last[i]
    msg.role = 'assistant'
    msg.toolCalls = [toolImage(`last-${i}`, seededBytes(rng, rawForEncodedLength(perLastTool)))]
  }

  const earlierBudget = totalBinaryTarget - last50Target
  const earlierCount = 80
  const perEarlier = Math.floor(earlierBudget / earlierCount)
  for (let i = 0; i < earlierCount; i++) {
    const msg = messages[100 + i * 40]
    if (!msg || msg.attachments || msg.toolCalls) continue
    msg.role = 'assistant'
    msg.toolCalls = [toolImage(`early-${i}`, seededBytes(rng, rawForEncodedLength(perEarlier)))]
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
    sessionInit: { projectId, workdir, contextWindowId: 'win-1' },
  }

  let payload = JSON.stringify(snapshot)
  const missing = manifest.targetSnapshotBytes - payload.length
  if (missing > 100) {
    snapshot.messages[0].thinkingContent = 't'.repeat(missing)
    payload = JSON.stringify(snapshot)
  }

  db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 1, ?, 'session.initialized', ?)`,
  ).run(sessionId, Date.parse(now), JSON.stringify({ projectId, workdir, contextWindowId: 'win-1' }))
  db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, 2, ?, 'turn.snapshot', ?)`,
  ).run(sessionId, Date.parse(now), payload)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  const freelist = db.pragma('freelist_count', { simple: true })
  db.close()
  return {
    dbPath,
    sessionId,
    snapshotBytes: payload.length,
    roundTripHash,
    roundTripMime: 'image/png',
    roundTripBytes: pngB.length,
    freelist,
    manifest,
  }
}

/** ~100 sessions / ~12 000 events for lot 4b search demo. Reuses this generator's schema and seed. */
export function generateSearchCorpus(dbPath, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const rng = mulberry32(manifest.seed)
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
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
  const ts = Date.parse(now)
  const workdir = options.workdir || '/tmp/openfox-4b-search-corpus'
  const sessionCount = options.sessionCount || 100
  const postPairs = options.postPairs ?? 59
  db.prepare('INSERT INTO projects (id, name, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'search-project',
    'search-corpus',
    workdir,
    now,
    now,
  )
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'display.maxVisibleItems',
    String(manifest.maxVisibleItems),
    now,
  )

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, project_id, workdir, phase, created_at, updated_at, title, mode, is_running, workflow_phase, message_count, recent_user_prompts)
     VALUES (?, 'search-project', ?, 'idle', ?, ?, ?, 'builder', 0, 'build', ?, ?)`,
  )
  const insertEvent = db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)`,
  )

  const fixtures = {
    xylophoneSessionId: 'search-s0',
    ancientSessionId: 'search-s1',
    cafeSessionId: 'search-s2',
    prefixSessionId: 'search-s3',
    multiSessionId: 'search-s4',
  }

  const insertMany = db.transaction(() => {
    for (let i = 0; i < sessionCount; i++) {
      const sessionId = `search-s${i}`
      let title = `synthetic session ${i}`
      if (i === 0) title = 'xylophone-alpha session'
      if (i === 3) title = 'prefixable-term session'
      if (i === 4) title = 'alpha bravo session'
      const snapshotMessages = []
      const recent = []
      for (let m = 0; m < 20; m++) {
        const id = `${sessionId}-old-${m}`
        let content = `synthetic prompt ${i} ${m}`
        if (i === 1 && m === 0) content = 'ancient-prompt-omega hidden in snapshot'
        if (i === 2 && m === 0) content = 'un café crème for accents'
        snapshotMessages.push({
          id,
          role: 'user',
          content,
          timestamp: now,
        })
        snapshotMessages.push({
          id: `${sessionId}-old-a-${m}`,
          role: 'assistant',
          content: `synthetic reply ${i} ${m}`,
          timestamp: now,
        })
        if (m < 10) recent.push({ id, content, timestamp: now })
      }
      insertSession.run(sessionId, workdir, now, now, title, 20 + postPairs, JSON.stringify(recent))
      insertEvent.run(
        sessionId,
        1,
        ts,
        'session.initialized',
        JSON.stringify({ projectId: 'search-project', workdir, contextWindowId: 'win-1', title }),
      )
      const snap = {
        mode: 'builder',
        phase: 'build',
        isRunning: false,
        messages: snapshotMessages,
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
        snapshotAt: ts,
        sessionInit: { projectId: 'search-project', workdir, contextWindowId: 'win-1' },
        sessionTitle: title,
      }
      insertEvent.run(sessionId, 2, ts, 'turn.snapshot', JSON.stringify(snap))
      let seq = 3
      for (let p = 0; p < postPairs; p++) {
        const id = `${sessionId}-new-${p}`
        let content = `live prompt ${i} ${p} ${rng().toFixed(4)}`
        if (i === 4 && p === 0) content = 'alpha bravo charlie live'
        if (i === 0 && p === 0) content = 'hello, world! punctuation'
        insertEvent.run(
          sessionId,
          seq++,
          ts + p,
          'message.start',
          JSON.stringify({ messageId: id, role: 'user', content }),
        )
        insertEvent.run(sessionId, seq++, ts + p, 'message.done', JSON.stringify({ messageId: id }))
      }
    }
  })
  insertMany()
  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  const sessionRows = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  return { dbPath, sessionCount: sessionRows, eventCount, fixtures, manifest }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  const out = process.argv[2]
  if (out) {
    const mode = process.argv[3]
    const info = mode === 'search' ? generateSearchCorpus(out) : generateCorpus(out)
    process.stdout.write(JSON.stringify(info, null, 2) + '\n')
  }
}
