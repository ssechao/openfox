import { describe, it, expect, vi } from 'vitest'

const mockGetProject = vi.fn()
const mockGetSessionOverride = vi.fn()

vi.mock('../db/projects.js', () => ({ getProject: mockGetProject }))
vi.mock('../db/sessions.js', () => ({ getSessionSharedMemoryOverride: mockGetSessionOverride }))

describe('resolveSharedMemorySettings', () => {
  it('defaults to disabled when the project has no settings at all', async () => {
    mockGetProject.mockReturnValue(null)
    const { resolveSharedMemorySettings } = await import('./settings.js')
    expect(resolveSharedMemorySettings('p1')).toEqual({
      enabled: false,
      collections: [],
      captureEnabled: true,
      retrievalEnabled: true,
    })
  })

  it('applies the project-level settings over the defaults', async () => {
    mockGetProject.mockReturnValue({ sharedMemorySettings: { enabled: true, collections: ['ops'] } })
    const { resolveSharedMemorySettings } = await import('./settings.js')
    expect(resolveSharedMemorySettings('p1')).toEqual({
      enabled: true,
      collections: ['ops'],
      captureEnabled: true,
      retrievalEnabled: true,
    })
  })

  it('applies a session override on top of the project settings, field by field', async () => {
    mockGetProject.mockReturnValue({
      sharedMemorySettings: { enabled: true, collections: ['ops'], captureEnabled: true },
    })
    mockGetSessionOverride.mockReturnValue({ captureEnabled: false })
    const { resolveSharedMemorySettings } = await import('./settings.js')
    expect(resolveSharedMemorySettings('p1', 's1')).toEqual({
      enabled: true,
      collections: ['ops'],
      captureEnabled: false,
      retrievalEnabled: true,
    })
  })

  it('does not look up a session override when no sessionId is given', async () => {
    mockGetProject.mockReturnValue(null)
    mockGetSessionOverride.mockClear()
    const { resolveSharedMemorySettings } = await import('./settings.js')
    resolveSharedMemorySettings('p1')
    expect(mockGetSessionOverride).not.toHaveBeenCalled()
  })
})
