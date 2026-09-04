import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { EventStore } from './store.js'
import type { SessionSnapshot } from './types.js'

describe('event storage maintenance', () => {
  it('backs up, verifies, prunes covered stream fragments and vacuums', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-event-maintenance-'))
    const path = join(directory, 'sessions.db')
    const db = new Database(path)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        recent_user_prompts TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      );
      INSERT INTO sessions (id, recent_user_prompts) VALUES (
        'session-1',
        '[{"id":"user-1","content":"Prompt","timestamp":"2026-09-04T20:00:00.000Z"}]'
      );
    `)
    const store = new EventStore(db)
    const snapshot: SessionSnapshot = {
      mode: 'planner',
      phase: 'plan',
      isRunning: false,
      messages: [{ id: 'assistant-1', role: 'assistant', content: 'complete', timestamp: 1000 }],
      criteria: [],
      metadataEntries: {},
      contextState: {
        currentTokens: 0,
        maxTokens: 200000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      },
      currentContextWindowId: 'window-1',
      todos: [],
      readFiles: [],
      snapshotSeq: 3,
      snapshotAt: 1000,
    }

    store.append('session-1', { type: 'message.start', data: { messageId: 'assistant-1', role: 'assistant' } })
    store.append('session-1', { type: 'message.delta', data: { messageId: 'assistant-1', content: 'complete' } })
    store.append('session-1', { type: 'message.thinking', data: { messageId: 'assistant-1', content: 'thought' } })
    store.append('session-1', { type: 'turn.snapshot', data: snapshot })
    store.append('session-1', { type: 'message.delta', data: { messageId: 'assistant-2', content: 'in flight' } })

    const report = await store.migrateTransientEvents()

    expect(report.skipped).toBe(false)
    expect(report.deletedEvents).toBe(2)
    expect(report.integrity).toBe('ok')
    expect(report.vacuumed).toBe(true)
    expect(existsSync(report.backupPath!)).toBe(true)
    expect(store.getEvents('session-1').map((event) => event.type)).toEqual([
      'message.start',
      'turn.snapshot',
      'message.delta',
    ])

    const backup = new Database(report.backupPath!, { readonly: true })
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(
      (
        backup
          .prepare(`SELECT COUNT(*) count FROM events WHERE event_type IN ('message.delta', 'message.thinking')`)
          .get() as {
          count: number
        }
      ).count,
    ).toBe(3)
    backup.close()

    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
})
