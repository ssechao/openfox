// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { MessageList } from './MessageList'

const mockContinueWorkflow = vi.fn()
const mockLaunchWorkflowAtStep = vi.fn()

// Store mock state in a way that survives vi.mock hoisting
// Using a module-level object that we mutate (not reassign)
const mockState = {
  phase: 'waiting',
  hasWaitingWorkflow: true,
  execStatus: 'waiting' as 'waiting' | 'blocked' | 'completed' | 'cancelled',
  workflowId: 'pr-review',
  workflowName: 'PR Review',
  workflowSteps: [
    { id: 'verify', name: 'Verifier', type: 'sub_agent', subAgentType: 'verifier' },
    { id: 'code_review', name: 'Code Review', type: 'sub_agent', subAgentType: 'code_reviewer' },
  ],
  isRunning: false,
  criteriaStatuses: [] as string[],
  displayItems: [] as Array<Record<string, unknown>>,
  pendingChoices: undefined as Array<{ id: string; label: string; goto: string; nextStepName?: string }> | undefined,
  llmRetry: null as
    | { status: 'retrying'; attempt: number; retryInMs: number; error: string }
    | { status: 'failed'; error: string }
    | null,
}

function buildSessionState() {
  return {
    currentSession: {
      id: 's1',
      phase: mockState.phase,
      mode: 'planner',
      isRunning: mockState.isRunning,
      criteria: [],
      metadata: {},
      metadataEntries:
        mockState.criteriaStatuses.length > 0
          ? {
              criteria: mockState.criteriaStatuses.map((status, index) => ({
                id: `c${index + 1}`,
                description: 'x',
                status,
              })),
            }
          : {},
    },
    panes: {},
    focusedSessionId: null,
    waitingWorkflow: mockState.hasWaitingWorkflow
      ? {
          workflowId: mockState.workflowId,
          workflowName: mockState.workflowName,
          stepId: 'user_test',
          stepName: 'Manual Testing',
          stepOutput: {} as Record<string, string>,
          params: { feature: 'login' },
        }
      : null,
    activeWorkflowExecution: mockState.hasWaitingWorkflow
      ? {
          id: 'exec-1',
          sessionId: 's1',
          workflowId: mockState.workflowId,
          workflowName: mockState.workflowName,
          status: mockState.execStatus,
          currentStepId: 'user_test',
          currentStepName: 'Manual Testing',
          stepOutput: {} as Record<string, string>,
          params: { feature: 'login' },
          ...(mockState.pendingChoices ? { pendingChoices: mockState.pendingChoices } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      : null,
    messages: [],
    hiddenCount: 0,
    error: null,
    clearError: vi.fn(),
    continueWorkflow: mockContinueWorkflow,
    launchWorkflowAtStep: mockLaunchWorkflowAtStep,
    exitWorkflow: vi.fn(),
    retryLLMNow: vi.fn(),
    retryLLM: vi.fn(),
    llmRetry: mockState.llmRetry,
  }
}

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(buildSessionState()),
  useIsRunning: () => mockState.isRunning,
}))

vi.mock('../../hooks/useWorkflows', () => ({
  useWorkflows: () => ({
    workflows: [
      { id: 'default', name: 'Build & Verify', color: '#3b82f6', scope: 'builtin' },
      { id: mockState.workflowId, name: mockState.workflowName, color: '#8b5cf6', scope: 'project' },
    ],
    refresh: vi.fn(),
  }),
  useWorkflow: () => ({
    data: {
      metadata: { id: mockState.workflowId, name: mockState.workflowName },
      entryStep: 'build',
      settings: { maxIterations: 12 },
      steps: mockState.workflowSteps,
    },
  }),
}))

vi.mock('../../hooks/useSessionWorkdir', () => ({
  useSessionWorkdir: () => '/tmp',
}))

vi.mock('../../hooks/useDisplaySettings', () => ({
  useDisplaySettings: () => ({
    showThinking: true,
    showVerboseToolOutput: true,
    showStats: true,
    showAgentDefinitions: true,
    showWorkflowBars: true,
  }),
}))

vi.mock('./ChatFeedItems', () => ({
  ChatFeedItems: () => <div>ChatFeedItems</div>,
}))

function renderMessageList() {
  const mockOsRef = {
    current: {
      osInstance: () => null,
      getElement: () => null,
    },
  }
  return render(
    <MessageList
      displayItems={mockState.displayItems as never}
      scrollContainerRef={mockOsRef}
      highlightedMessageId={null}
      onLaunchWorkflow={vi.fn()}
    />,
  )
}

