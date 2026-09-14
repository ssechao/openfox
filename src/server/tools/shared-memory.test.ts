import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToolContext, Tool } from './types.js'

interface MockSharedMemoryResult {
  success: boolean
  data?: unknown
  error?: string
}

const mockClient = {
  isSharedMemoryAvailable: vi.fn(() => true),
  callSharedMemory: vi.fn<(...args: unknown[]) => Promise<MockSharedMemoryResult>>(async () => ({
    success: true,
    data: { ok: true },
  })),
}

vi.mock('../memory/shared-memory-client.js', () => mockClient)

const baseContext: ToolContext = {
  workdir: '/test',
  sessionId: 'test-session',
  sessionManager: null as any,
}

describe('shared_memory tool', () => {
  let sharedMemoryTool: Tool

  beforeEach(async () => {
    vi.clearAllMocks()
    mockClient.isSharedMemoryAvailable.mockReturnValue(true)
    mockClient.callSharedMemory.mockResolvedValue({ success: true, data: { ok: true } })
    const mod = await import('./shared-memory.js')
    sharedMemoryTool = mod.sharedMemoryTool
  })

  it('has name shared_memory and requires an action', () => {
    expect(sharedMemoryTool.name).toBe('shared_memory')
    expect(sharedMemoryTool.definition.function.parameters['required']).toContain('action')
  })

  it('never exposes an approve action in its schema', () => {
    const props = sharedMemoryTool.definition.function.parameters['properties'] as Record<string, { enum?: string[] }>
    expect(props['action']?.enum).toEqual(['search', 'get', 'propose', 'feedback', 'collections'])
    expect(props['action']?.enum).not.toContain('approve')
  })

  it('frames results as a non-authoritative reference in the tool description', () => {
    const description = sharedMemoryTool.definition.function.description
    expect(description).toMatch(/stale reference/i)
    expect(description).toMatch(/never.*(instruction|blindly)/i)
  })

  it('rejects an unknown action before calling the client', async () => {
    const result = await sharedMemoryTool.execute({ action: 'approve' } as any, baseContext)
    expect(result.success).toBe(false)
    expect(mockClient.callSharedMemory).not.toHaveBeenCalled()
  })

  it('fails with a clear message when shared memory is unavailable', async () => {
    mockClient.isSharedMemoryAvailable.mockReturnValue(false)
    const result = await sharedMemoryTool.execute({ action: 'search', query: 'x' }, baseContext)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not available/i)
    expect(mockClient.callSharedMemory).not.toHaveBeenCalled()
  })

  it('forwards a search action with query/topK/collections', async () => {
    await sharedMemoryTool.execute({ action: 'search', query: 'deploy', topK: 3, collections: ['ops'] }, baseContext)
    expect(mockClient.callSharedMemory).toHaveBeenCalledWith('search', {
      query: 'deploy',
      topK: 3,
      collections: ['ops'],
    })
  })

  it('forwards a propose action with collection/payload/tags/identifiers', async () => {
    const payload = { type: 'fact', subject: 's', facts: [{ key: 'k', value: 'v' }] }
    await sharedMemoryTool.execute(
      { action: 'propose', collection: 'ops', payload, tags: ['a'], identifiers: ['host-x'] },
      baseContext,
    )
    expect(mockClient.callSharedMemory).toHaveBeenCalledWith('propose', {
      collection: 'ops',
      payload,
      tags: ['a'],
      identifiers: ['host-x'],
    })
  })

  it('forwards a feedback action', async () => {
    await sharedMemoryTool.execute({ action: 'feedback', entryId: 'e1', outcome: 'confirmed' }, baseContext)
    expect(mockClient.callSharedMemory).toHaveBeenCalledWith('feedback', { entryId: 'e1', outcome: 'confirmed' })
  })

  it('returns the underlying error when the client call fails', async () => {
    mockClient.callSharedMemory.mockResolvedValue({ success: false, error: 'boom' })
    const result = await sharedMemoryTool.execute({ action: 'get', id: 'e1' }, baseContext)
    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
  })

  it('returns the data as formatted JSON on success', async () => {
    const result = await sharedMemoryTool.execute({ action: 'collections' }, baseContext)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output as string)).toEqual({ ok: true })
  })
})
