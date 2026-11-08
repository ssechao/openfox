// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Attachment } from '@shared/types.js'
import { ChatInput } from './ChatInput'
import { attachmentsAfterSend, remainderAfterSend } from './clear-sent-draft'

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ defaults: [], userItems: [], projectItems: [] }) }),
  ),
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentSession: { id: 's1', workdir: '/tmp', messages: [], projectId: 'p1' },
      panes: {},
      focusedSessionId: null,
      stopGeneration: vi.fn(),
      cancelQueued: vi.fn(),
      queuedMessages: [],
      restoredInput: null,
      clearRestoredInput: vi.fn(),
    }),
  useIsRunning: () => false,
  useQueuedMessages: () => [],
}))

vi.mock('../../hooks/useScrolledSend', () => ({
  useScrolledSend: () => ({ sendMessage: mockSendMessage, launchWorkflow: vi.fn() }),
}))

vi.mock('../../hooks/useEffortGateContext', () => ({
  useEffortGateContext: () => ({
    sessionId: 's1',
    currentEffort: undefined,
    warmCache: false,
    gate: { requestEffortSwitch: vi.fn() },
  }),
  useEffortGatedAgentSwitch: () => vi.fn(),
}))

vi.mock('../../hooks/useSetting', () => ({
  useSetting: (_key: string, fallback = '') => ({ value: fallback, loading: false }),
}))

vi.mock('../../components/plan/EffortChangeGate', () => ({
  EffortChangeGateProvider: (props: { children?: unknown }) => props.children,
  useEffortChangeGate: () => ({ requestEffortSwitch: vi.fn() }),
}))

const attachment: Attachment = {
  id: 'a1',
  filename: 'note.txt',
  mimeType: 'text/plain',
  size: 4,
  data: 'note',
}

function renderComposer(overrides: Record<string, unknown> = {}) {
  const props = {
    input: 'keep me',
    setInput: vi.fn(),
    attachments: [attachment],
    setAttachments: vi.fn(),
    dragOver: false,
    setDragOver: vi.fn(),
    errorMessage: null as string | null,
    setErrorMessage: vi.fn(),
    scrollToBottom: vi.fn(),
    sessionId: 's1',
    showHistory: false,
    history: [],
    selectedIndex: 0,
    openHistory: vi.fn(),
    closeHistory: vi.fn(),
    navigateUp: vi.fn(),
    navigateDown: vi.fn(),
    selectCurrent: vi.fn(),
    isAutoScrollActive: true,
    setAutoScroll: vi.fn(),
    onOpenMessageSearch: vi.fn(),
    onOpenCommandsModal: vi.fn(),
    onOpenWorkflowsModal: vi.fn(),
    onSelectWorkflow: vi.fn(),
    onSelectWorkflowWithSubGroup: vi.fn(),
    onSendCommand: vi.fn(),
    clearInput: vi.fn(),
    ...overrides,
  }
  render(<ChatInput {...props} />)
  return props
}

describe('ChatInput send acknowledgement', () => {
  afterEach(() => {
    cleanup()
    mockSendMessage.mockReset()
  })

  it('keeps the draft and attachments and shows the refusal when send is not accepted', async () => {
    mockSendMessage.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'SESSION_INTERRUPTED',
      message: 'Resume it, then send again. Your draft and attachments were kept.',
    })
    const props = renderComposer()

    fireEvent.click(screen.getByTestId('chat-send-button'))

    await waitFor(() => {
      expect(props.setErrorMessage).toHaveBeenCalledWith(
        'Resume it, then send again. Your draft and attachments were kept.',
      )
    })
    expect(props.clearInput).not.toHaveBeenCalled()
    expect(props.setInput).not.toHaveBeenCalled()
    expect(props.setAttachments).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledWith('keep me', [attachment])
  })

  it('clears the draft only after the send is accepted and ignores a second click while it is in flight', async () => {
    let resolveSend: (value: { ok: true }) => void = () => {}
    mockSendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve
        }),
    )
    const props = renderComposer({ input: 'hello', attachments: [] })

    fireEvent.click(screen.getByTestId('chat-send-button'))
    fireEvent.click(screen.getByTestId('chat-send-button'))

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(props.clearInput).not.toHaveBeenCalled()

    resolveSend({ ok: true })

    await waitFor(() => {
      expect(props.setInput).toHaveBeenCalledTimes(1)
    })
    const updateInput = props.setInput.mock.calls[0]?.[0] as (current: string) => string
    expect(updateInput('hello')).toBe('')
    expect(updateInput('hello still typing')).toBe(' still typing')
    expect(props.clearInput).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('releases the send lock when the send throws, so a later click can send', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('WebSocket not connected'))
    mockSendMessage.mockResolvedValueOnce({ ok: true })
    const props = renderComposer({ input: 'hello', attachments: [] })

    fireEvent.click(screen.getByTestId('chat-send-button'))
    await waitFor(() => {
      expect(props.setErrorMessage).toHaveBeenCalledWith(expect.stringContaining('WebSocket not connected'))
    })
    expect(props.setErrorMessage.mock.calls[0]?.[0]).toContain('draft and attachments were kept')
    expect(props.clearInput).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('chat-send-button'))
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })
  })
})

describe('sent draft snapshot', () => {
  it('clears only the text and attachments that were posted', () => {
    expect(remainderAfterSend('hello', 'hello')).toBe('')
    expect(remainderAfterSend('hello still typing', 'hello')).toBe(' still typing')
    expect(remainderAfterSend('edited', 'hello')).toBe('edited')
    expect(
      attachmentsAfterSend([attachment, { ...attachment, id: 'a2' }], [attachment]).map((item) => item.id),
    ).toEqual(['a2'])
  })
})
