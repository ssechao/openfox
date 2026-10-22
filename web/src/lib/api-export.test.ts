// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadSessionExport } from './api'

describe('downloadSessionExport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns the server error body when export fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Blob not found: deadbeef' }),
      }),
    )
    const result = await downloadSessionExport('sess-1', 'My Session')
    expect(result).toEqual({ ok: false, error: 'Blob not found: deadbeef' })
  })

  it('falls back to the HTTP status when the body has no error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('not json')
        },
      }),
    )
    const result = await downloadSessionExport('sess-1')
    expect(result).toEqual({ ok: false, error: 'Export failed (503)' })
  })
})
