// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CriteriaEditor } from './CriteriaEditor'
import { authFetch } from '../../lib/api'

vi.mock('../../lib/api', () => ({
  authFetch: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
}))

vi.mock('../shared/Modal', () => ({
  Modal: () => null,
}))

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ agents: [], refresh: vi.fn() }),
}))

vi.mock('../../hooks/useWorkflows', () => ({
  useWorkflows: () => ({ workflows: [], refresh: vi.fn() }),
}))

vi.mock('../../hooks/useSessionWorkdir', () => ({
  useSessionWorkdir: () => undefined,
}))

const mockedAuthFetch = vi.mocked(authFetch)

function openAddInput() {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  return screen.getByPlaceholderText('New criterion...')
}

describe('CriteriaEditor', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    mockedAuthFetch.mockClear()
  })

  it('creates one pending criterion per non-empty pasted line in one request', () => {
    render(<CriteriaEditor entries={[]} sessionId="session-1" />)
    const input = openAddInput()

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => ' First criterion \r\n\r\nSecond criterion\n Third criterion ',
      },
    })

    expect(screen.getByText('[0] First criterion')).toBeInTheDocument()
    expect(screen.getByText('[1] Second criterion')).toBeInTheDocument()
    expect(screen.getByText('[2] Third criterion')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    expect(mockedAuthFetch).toHaveBeenCalledWith('/api/sessions/session-1/criteria', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        criteria: [
          { id: '0', description: 'First criterion', status: 'pending' },
          { id: '1', description: 'Second criterion', status: 'pending' },
          { id: '2', description: 'Third criterion', status: 'pending' },
        ],
      }),
    })
  })

  it('shows the full criterion on hover and keeps click-to-edit', async () => {
    const description =
      'A very long acceptance criterion whose complete requirement must remain readable even when the row is truncated'
    const { container } = render(
      <CriteriaEditor sessionId="session-1" entries={[{ id: '7', description, status: 'pending' }]} />,
    )

    const criterionButton = screen.getByRole('button', { name: `[7] ${description}` })
    expect(criterionButton).not.toHaveAttribute('title')
    const trigger = criterionButton.parentElement as HTMLElement
    fireEvent.mouseEnter(trigger)

    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(`[7] ${description}`))

    fireEvent.click(criterionButton)
    expect(container.querySelector('input')).toHaveValue(description)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps a long criterion tooltip inside the viewport beside the sidebar', async () => {
    const description = 'A long criterion '.repeat(50).trim()
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 720)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tooltip') {
        return {
          top: 0,
          left: 0,
          right: 512,
          bottom: 240,
          width: 512,
          height: 240,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect
      }
      return {
        top: 12,
        left: 1000,
        right: 1270,
        bottom: 32,
        width: 270,
        height: 20,
        x: 1000,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect
    })
    render(<CriteriaEditor sessionId="session-1" entries={[{ id: '17', description, status: 'pending' }]} />)

    const criterionButton = screen.getByRole('button', { name: `[17] ${description}` })
    fireEvent.mouseEnter(criterionButton.parentElement as HTMLElement)

    const tooltip = await screen.findByRole('tooltip')
    await waitFor(() => expect(tooltip.style.left).toBe('480px'))
    expect(tooltip).toHaveClass('max-w-lg')
    expect(tooltip.style.top).toBe('8px')
    expect(Number.parseFloat(tooltip.style.left) + 512).toBeLessThanOrEqual(1272)
  })

  it('shows the full criterion when keyboard focus reaches its button', async () => {
    const description = 'A criterion that must be available to keyboard users in full'
    const user = userEvent.setup()
    render(<CriteriaEditor sessionId="session-1" entries={[{ id: '9', description, status: 'pending' }]} />)

    const criterionButton = screen.getByRole('button', { name: `[9] ${description}` })
    await user.tab()
    await user.tab()

    expect(criterionButton).toHaveFocus()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(`[9] ${description}`))
  })

  it('keeps a single-line paste as normal input without creating a criterion', () => {
    render(<CriteriaEditor entries={[]} sessionId="session-1" />)
    const input = openAddInput()

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => 'Single criterion',
      },
    })

    expect(mockedAuthFetch).not.toHaveBeenCalled()
    expect(screen.queryByText('[0] Single criterion')).not.toBeInTheDocument()
  })

  it('keeps the existing Enter-to-add behavior', () => {
    render(<CriteriaEditor entries={[]} sessionId="session-1" />)
    const input = openAddInput()

    fireEvent.change(input, { target: { value: 'Added with Enter' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('[0] Added with Enter')).toBeInTheDocument()
    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
  })

  it('allocates pasted IDs after the greatest existing numeric ID', () => {
    render(
      <CriteriaEditor
        sessionId="session-1"
        entries={[
          { id: '0', description: 'Existing zero', status: 'pending' },
          { id: '2', description: 'Existing two', status: 'pending' },
          { id: 'custom', description: 'Existing custom', status: 'pending' },
        ]}
      />,
    )
    const input = openAddInput()

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => 'New one\nNew two',
      },
    })

    expect(screen.getByText('[3] New one')).toBeInTheDocument()
    expect(screen.getByText('[4] New two')).toBeInTheDocument()
  })

  it('shows the clear-all confirmation inside the footer for a long criteria list', () => {
    render(
      <CriteriaEditor
        sessionId="session-1"
        entries={Array.from({ length: 16 }, (_, index) => ({
          id: String(index),
          description: `Criterion ${index}`,
          status: 'pending',
        }))}
      />,
    )

    const clearButton = screen.getByRole('button', { name: 'Clear all' })
    const footer = clearButton.parentElement
    expect(footer).not.toBeNull()

    fireEvent.click(clearButton)

    expect(within(footer!).getByText('Clear all criteria?')).toBeInTheDocument()
    expect(within(footer!).getByRole('button', { name: 'Yes' })).toBeInTheDocument()
    expect(within(footer!).getByRole('button', { name: 'No' })).toBeInTheDocument()
  })
})