describe('MessageList continue workflow button', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    mockContinueWorkflow.mockClear()
    mockLaunchWorkflowAtStep.mockClear()
    mockState.phase = 'waiting'
    mockState.hasWaitingWorkflow = true
    mockState.execStatus = 'waiting'
    mockState.workflowId = 'pr-review'
    mockState.workflowName = 'PR Review'
    mockState.workflowSteps = [
      { id: 'verify', name: 'Verifier', type: 'sub_agent', subAgentType: 'verifier' },
      { id: 'code_review', name: 'Code Review', type: 'sub_agent', subAgentType: 'code_reviewer' },
    ]
    mockState.criteriaStatuses = []
    mockState.displayItems = []
    mockState.pendingChoices = undefined
  })

  it('renders continue button when phase is waiting and waitingWorkflow is set', () => {
    renderMessageList()
    expect(screen.getByRole('button', { name: /continue/i })).toBeDefined()
  })

  it('does not render continue button when waitingWorkflow is null', () => {
    mockState.hasWaitingWorkflow = false
    renderMessageList()
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull()
  })

  it('does not render continue button when phase is not waiting', () => {
    mockState.phase = 'build'
    mockState.hasWaitingWorkflow = false
    renderMessageList()
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull()
  })

  it('calls continueWorkflow on click', () => {
    renderMessageList()
    screen.getByRole('button', { name: /continue/i }).click()
    expect(mockContinueWorkflow).toHaveBeenCalledTimes(1)
  })

  it('renders one button per pendingChoices when choices are present', () => {
    mockState.pendingChoices = [
      { id: 'apply', label: 'apply', goto: 'apply_fixes', nextStepName: 'Apply Fixes' },
      { id: 'skip', label: 'skip', goto: 'start_dev_server', nextStepName: 'Start Dev Server' },
      { id: 'continue', label: 'Continue', goto: 'start_dev_server', nextStepName: 'Start Dev Server' },
    ]
    renderMessageList()
    expect(screen.getByRole('button', { name: 'apply' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'skip' })).toBeDefined()
    // The synthetic continue choice shows the NEXT step it leads to, not the current user step
    expect(screen.getByRole('button', { name: /continue pr review \(start dev server\)/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /manual testing/i })).toBeNull()
  })

  it('falls back to the current step name when a continue choice has no nextStepName', () => {
    mockState.pendingChoices = [{ id: 'continue', label: 'Continue', goto: 'start_dev_server' }]
    renderMessageList()
    expect(screen.getByRole('button', { name: /continue pr review \(manual testing\)/i })).toBeDefined()
  })

  it('calls continueWorkflow with the choice id when a choice button is clicked', () => {
    mockState.pendingChoices = [
      { id: 'apply', label: 'apply', goto: 'apply_fixes' },
      { id: 'skip', label: 'skip', goto: 'start_dev_server' },
    ]
    renderMessageList()
    screen.getByRole('button', { name: 'apply' }).click()
    expect(mockContinueWorkflow).toHaveBeenCalledTimes(1)
    expect(mockContinueWorkflow).toHaveBeenCalledWith('s1', 'apply')
  })

  it('falls back to a single continue button when pendingChoices is absent', () => {
    mockState.pendingChoices = undefined
    renderMessageList()
    expect(screen.getAllByRole('button', { name: /continue/i })).toHaveLength(1)
  })

  it('hides the workflow launcher while a workflow is waiting at a user step', () => {
    mockState.criteriaStatuses = ['pending']
    mockState.displayItems = [{ type: 'message', message: { role: 'assistant', content: 'ok' } }]
    mockState.pendingChoices = [
      { id: 'Work in current workspace', label: 'Work in current workspace', goto: 'build', nextStepName: 'Implement' },
      {
        id: 'Start a new workspace',
        label: 'Start a new workspace',
        goto: 'setup_workspace',
        nextStepName: 'Setting up workspace',
      },
    ]
    renderMessageList()
    expect(screen.queryByTestId('workflow-run-button')).toBeNull()
  })

  it('shows the workflow launcher when no workflow is running or waiting', () => {
    mockState.criteriaStatuses = ['pending']
    mockState.displayItems = [{ type: 'message', message: { role: 'assistant', content: 'ok' } }]
    mockState.hasWaitingWorkflow = false
    renderMessageList()
    expect(screen.getAllByTestId('workflow-run-button').length).toBeGreaterThan(0)
  })

  it('shows Verify for completed criteria and launches a tracked verify step', () => {
    mockState.criteriaStatuses = ['completed', 'passed']
    mockState.hasWaitingWorkflow = false
    mockState.isRunning = false
    renderMessageList()

    screen.getByRole('button', { name: 'Verify' }).click()

    expect(mockLaunchWorkflowAtStep).toHaveBeenCalledWith('s1', 'default', 'verify', 'builtin')
  })

  it.each(['completed', 'cancelled', 'blocked'] as const)(
    'offers both end-step resumes for an idle %s custom workflow with intermediate criteria',
    (status) => {
      mockState.execStatus = status
      mockState.workflowId = 'custom-delivery'
      mockState.workflowName = 'Custom Delivery'
      mockState.workflowSteps = [
        { id: 'audit', name: 'Audit', type: 'sub_agent', subAgentType: 'verifier' },
        { id: 'peer_review', name: 'Peer Review', type: 'sub_agent', subAgentType: 'code_reviewer' },
      ]
      mockState.criteriaStatuses = ['completed', 'failed']
      mockState.isRunning = false
      renderMessageList()

      screen.getByRole('button', { name: 'Resume at Verify' }).click()
      screen.getByRole('button', { name: 'Resume at Code Review' }).click()

      expect(mockLaunchWorkflowAtStep).toHaveBeenNthCalledWith(1, 's1', 'custom-delivery', 'audit', 'project')
      expect(mockLaunchWorkflowAtStep).toHaveBeenNthCalledWith(2, 's1', 'custom-delivery', 'peer_review', 'project')
    },
  )

  it('only offers resume actions backed by a step in the completed workflow', () => {
    mockState.execStatus = 'completed'
    mockState.workflowSteps = [
      { id: 'peer_review', name: 'Peer Review', type: 'sub_agent', subAgentType: 'code_reviewer' },
    ]
    mockState.criteriaStatuses = ['completed']
    renderMessageList()

    expect(screen.queryByRole('button', { name: 'Resume at Verify' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume at Code Review' })).toBeDefined()
  })

  it('hides Verify while a workflow is active', () => {
    mockState.criteriaStatuses = ['completed']
    mockState.hasWaitingWorkflow = true
    renderMessageList()

    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull()
  })
})

describe('MessageList blocked workflow step', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    mockState.hasWaitingWorkflow = true
    mockState.execStatus = 'waiting'
    mockState.isRunning = false
    mockState.displayItems = []
    mockState.pendingChoices = undefined
  })

  it('renders the blocked-step message with Retry step when blocked and idle', () => {
    mockState.execStatus = 'blocked'
    mockState.isRunning = false
    renderMessageList()
    expect(screen.getByText(/step stopped before finishing/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /retry step/i })).toBeDefined()
  })

  it('does not render the blocked-step message while the session is running', () => {
    mockState.execStatus = 'blocked'
    mockState.isRunning = true
    renderMessageList()
    expect(screen.queryByText(/step stopped before finishing/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /resuming/i })).toBeNull()
  })
})

