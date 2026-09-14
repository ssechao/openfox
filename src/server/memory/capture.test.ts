import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockResolveSettings = vi.fn()
vi.mock('./settings.js', () => ({ resolveSharedMemorySettings: mockResolveSettings }))

const mockIsAvailable = vi.fn(() => true)
const mockCallSharedMemory = vi.fn()
vi.mock('./shared-memory-client.js', () => ({
  isSharedMemoryAvailable: mockIsAvailable,
  callSharedMemory: mockCallSharedMemory,
}))

interface FakeOutboxItem {
  id: string
  collection: string
  payload: Record<string, unknown>
  tags: string[]
  identifiers: string[]
}

const mockEnqueue = vi.fn()
const mockFindByDedup = vi.fn()
const mockListPending = vi.fn<(...args: unknown[]) => FakeOutboxItem[]>(() => [])
const mockMarkSent = vi.fn()
const mockMarkFailed = vi.fn()
vi.mock('../db/shared-memory-outbox.js', () => ({
  enqueueOutboxItem: mockEnqueue,
  findOutboxItemByDedupKey: mockFindByDedup,
  listPendingOutboxItems: mockListPending,
  markOutboxItemSent: mockMarkSent,
  markOutboxItemAttemptFailed: mockMarkFailed,
}))

const factCandidate = {
  collection: 'ops',
  payload: { type: 'fact', subject: 'host X', facts: [{ key: 'role', value: 'web' }] },
}

describe('runPostTurnMemoryCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAvailable.mockReturnValue(true)
    mockListPending.mockReturnValue([])
    mockFindByDedup.mockReturnValue(null)
    mockEnqueue.mockImplementation((item: any) => ({ ...item, id: 'item-1', status: 'pending', attempts: 0 }))
    mockCallSharedMemory.mockResolvedValue({ success: true, data: { proposalId: 'p1' } })
  })

  it('does nothing when the feature is disabled', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: false,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const extractor = vi.fn(async () => [factCandidate])
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, extractor)
    expect(extractor).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('does nothing when capture is disabled even if the feature is enabled', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: false,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const extractor = vi.fn(async () => [factCandidate])
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, extractor)
    expect(extractor).not.toHaveBeenCalled()
  })

  it('does nothing when shared memory is unavailable', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    mockIsAvailable.mockReturnValue(false)
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const extractor = vi.fn(async () => [factCandidate])
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, extractor)
    expect(extractor).not.toHaveBeenCalled()
  })

  it('enqueues a candidate into the outbox BEFORE calling propose, and marks it sent on success', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: ['default-col'],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const extractor = vi.fn(async () => [factCandidate])
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, extractor)

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', collection: 'ops', payload: factCandidate.payload }),
    )
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]!
    const callOrder = mockCallSharedMemory.mock.invocationCallOrder[0]!
    expect(enqueueOrder).toBeLessThan(callOrder)
    expect(mockMarkSent).toHaveBeenCalledWith('item-1')
  })

  it('falls back to the settings default collection when the candidate has none', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: ['default-col'],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const noCollection = { payload: factCandidate.payload }
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, async () => [noCollection])
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ collection: 'default-col' }))
  })

  it('skips a candidate with no collection at all (neither its own nor a default)', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const noCollection = { payload: factCandidate.payload }
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, async () => [noCollection])
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('deduplicates: does not re-enqueue a candidate already queued for this session', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    mockFindByDedup.mockReturnValue({ id: 'existing', status: 'pending' })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, async () => [factCandidate])
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('marks the item failed (not thrown) when the propose call fails, leaving it pending for retry', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    mockCallSharedMemory.mockResolvedValue({ success: false, error: 'rate_limited' })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    await expect(
      runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, async () => [factCandidate]),
    ).resolves.toBeUndefined()
    expect(mockMarkFailed).toHaveBeenCalledWith('item-1', 'rate_limited')
    expect(mockMarkSent).not.toHaveBeenCalled()
  })

  it('retries pending outbox items from earlier turns before extracting new ones', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    mockListPending.mockReturnValue([{ id: 'old-1', collection: 'ops', payload: {}, tags: [], identifiers: [] }])
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const extractor = vi.fn(async () => [])
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, extractor)
    expect(mockMarkSent).toHaveBeenCalledWith('old-1')
  })

  it('caps extraction at MAX_CANDIDATES_PER_TURN even if the extractor returns more', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: ['ops'],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    const many = Array.from({ length: 10 }, (_, i) => ({
      payload: { type: 'fact', subject: `s${i}`, facts: [{ key: 'k', value: 'v' }] },
    }))
    await runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, async () => many)
    expect(mockEnqueue).toHaveBeenCalledTimes(3)
  })

  it('never throws when the extractor itself throws', async () => {
    mockResolveSettings.mockReturnValue({
      enabled: true,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
    const { runPostTurnMemoryCapture } = await import('./capture.js')
    await expect(
      runPostTurnMemoryCapture({ projectId: 'p1', sessionId: 's1' }, async () => {
        throw new Error('boom')
      }),
    ).resolves.toBeUndefined()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})
