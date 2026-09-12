import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { getEventStore, initEventStore } from './store.js'
import { getContextMessages, getSessionState, truncateSessionMessagesBefore } from './session.js'
import type { SessionSnapshot, SnapshotMessage } from './types.js'

let db: Database.Database

function message(
  id: string,
  role: SnapshotMessage['role'],
  content: string,
  contextWindowId: string,
  extra: Partial<SnapshotMessage> = {},
): SnapshotMessage {
  return { id, role, content, contextWindowId, timestamp: Date.now(), ...extra }
}

function snapshot(
  messages: SnapshotMessage[],
  currentContextWindowId: string,
  contextWindows: NonNullable<SessionSnapshot['contextWindows']> = [],
): SessionSnapshot {
  return {
    mode: 'planner',
    phase: 'plan',
    isRunning: false,
    messages,
    criteria: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 9999,
      maxTokens: 200_000,
      compactionCount: contextWindows.length,
      dangerZone: true,
      canCompact: true,
      dynamicContextChanged: false,
    },
    currentContextWindowId,
    todos: [],
    readFiles: [{ path: '/future.ts', tokenCount: 100 }],
    snapshotSeq: 1,
    snapshotAt: Date.now(),
    sessionInit: { projectId: 'project', workdir: '/tmp', contextWindowId: 'window-1' },
    ...(contextWindows.length > 0 ? { contextWindows } : {}),
  }
}

function storeSnapshot(sessionId: string, value: SessionSnapshot): void {
  const store = getEventStore()
  store.append(sessionId, {
    type: 'session.initialized',
    data: { projectId: 'project', workdir: '/tmp', contextWindowId: 'window-1' },
  })
  store.append(sessionId, { type: 'turn.snapshot', data: value })
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, recent_user_prompts TEXT)')
  initEventStore(db)
})

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  db.close()
})

