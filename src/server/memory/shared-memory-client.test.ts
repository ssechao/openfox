import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setSharedMemoryMcpManager,
  isSharedMemoryAvailable,
  callSharedMemory,
  searchSharedMemoryBounded,
  clearSharedMemoryCache,
  getSharedMemoryHealth,
} from './shared-memory-client.js'
import type { McpManager } from '../mcp/manager.js'

function fakeManager(overrides: Partial<McpManager> = {}): McpManager {
  return {
    getServer: vi.fn(
      () => ({ name: 'llm-aether', status: 'connected', tools: [], estimatedTokens: 0, config: {} }) as any,
    ),
    callTool: vi.fn(async () => ({ success: true, output: '{}' })),
    ...overrides,
  } as unknown as McpManager
}

describe('isSharedMemoryAvailable', () => {
  beforeEach(() => {
    setSharedMemoryMcpManager(null)
    clearSharedMemoryCache()
  })

  it('is false when no manager was ever set', () => {
    expect(isSharedMemoryAvailable()).toBe(false)
  })

  it('is false when the llm-aether server is not connected', () => {
    setSharedMemoryMcpManager(
      fakeManager({
        getServer: vi.fn(
          () => ({ name: 'llm-aether', status: 'error', tools: [], estimatedTokens: 0, config: {} }) as any,
        ),
      }),
    )
    expect(isSharedMemoryAvailable()).toBe(false)
  })

  it('is true only when the llm-aether server is connected', () => {
    setSharedMemoryMcpManager(fakeManager())
    expect(isSharedMemoryAvailable()).toBe(true)
  })
})

describe('callSharedMemory', () => {
  beforeEach(() => {
    setSharedMemoryMcpManager(null)
    clearSharedMemoryCache()
  })

  it('fails cleanly with no manager configured', async () => {
    const result = await callSharedMemory('search', { query: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not configured')
  })

  it('maps action to the correct rag_* tool name and forwards args verbatim', async () => {
    const callTool = vi.fn(async () => ({ success: true, output: '{"results":[]}' }))
    setSharedMemoryMcpManager(fakeManager({ callTool }))
    await callSharedMemory('search', { query: 'deploy docker' })
    expect(callTool).toHaveBeenCalledWith('llm-aether', 'rag_search', { query: 'deploy docker' }, undefined)
  })

  it('forwards the calling session so a per-session aether server can route it', async () => {
    const callTool = vi.fn(async () => ({ success: true, output: '{"results":[]}' }))
    setSharedMemoryMcpManager(fakeManager({ callTool }))
    await callSharedMemory('search', { query: 'deploy docker' }, 'session-7')
    expect(callTool).toHaveBeenCalledWith('llm-aether', 'rag_search', { query: 'deploy docker' }, 'session-7')
  })

  it('parses a JSON string output into data', async () => {
    setSharedMemoryMcpManager(fakeManager({ callTool: vi.fn(async () => ({ success: true, output: '{"ok":true}' })) }))
    const result = await callSharedMemory('collections', {})
    expect(result).toEqual({ success: true, data: { ok: true } })
  })

  it('surfaces the underlying MCP error without pretending success', async () => {
    setSharedMemoryMcpManager(
      fakeManager({ callTool: vi.fn(async () => ({ success: false, error: 'MCP server not found' })) }),
    )
    const result = await callSharedMemory('search', { query: 'x' })
    expect(result).toEqual({ success: false, error: 'MCP server not found' })
  })

  it('reports a non-JSON response as an explicit error instead of throwing', async () => {
    setSharedMemoryMcpManager(fakeManager({ callTool: vi.fn(async () => ({ success: true, output: 'not json' })) }))
    const result = await callSharedMemory('search', { query: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('non-JSON')
  })
})

describe('searchSharedMemoryBounded caching (criterion 12)', () => {
  beforeEach(() => {
    setSharedMemoryMcpManager(null)
    clearSharedMemoryCache()
  })

  it('serves a fresh result from cache when the next call fails, instead of failing outright', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: '{"results":[{"id":"e1"}]}' })
      .mockResolvedValueOnce({ success: false, error: 'connection refused' })
    setSharedMemoryMcpManager(fakeManager({ callTool }))

    const first = await searchSharedMemoryBounded('deploy docker')
    expect(first).toEqual({ success: true, data: { results: [{ id: 'e1' }] } })

    const second = await searchSharedMemoryBounded('deploy docker')
    expect(second).toEqual({ success: true, data: { results: [{ id: 'e1' }] } })
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('does not serve a cached result for a different query', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: '{"results":[{"id":"e1"}]}' })
      .mockResolvedValueOnce({ success: false, error: 'connection refused' })
    setSharedMemoryMcpManager(fakeManager({ callTool }))

    await searchSharedMemoryBounded('deploy docker')
    const other = await searchSharedMemoryBounded('completely different query')
    expect(other.success).toBe(false)
  })

  it('does not fall back to a stale cache entry past its TTL', async () => {
    vi.useFakeTimers()
    try {
      const callTool = vi
        .fn()
        .mockResolvedValueOnce({ success: true, output: '{"results":[{"id":"e1"}]}' })
        .mockResolvedValueOnce({ success: false, error: 'connection refused' })
      setSharedMemoryMcpManager(fakeManager({ callTool }))

      await searchSharedMemoryBounded('deploy docker')
      vi.advanceTimersByTime(6 * 60_000)
      const result = await searchSharedMemoryBounded('deploy docker')
      expect(result.success).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('getSharedMemoryHealth', () => {
  beforeEach(() => {
    setSharedMemoryMcpManager(null)
    clearSharedMemoryCache()
  })

  it('reports not_configured when no manager is set', () => {
    expect(getSharedMemoryHealth()).toEqual({ configured: false, status: 'not_configured' })
  })

  it('reports the live server status when configured', () => {
    setSharedMemoryMcpManager(
      fakeManager({
        getServer: vi.fn(
          () => ({ name: 'llm-aether', status: 'error', tools: [], estimatedTokens: 0, config: {} }) as any,
        ),
      }),
    )
    expect(getSharedMemoryHealth()).toEqual({ configured: true, status: 'error' })
  })
})

describe('searchSharedMemoryBounded', () => {
  beforeEach(() => {
    setSharedMemoryMcpManager(null)
    clearSharedMemoryCache()
  })

  it('resolves normally when the call is fast', async () => {
    setSharedMemoryMcpManager(
      fakeManager({ callTool: vi.fn(async () => ({ success: true, output: '{"results":[]}' })) }),
    )
    const result = await searchSharedMemoryBounded('deploy', { timeoutMs: 500 })
    expect(result).toEqual({ success: true, data: { results: [] } })
  })

  it('times out instead of hanging when the underlying call never resolves', async () => {
    setSharedMemoryMcpManager(
      fakeManager({
        callTool: vi.fn(() => new Promise<{ success: boolean; output?: string; error?: string }>(() => {})),
      }), // never resolves
    )
    const result = await searchSharedMemoryBounded('deploy', { timeoutMs: 20 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
  })
})