describe('MessageList LLM retry error modal', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    mockState.hasWaitingWorkflow = false
    mockState.isRunning = false
    mockState.llmRetry = null
    mockState.displayItems = []
    mockState.pendingChoices = undefined
  })

  it('opens the error modal from the retrying pill info button', () => {
    mockState.isRunning = true
    mockState.llmRetry = { status: 'retrying', attempt: 2, retryInMs: 4000, error: 'HTTP 500: boom' }
    renderMessageList()

    fireEvent.click(screen.getByRole('button', { name: /error details/i }))

    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('HTTP 500: boom')).toBeDefined()
  })

  it('keeps the modal open when a new retry attempt arrives with a new error', () => {
    mockState.isRunning = true
    mockState.llmRetry = { status: 'retrying', attempt: 1, retryInMs: 4000, error: 'boom' }
    const { rerender } = renderMessageList()

    fireEvent.click(screen.getByRole('button', { name: /error details/i }))
    expect(screen.getByText('boom')).toBeDefined()

    mockState.llmRetry = { status: 'retrying', attempt: 2, retryInMs: 8000, error: 'rate limited' }
    rerender(
      <MessageList
        displayItems={mockState.displayItems as never}
        scrollContainerRef={{
          current: { osInstance: () => null, getElement: () => null },
        }}
        highlightedMessageId={null}
        onLaunchWorkflow={vi.fn()}
      />,
    )

    expect(screen.getByText('rate limited')).toBeDefined()
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('closes the modal when the retry state clears', () => {
    mockState.isRunning = true
    mockState.llmRetry = { status: 'retrying', attempt: 1, retryInMs: 4000, error: 'boom' }
    const { rerender } = renderMessageList()

    fireEvent.click(screen.getByRole('button', { name: /error details/i }))
    expect(screen.getByText('boom')).toBeDefined()

    mockState.llmRetry = null
    rerender(
      <MessageList
        displayItems={mockState.displayItems as never}
        scrollContainerRef={{
          current: { osInstance: () => null, getElement: () => null },
        }}
        highlightedMessageId={null}
        onLaunchWorkflow={vi.fn()}
      />,
    )

    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the error modal from the failed bubble info button and pretty-prints JSON', () => {
    mockState.isRunning = false
    mockState.llmRetry = { status: 'failed', error: '{"error":"boom"}' }
    renderMessageList()

    fireEvent.click(screen.getByRole('button', { name: /error details/i }))

    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText(/"error": "boom"/)).toBeDefined()
  })
})
