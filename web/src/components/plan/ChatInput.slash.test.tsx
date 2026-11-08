// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { parseSlashCommand, extractTemplateParams } from '../../lib/parse-slash-command'
import { ChatInput } from './ChatInput'
import { clearCache } from '../../lib/resourceCache'
import { commandsResource, workflowsResource } from '../../lib/resources'
import type { WorkflowInfo, CommandInfo } from '../../lib/parse-slash-command'

// ============================================================================
// Unit tests: parseSlashCommand
// ============================================================================

describe('parseSlashCommand', () => {
  const workflows: WorkflowInfo[] = [
    {
      id: 'pr-review',
      name: 'PR Review',
      scope: 'builtin',
      parameters: [
        { id: 'pr_number', label: 'PR Number', position: 0, required: true },
        { id: 'pr_title', label: 'PR Title', position: 1, required: false },
      ],
    },
    { id: 'simple', name: 'Simple', scope: 'builtin' },
  ]

  it('parses /pr-review 157 into workflow and params', () => {
    const result = parseSlashCommand('/pr-review 157', workflows)
    expect(result).toEqual({ workflowId: 'pr-review', params: { pr_number: '157' } })
  })

  it('maps positional args by parameter position', () => {
    const result = parseSlashCommand('/pr-review 42 fix-bug', workflows)
    expect(result).toEqual({ workflowId: 'pr-review', params: { pr_number: '42', pr_title: 'fix-bug' } })
  })

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello world', workflows)).toBeNull()
  })

  it('returns null when workflow not found', () => {
    expect(parseSlashCommand('/nonexistent arg', workflows)).toBeNull()
  })

  it('returns null for just slash', () => {
    expect(parseSlashCommand('/', workflows)).toBeNull()
  })

  it('handles workflow without parameter definitions', () => {
    const result = parseSlashCommand('/simple foo bar', workflows)
    expect(result).toEqual({ workflowId: 'simple', params: { '0': 'foo', '1': 'bar' } })
  })

  it('handles extra args beyond defined parameters', () => {
    const result = parseSlashCommand('/pr-review 42', workflows)
    expect(result).toEqual({ workflowId: 'pr-review', params: { pr_number: '42' } })
  })
})

// ============================================================================
// Unit tests: extractPositionalParams
// ============================================================================

describe('extractTemplateParams', () => {
  it('returns empty array for template without placeholders', () => {
    expect(extractTemplateParams('Hello world')).toEqual([])
  })

  it('extracts single placeholder', () => {
    expect(extractTemplateParams('Review PR {{pr_number}}')).toEqual(['pr_number'])
  })

  it('extracts multiple placeholders in order of appearance', () => {
    expect(extractTemplateParams('{{title}}: {{id}} is {{status}}')).toEqual(['title', 'id', 'status'])
  })

  it('deduplicates repeated placeholders', () => {
    expect(extractTemplateParams('{{name}} and {{name}} again')).toEqual(['name'])
  })

  it('handles numeric placeholders too', () => {
    expect(extractTemplateParams('{{0}}: {{1}}')).toEqual(['0', '1'])
  })
})

describe('parseSlashCommand with commands', () => {
  const workflows: WorkflowInfo[] = []
  const commands: CommandInfo[] = [
    { id: 'review', name: 'Review' },
    { id: 'summarize', name: 'Summarize' },
  ]

  it('matches a command by ID', () => {
    const result = parseSlashCommand('/review arg1 arg2', workflows, commands)
    expect(result).toEqual({ commandId: 'review', params: { '0': 'arg1', '1': 'arg2' } })
  })

  it('returns null for unknown command', () => {
    expect(parseSlashCommand('/nonexistent', workflows, commands)).toBeNull()
  })

  it('workflow takes priority over command with same ID', () => {
    const wf: WorkflowInfo[] = [{ id: 'review', name: 'Review WF', scope: 'builtin' }]
    const cmds: CommandInfo[] = [{ id: 'review', name: 'Review CMD' }]
    const result = parseSlashCommand('/review arg', wf, cmds)
    expect(result).toEqual({ workflowId: 'review', params: { '0': 'arg' } })
  })
})

// ============================================================================
// Integration tests: ChatInput slash command handling
// ============================================================================

const mockSendMessage = vi.fn()
const mockLaunchWorkflow = vi.fn()

const defaultWorkflows = {
  defaults: [
    {
      id: 'pr-review',
      name: 'PR Review',
      scope: 'builtin',
      parameters: [
        { id: 'pr_number', label: 'PR Number', position: 0, required: true },
        { id: 'pr_title', label: 'PR Title', position: 1, required: false },
      ],
    },
    { id: 'simple', name: 'Simple', scope: 'builtin' },
  ],
  userItems: [],
  projectItems: [],
}

const { authFetchMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  authFetch: authFetchMock,
}))

authFetchMock.mockImplementation((url: string) => {
  if (url === '/api/commands' || url.startsWith('/api/commands?')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        defaults: [{ id: 'review', name: 'Review', agentMode: 'builder' }],
        userItems: [],
        projectItems: [],
      }),
    })
  }
  if (url.startsWith('/api/commands/review')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        metadata: { id: 'review', name: 'Review', agentMode: 'builder' },
        prompt: 'Please review PR {{pr_number}}',
      }),
    })
  }
  if (url === '/api/workflows' || url.startsWith('/api/workflows?')) {
    return Promise.resolve({ ok: true, json: async () => defaultWorkflows })
  }
  return Promise.resolve({ ok: true, json: async () => ({}) })
})

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
  useScrolledSend: () => ({ sendMessage: mockSendMessage, launchWorkflow: mockLaunchWorkflow }),
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

vi.mock('../../components/plan/EffortChangeGate', () => ({
  EffortChangeGateProvider: (props: { children?: unknown }) => <>{props.children}</>,
  useEffortChangeGate: () => ({ requestEffortSwitch: vi.fn() }),
}))

vi.mock('../../hooks/useSetting', () => ({
  useSetting: (_key: string, fallback = '') => ({ value: fallback, loading: false }),
}))

