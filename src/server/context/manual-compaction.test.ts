import { describe, expect, it, vi } from 'vitest'

describe('manual compaction orchestration', () => {
  it.fails('compacts an idle session immediately', async () => {
    const { requestManualCompaction } = await import('./manual-compaction.js')
    const compactNow = vi.fn(async () => undefined)
    const schedule = vi.fn(() => true)

    const result = await requestManualCompaction(
      { sessionId: 'peer', callerSessionId: 'caller' },
      { getSession: () => ({ isRunning: false }), compactNow, schedule },
    )

    expect(result).toEqual({ status: 'compacted' })
    expect(compactNow).toHaveBeenCalledWith('peer')
    expect(schedule).not.toHaveBeenCalled()
  })

  it.fails('refuses another session during its turn', async () => {
    const { requestManualCompaction } = await import('./manual-compaction.js')
    const compactNow = vi.fn(async () => undefined)
    const schedule = vi.fn(() => true)

    const result = await requestManualCompaction(
      { sessionId: 'peer', callerSessionId: 'caller' },
      { getSession: () => ({ isRunning: true }), compactNow, schedule },
    )

    expect(result).toEqual({ status: 'session_busy' })
    expect(compactNow).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })

  it.fails('schedules self compaction without running it in the current turn', async () => {
    const { requestManualCompaction } = await import('./manual-compaction.js')
    const compactNow = vi.fn(async () => undefined)
    const schedule = vi.fn(() => true)

    const result = await requestManualCompaction(
      { sessionId: 'caller', callerSessionId: 'caller' },
      { getSession: () => ({ isRunning: true }), compactNow, schedule },
    )

    expect(result).toEqual({ status: 'compaction_scheduled' })
    expect(schedule).toHaveBeenCalledWith('caller')
    expect(compactNow).not.toHaveBeenCalled()
  })
})
