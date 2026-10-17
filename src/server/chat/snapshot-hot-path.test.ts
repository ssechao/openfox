import Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import { EventStore, getEventStore } from '../events/store.js'
import { getCurrentContextWindowId } from '../events/session.js'
import { getSessionMessageCount } from '../utils/session-utils.js'
import { getConversationMessages, processEventsForConversation } from './conversation-history.js'
import type { LLMClientWithModel } from '../llm/client.js'

vi.mock('../events/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/store.js')>()),
  getEventStore: vi.fn(),
}))
vi.mock('../context/image-processor.js', () => ({
  loadResolvedVisionModel: async () => null,
  processContextImages: async (events: unknown) => ({ events }),
}))
const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.clearAllMocks()
})
test('the actual conversation and window/count accessors use the shared reader and projections', async () => {
  const db = new Database(':memory:')
  databases.push(db)
  const store = new EventStore(db, { diagnostics: true, hotPath: true })
  vi.mocked(getEventStore).mockReturnValue(store)
  store.append('s', { type: 'session.initialized', data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w' } })
  store.append('s', {
    type: 'message.start',
    data: { messageId: 'u', role: 'user', content: 'HELLO', contextWindowId: 'w' },
  })
  getCurrentContextWindowId('s')
  getSessionMessageCount('s')
  store.resetDiagnostics()
  expect(getCurrentContextWindowId('s')).toBe('w')
  expect(getSessionMessageCount('s')).toBe(1)
  expect(getConversationMessages({ type: 'toplevel', sessionId: 's' })[0]?.content).toBe('HELLO')
  const client = { getModel: () => 'gpt-4o' } as LLMClientWithModel
  await processEventsForConversation('s', client, () => {})
  expect(store.getDiagnostics()?.fullReads).toBe(0)
})
