// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

const resumeInterruption = vi.fn()
const mockStore: {
  resumeInterruption: typeof resumeInterruption
  panes: Record<string, { abortInProgress: boolean; error: { code: string; message: string } | null }>
} = {
  resumeInterruption,
  panes: {
    s1: { abortInProgress: false, error: null },
  },
}

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

vi.mock('../../hooks/useT', () => ({
  useT: () => (tx: { en: string; fr: string }, vars?: Record<string, unknown>) => {
    let text = tx.en
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        text = text.replaceAll(`{{${key}}}`, String(value))
      }
    }
    return text
  },
}))

import { SessionResumeButton } from './SessionResumeButton'

const roots: Array<ReturnType<typeof createRoot>> = []

function render(props: { sessionId: string; interruptedAt: string; disabled?: boolean }): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<SessionResumeButton {...props} />))
  return container
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resumeInterruption.mockReset()
  mockStore.panes.s1 = { abortInProgress: false, error: null }
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('SessionResumeButton', () => {
  it('renders a resume button when the session is interrupted', () => {
    const container = render({ sessionId: 's1', interruptedAt: new Date().toISOString() })
    const button = container.querySelector('[data-testid="session-resume-button"]')
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('Resume')
    expect((button as HTMLButtonElement | null)?.disabled).toBe(false)
  })

  it('disables the button while resuming', () => {
    mockStore.panes['s1']!.abortInProgress = true
    const container = render({ sessionId: 's1', interruptedAt: new Date().toISOString() })
    const button = container.querySelector('[data-testid="session-resume-button"]')
    expect(button?.textContent).toContain('Resuming')
    expect((button as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('calls resumeInterruption when clicked', async () => {
    const container = render({ sessionId: 's1', interruptedAt: new Date().toISOString() })
    const button = container.querySelector('[data-testid="session-resume-button"]') as HTMLButtonElement

    await act(async () => {
      button.click()
    })

    expect(resumeInterruption).toHaveBeenCalledTimes(1)
    expect(resumeInterruption).toHaveBeenCalledWith('s1')
  })

  it('displays an error message when resumption fails', async () => {
    const errorMessage = 'Server error'
    mockStore.panes['s1']!.error = { code: 'resume_failed', message: errorMessage }
    const container = render({ sessionId: 's1', interruptedAt: new Date().toISOString() })

    expect(container.querySelector('[data-testid="session-resume-error"]')?.textContent).toContain(errorMessage)
  })
})