describe('truncateSessionMessagesBefore', () => {
  it('restores the target window and clears context state from the abandoned future', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1', 'window-1'),
          message('a1', 'assistant', 'A1', 'window-1'),
          message('u2', 'user', 'U2', 'window-1'),
          message('a2', 'assistant', 'A2', 'window-1'),
          message('c1', 'assistant', 'C1', 'window-2', { isCompactionSummary: true }),
          message('u3', 'user', 'U3', 'window-2'),
        ],
        'window-2',
        [
          {
            closedWindowId: 'window-1',
            newWindowId: 'window-2',
            beforeTokens: 5000,
            afterTokens: 500,
            summary: 'C1',
            timestamp: Date.now(),
          },
        ],
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u2')).toEqual({ success: true, removed: 4 })
    const state = getSessionState('session-1')!
    expect(state.currentContextWindowId).toBe('window-1')
    expect(state.messages.map((item) => item.content)).toEqual(['U1', 'A1'])
    expect(state.contextState).toMatchObject({
      currentTokens: 0,
      currentTokensKnown: false,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
    })
    expect(state.readFiles).toEqual([])
    expect(getContextMessages('session-1').map((item) => item.content)).toEqual(['U1', 'A1'])
  })

  it('restores a provider measurement from the last kept assistant response for the active model', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1', 'window-1'),
          message('a1', 'assistant', 'A1', 'window-1', {
            stats: {
              providerId: 'provider',
              providerName: 'Provider',
              backend: 'openai',
              model: 'model-a',
              mode: 'planner',
              totalTime: 1,
              toolTime: 0,
              prefillTokens: 185_000,
              prefillSpeed: 1,
              generationTokens: 4_000,
              generationSpeed: 1,
              llmCalls: [
                {
                  providerId: 'provider',
                  providerName: 'Provider',
                  backend: 'openai',
                  model: 'model-a',
                  callIndex: 1,
                  promptTokens: 185_000,
                  completionTokens: 4_000,
                  ttft: 0,
                  completionTime: 0,
                  prefillSpeed: 1,
                  generationSpeed: 1,
                  totalTime: 0,
                },
              ],
            },
          }),
          message('u2', 'user', 'U2', 'window-1'),
        ],
        'window-1',
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u2', 'model-a').success).toBe(true)
    expect(getSessionState('session-1')!.contextState).toMatchObject({
      currentTokens: 189_000,
      currentTokensKnown: true,
      canCompact: true,
      dangerZone: true,
    })
  })

  it('marks usage unknown when the retained measurement belongs to another model', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1', 'window-1'),
          message('a1', 'assistant', 'A1', 'window-1', {
            stats: {
              providerId: 'provider',
              providerName: 'Provider',
              backend: 'openai',
              model: 'old-model',
              mode: 'planner',
              totalTime: 1,
              toolTime: 0,
              prefillTokens: 185_000,
              prefillSpeed: 1,
              generationTokens: 4_000,
              generationSpeed: 1,
              llmCalls: [],
            },
          }),
          message('u2', 'user', 'U2', 'window-1'),
        ],
        'window-1',
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u2', 'new-model').success).toBe(true)
    expect(getSessionState('session-1')!.contextState).toMatchObject({
      currentTokens: 0,
      currentTokensKnown: false,
      canCompact: false,
      dangerZone: false,
    })
  })

  it('keeps the useful earlier summary when the target lies between two compactions', () => {
    const c1 = {
      closedWindowId: 'window-1',
      newWindowId: 'window-2',
      beforeTokens: 5000,
      afterTokens: 500,
      summary: 'C1',
      timestamp: Date.now(),
    }
    const c2 = {
      closedWindowId: 'window-2',
      newWindowId: 'window-3',
      beforeTokens: 6000,
      afterTokens: 600,
      summary: 'C2',
      timestamp: Date.now() + 1,
    }
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1_RAW', 'window-1'),
          message('a1', 'assistant', 'A1_RAW', 'window-1'),
          message('c1', 'assistant', 'C1', 'window-2', { isCompactionSummary: true }),
          message('u3', 'user', 'U3', 'window-2'),
          message('a3', 'assistant', 'A3', 'window-2'),
          message('c2', 'assistant', 'C2', 'window-3', { isCompactionSummary: true }),
          message('u4', 'user', 'U4', 'window-3'),
        ],
        'window-3',
        [c1, c2],
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u3').success).toBe(true)
    const state = getSessionState('session-1')!
    expect(state.currentContextWindowId).toBe('window-2')
    expect(state.contextState.compactionCount).toBe(1)
    expect(state.contextWindows).toEqual([c1])
    expect(getContextMessages('session-1').map((item) => item.content)).toEqual(['C1'])
  })

  it('preserves a current-window prefix without a compaction', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1', 'window-1'),
          message('a1', 'assistant', 'A1', 'window-1'),
          message('u2', 'user', 'U2', 'window-1'),
        ],
        'window-1',
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u2').success).toBe(true)
    expect(getContextMessages('session-1').map((item) => item.content)).toEqual(['U1', 'A1'])
  })

  it('keeps the relevant prefix when the target is already in the current compacted window', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1_RAW', 'window-1'),
          message('a1', 'assistant', 'A1_RAW', 'window-1'),
          message('c1', 'assistant', 'C1', 'window-2', { isCompactionSummary: true }),
          message('u3', 'user', 'U3', 'window-2'),
          message('a3', 'assistant', 'A3', 'window-2'),
          message('u4', 'user', 'U4', 'window-2'),
        ],
        'window-2',
        [
          {
            closedWindowId: 'window-1',
            newWindowId: 'window-2',
            beforeTokens: 5000,
            afterTokens: 500,
            summary: 'C1',
            timestamp: Date.now(),
          },
        ],
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u4').success).toBe(true)
    expect(getContextMessages('session-1').map((item) => item.content)).toEqual(['C1', 'U3', 'A3'])
  })

  it('persists the restored window and leaves another session untouched after store reinitialization', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'U1', 'window-1'),
          message('a1', 'assistant', 'A1', 'window-1'),
          message('u2', 'user', 'U2', 'window-1'),
          message('c1', 'assistant', 'C1', 'window-2', { isCompactionSummary: true }),
        ],
        'window-2',
      ),
    )
    storeSnapshot(
      'session-2',
      snapshot(
        [message('other-u', 'user', 'OTHER_U', 'window-1'), message('other-a', 'assistant', 'OTHER_A', 'window-1')],
        'window-1',
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u2').success).toBe(true)
    initEventStore(db)
    expect(getSessionState('session-1')!.currentContextWindowId).toBe('window-1')
    expect(getContextMessages('session-1').map((item) => item.content)).toEqual(['U1', 'A1'])
    expect(getContextMessages('session-2').map((item) => item.content)).toEqual(['OTHER_U', 'OTHER_A'])
  })

  it('preserves attachments and complete tool exchanges before the replay target', () => {
    storeSnapshot(
      'session-1',
      snapshot(
        [
          message('u1', 'user', 'Inspect image', 'window-1', {
            attachments: [
              { id: 'img', filename: 'image.png', mimeType: 'image/png', size: 10, data: 'data:image/png;base64,AA==' },
            ],
          }),
          message('a1', 'assistant', 'Done', 'window-1', {
            toolCalls: [
              {
                id: 'call-1',
                name: 'read_file',
                arguments: { path: 'image.png' },
                result: { success: true, output: 'image result', durationMs: 1, truncated: false },
              },
            ],
          }),
          message('u2', 'user', 'Replay me', 'window-1'),
        ],
        'window-1',
      ),
    )

    expect(truncateSessionMessagesBefore('session-1', 'u2').success).toBe(true)
    const context = getContextMessages('session-1')
    expect(context[0]?.attachments?.[0]?.filename).toBe('image.png')
    expect(context[1]?.toolCalls?.[0]).toMatchObject({ id: 'call-1', name: 'read_file' })
    expect(context[2]).toMatchObject({ role: 'tool', toolCallId: 'call-1', content: 'image result' })
  })

  it('fails explicitly when the target is unavailable', () => {
    storeSnapshot('session-1', snapshot([message('u1', 'user', 'U1', 'window-1')], 'window-1'))
    expect(truncateSessionMessagesBefore('session-1', 'missing')).toEqual({
      success: false,
      error: 'Replay target is outside the available history',
    })
  })
})