function renderChatInput(overrides: Record<string, unknown> = {}) {
  const defaultProps = {
    input: '',
    setInput: vi.fn(),
    attachments: [],
    setAttachments: vi.fn(),
    dragOver: false,
    setDragOver: vi.fn(),
    errorMessage: null,
    setErrorMessage: vi.fn(),
    scrollToBottom: vi.fn(),
    sessionId: 's1',
    sessionMode: 'planner',
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
  return render(<ChatInput {...defaultProps} />)
}

describe('ChatInput slash command integration', () => {
  beforeEach(async () => {
    // Seed the resource caches so slash resolution sees data on the first render
    // (implicit loadership would otherwise resolve asynchronously).
    await commandsResource.refresh('/tmp')
    await workflowsResource.refresh('/tmp')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    clearCache()
  })

  it('sends plain text via sendMessage', () => {
    const setInput = vi.fn()
    renderChatInput({ input: 'hello world', setInput })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    expect(mockSendMessage).toHaveBeenCalledWith('hello world', [])
    expect(mockLaunchWorkflow).not.toHaveBeenCalled()
  })

  it('launches workflow for known slash command with params', () => {
    const setInput = vi.fn()
    renderChatInput({ input: '/pr-review 42 fix-bug', setInput })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    expect(mockLaunchWorkflow).toHaveBeenCalledWith(
      undefined,
      undefined,
      'pr-review',
      undefined,
      {
        pr_number: '42',
        pr_title: 'fix-bug',
      },
      'auto',
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('sends unrecognized slash input as a plain message', () => {
    const setInput = vi.fn()
    renderChatInput({ input: '/nonexistent arg', setInput })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    expect(mockSendMessage).toHaveBeenCalledWith('/nonexistent arg', [])
    expect(mockLaunchWorkflow).not.toHaveBeenCalled()
  })

  it('sends absolute file paths as a plain message', () => {
    const setInput = vi.fn()
    renderChatInput({ input: '/home/conrad/Vidéos/sample_audio_fr.mp3', setInput })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    expect(mockSendMessage).toHaveBeenCalledWith('/home/conrad/Vidéos/sample_audio_fr.mp3', [])
    expect(mockLaunchWorkflow).not.toHaveBeenCalled()
  })

  it('applies the command agent mode when launched via slash', async () => {
    await commandsResource.refresh('/tmp')
    const setInput = vi.fn()
    const onSendCommand = vi.fn()
    renderChatInput({ input: '/review 123', setInput, onSendCommand })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    await waitFor(() => {
      expect(onSendCommand).toHaveBeenCalledWith('Please review PR 123', 'builder', undefined, [], {
        input: '/review 123',
        attachments: [],
      })
    })
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockLaunchWorkflow).not.toHaveBeenCalled()
  })

  it('does not send a slash command again while the first command is still in flight', async () => {
    await commandsResource.refresh('/tmp')
    let resolveCommand: () => void = () => {}
    const onSendCommand = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCommand = resolve
        }),
    )
    renderChatInput({ input: '/review 123', onSendCommand })

    fireEvent.click(screen.getByTestId('chat-send-button'))
    await waitFor(() => {
      expect(onSendCommand).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByTestId('chat-send-button'))
    expect(onSendCommand).toHaveBeenCalledTimes(1)

    resolveCommand()
    await waitFor(() => {
      expect(onSendCommand).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByTestId('chat-send-button'))
    await waitFor(() => {
      expect(onSendCommand).toHaveBeenCalledTimes(2)
    })
  })

  it('shows error for missing required params', () => {
    const setInput = vi.fn()
    const setErrorMessage = vi.fn()
    renderChatInput({ input: '/pr-review', setInput, setErrorMessage })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    expect(setErrorMessage).toHaveBeenCalledWith(expect.stringContaining('PR Number'))
    expect(mockLaunchWorkflow).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('keeps the slash workflow draft until the launch is accepted', async () => {
    let resolveLaunch: (value: { ok: true } | { ok: false; message: string }) => void = () => {}
    mockLaunchWorkflow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve
        }),
    )
    const setInput = vi.fn()
    const setErrorMessage = vi.fn()
    const clearInput = vi.fn()
    renderChatInput({ input: '/simple foo', setInput, setErrorMessage, clearInput })

    fireEvent.click(screen.getByTestId('chat-send-button'))
    fireEvent.click(screen.getByTestId('chat-send-button'))

    expect(mockLaunchWorkflow).toHaveBeenCalledTimes(1)
    expect(setInput).not.toHaveBeenCalled()
    expect(clearInput).not.toHaveBeenCalled()

    resolveLaunch({ ok: false, message: 'A turn is already running. Your draft and attachments were kept.' })
    await waitFor(() => {
      expect(setErrorMessage).toHaveBeenCalledWith('A turn is already running. Your draft and attachments were kept.')
    })
    expect(setInput).not.toHaveBeenCalled()
    expect(clearInput).not.toHaveBeenCalled()
    mockLaunchWorkflow.mockReset()
  })

  it('clears only the posted slash workflow draft after the launch is accepted', async () => {
    mockLaunchWorkflow.mockResolvedValue({ ok: true })
    const setInput = vi.fn()
    const setErrorMessage = vi.fn()
    const clearInput = vi.fn()
    renderChatInput({ input: '/simple foo', setInput, setErrorMessage, clearInput })

    fireEvent.click(screen.getByTestId('chat-send-button'))

    expect(mockLaunchWorkflow).toHaveBeenCalled()
    await waitFor(() => {
      expect(setInput.mock.calls.some((call) => typeof call[0] === 'function')).toBe(true)
    })
    const updateInput = setInput.mock.calls.map((call) => call[0]).find((arg) => typeof arg === 'function') as (
      current: string,
    ) => string
    expect(updateInput('/simple foo')).toBe('')
    expect(updateInput('/simple foo still typing')).toBe(' still typing')
    expect(setErrorMessage).toHaveBeenCalledWith(null)
    expect(clearInput).not.toHaveBeenCalled()
    mockLaunchWorkflow.mockReset()
  })

  it('launches workflow via Enter key', () => {
    const setInput = vi.fn()
    renderChatInput({ input: '/simple foo', setInput })

    const textarea = screen.getByTestId('chat-input-textarea')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(mockLaunchWorkflow).toHaveBeenCalledWith(
      undefined,
      undefined,
      'simple',
      undefined,
      {
        '0': 'foo',
      },
      'auto',
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('validates typed slash params against the effective (project) definition', async () => {
    // Same id in multiple scopes: project wins for unselected input.
    authFetchMock.mockImplementation((url: string) => {
      if (url === '/api/workflows' || url.startsWith('/api/workflows?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            defaults: [{ id: 'pr-review', name: 'PR Review', scope: 'builtin' }],
            userItems: [
              {
                id: 'pr-review',
                name: 'PR Review',
                scope: 'user',
                parameters: [{ id: 'legacy_param', label: 'Legacy', position: 0, required: true }],
              },
            ],
            projectItems: [
              {
                id: 'pr-review',
                name: 'PR Review',
                scope: 'project',
                parameters: [{ id: 'pr_number', label: 'PR Number', position: 0, required: true }],
              },
            ],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    await workflowsResource.refresh('/tmp')
    const setErrorMessage = vi.fn()
    renderChatInput({ input: '/pr-review', setErrorMessage })

    const sendButton = screen.getByTestId('chat-send-button')
    fireEvent.click(sendButton)

    // The project definition's required param is enforced, not the user one's.
    expect(setErrorMessage).toHaveBeenCalledWith(expect.stringContaining('PR Number'))
    expect(mockLaunchWorkflow).not.toHaveBeenCalled()
  })
})
