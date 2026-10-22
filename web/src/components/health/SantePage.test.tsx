// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { DiagnosticsData, DiagnosticsSeries } from '@shared/diagnostics.js'

vi.mock('../../lib/api', () => ({
  authFetch: vi.fn(),
  hasStoredToken: vi.fn().mockReturnValue(false),
}))

import { authFetch } from '../../lib/api'
import { clearCache } from '../../lib/resourceCache'
import { SantePage } from './SantePage'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)
const roots: Array<ReturnType<typeof createRoot>> = []

function render(): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<SantePage />))
  return container
}

function series(unit: DiagnosticsSeries['unit'], value: number | null, samples: number): DiagnosticsSeries {
  return { unit, window: { startMs: NOW - 10_000, endMs: NOW }, samples, value }
}

function payload(): DiagnosticsData {
  return {
    collectedAt: NOW,
    intervalMs: 1_000,
    windowMs: 10_000,
    historyMs: 60_000,
    series: {
      eventLoopDelayP50: series('ms', 1.5, 500),
      eventLoopDelayP99: series('ms', 42, 500),
      eventLoopDelayMax: series('ms', 210, 500),
      healthLatencyP99: series('ms', null, 0),
      eventStoreReadP99: series('ms', 3, 12),
      eventStoreWriteP99: series('ms', 0.8, 40),
      walSize: series('bytes', 4 * 1024 * 1024, 10),
      runningSessions: series('count', 2, 10),
      rss: series('bytes', 300 * 1024 * 1024, 10),
      heapUsed: series('bytes', 120 * 1024 * 1024, 10),
    },
    runtimes: [],
    history: Array.from({ length: 60 }, (_, index) => ({
      timestamp: NOW - (59 - index) * 1_000,
      eventLoopDelayMax: index === 55 ? 210 : 2,
      eventLoopDelayP99: index === 55 ? 200 : 1,
    })),
  }
}

function payloadWithRuntimes(): DiagnosticsData {
  return {
    ...payload(),
    runtimes: [
      { sessionId: 'sess-a', state: 'running', lastCommand: 'launch' },
      { sessionId: 'sess-b', state: 'workflow', lastCommand: 'workflow' },
    ],
  }
}

const ok = (data: DiagnosticsData) => ({ ok: true, json: async () => data }) as unknown as Response
const text = (container: HTMLElement, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  clearCache()
  vi.mocked(authFetch).mockReset()
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('SantePage', () => {
  it('reads /api/diagnostics and shows each series with its value, window and sample count', async () => {
    vi.mocked(authFetch).mockResolvedValue(ok(payload()))
    const container = render()
    await flush()

    expect(vi.mocked(authFetch)).toHaveBeenCalledWith('/api/diagnostics')
    expect(text(container, 'sante-series-eventLoopDelayP99')).toContain('42 ms')
    expect(text(container, 'sante-series-eventLoopDelayP99')).toContain('window 10 s · 500 samples')
    expect(text(container, 'sante-series-eventLoopDelayMax')).toContain('210 ms')
    expect(text(container, 'sante-series-walSize')).toContain('4.0 MiB')
    expect(text(container, 'sante-series-runningSessions')).toContain('2')
    expect(text(container, 'sante-series-healthLatencyP99')).toContain('No data')
    expect(text(container, 'sante-series-healthLatencyP99')).toContain('0 samples')
    expect(container.querySelector('[data-testid="sante-curve"] svg path')).not.toBeNull()
    expect(text(container, 'sante-curve')).toContain('last 60 s')
    expect(container.querySelector('[data-testid="sante-error"]')).toBeNull()
  })

  it('signals a failed read', async () => {
    vi.mocked(authFetch).mockRejectedValue(new Error('network'))
    const container = render()
    await flush()
    expect(text(container, 'sante-error')).toContain('/api/diagnostics')
  })

  it('shows the runtimes panel with state and last command', async () => {
    vi.mocked(authFetch).mockResolvedValue(ok(payloadWithRuntimes()))
    const container = render()
    await flush()

    expect(text(container, 'sante-runtimes')).toContain('Runtimes')
    expect(text(container, 'runtime-sess-a')).toContain('Running')
    expect(text(container, 'runtime-sess-a')).toContain('launch')
    expect(text(container, 'runtime-sess-b')).toContain('Workflow')
    expect(text(container, 'runtime-sess-b')).toContain('workflow')
  })

  it('refreshes every 2 seconds and stops polling once unmounted', async () => {
    vi.mocked(authFetch).mockResolvedValue(ok(payload()))
    render()
    await flush()
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1)

    await flush(2_000)
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2)
    await flush(2_000)
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(3)

    for (const root of roots.splice(0)) act(() => root.unmount())
    await flush(10_000)
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(3)
  })

  it('marks the data as stale when fresh reads stop arriving', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(ok(payload())).mockRejectedValue(new Error('down'))
    const container = render()
    await flush()
    expect(container.querySelector('[data-testid="sante-stale"]')).toBeNull()

    await flush(8_000)
    expect(text(container, 'sante-stale')).toContain('Stale data')
    expect(text(container, 'sante-series-eventLoopDelayP99')).toContain('42 ms')
  })
})
