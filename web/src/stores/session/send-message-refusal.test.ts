// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))

const fetchMock = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }), status: 200 }),
)
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const { wsSendMock, launchHandlers } = vi.hoisted(() => ({
  wsSendMock: vi.fn(() => 'launch-1'),
  launchHandlers: new Set<(message: { id?: string; type: string; payload?: unknown }) => void>(),
}))

vi.mock('../../lib/ws', () => ({
  wsClient: {
    send: wsSendMock,
    subscribe: (handler: (message: { id?: string; type: string; payload?: unknown }) => void) => {
      launchHandlers.add(handler)
      return () => {
        launchHandlers.delete(handler)
      }
    },
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(() => undefined),
    onStatusChange: vi.fn(() => undefined),
  },
}))

function emitLaunch(message: { id?: string; type: string; payload?: unknown }) {
  for (const handler of [...launchHandlers]) handler(message)
}

vi.mock('../../lib/sound', () => ({
  playNotification: vi.fn(),
  playAchievement: vi.fn(),
  playIntervention: vi.fn(),
  playWaitingForUser: vi.fn(),
  playNewMessage: vi.fn(),
}))

type SessionStoreModule = typeof import('../session')

async function loadSessionStore(): Promise<SessionStoreModule['useSessionStore']> {
  vi.resetModules()
  const module = await import('../session')
  return module.useSessionStore
}

function session(id: string) {
  return {
    id,
    projectId: 'project-1',
    workdir: `/tmp/${id}`,
    mode: 'builder' as const,
    phase: 'build' as const,
    isRunning: false,
    criteria: [],
    summary: null,
    messages: [],
  }
}

function pane(id: string) {
  return {
    session: session(id),
    messages: [] as Array<Record<string, unknown>>,
    hiddenCount: 0,
    error: null,
    queuedMessages: [],
    pendingPathConfirmations: [],
    pendingQuestions: [],
    activeWorkflowExecution: null,
    abortInProgress: false,
  }
}

const exitContent =
  'Background process "build" (proc-1) exited with code 0.\n<process-output>\nbuild ok\n</process-output>'

function exitMessage(id: string) {
  return {
    id,
    role: 'user' as const,
    content: exitContent,
    timestamp: '2026-11-08T12:00:00.000Z',
    isSystemGenerated: true,
    messageKind: 'background-exit' as const,
  }
}

function runningWorkflow() {
  return {
    id: 'exec-1',
    sessionId: 'session-1',
    workflowId: 'wf',
    workflowName: 'WF',
    status: 'running' as const,
    currentStepId: 'step-1',
    stepOutput: {},
    params: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('sendMessage refusal', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    wsSendMock.mockClear()
    launchHandlers.clear()
    wsSendMock.mockImplementation(() => 'launch-1')
  })

  async function readyStore() {
    const useSessionStore = await loadSessionStore()
    useSessionStore.setState({
      currentSession: session('session-1') as never,
      error: { code: 'CHAT_ERROR', message: 'stale' },
    })
    return useSessionStore
  }

  it('returns ok and clears the previous error after the server accepts the message', async () => {
    const useSessionStore = await readyStore()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    })

    const result = await useSessionStore
      .getState()
      .sendMessage('session-1', 'hello', [
        { id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 4, data: 'note' },
      ])

    expect(result).toEqual({ ok: true })
    expect(useSessionStore.getState().error).toBeNull()
  })

  it.each([
    [409, { error: 'Session is interrupted', code: 'SESSION_INTERRUPTED' }, 'SESSION_INTERRUPTED', 'Resume'],
    [409, { error: 'Session is stopping', code: 'SESSION_ALREADY_RUNNING' }, 'SESSION_ALREADY_RUNNING', 'stopping'],
    [
      429,
      { error: 'Session message queue reached its limit of 8', code: 'SESSION_QUEUE_FULL' },
      'SESSION_QUEUE_FULL',
      'wait',
    ],
  ] as const)(
    'surfaces an actionable error on HTTP %s without treating the send as accepted',
    async (status, body, code, hint) => {
      const useSessionStore = await readyStore()
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status,
        json: () => Promise.resolve(body),
      } as never)

      const result = await useSessionStore
        .getState()
        .sendMessage('session-1', 'keep me', [
          { id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 4, data: 'note' },
        ])

      expect(result?.ok).toBe(false)
      if (!result || result.ok) return
      expect(result.status).toBe(status)
      expect(result.code).toBe(code)
      expect(result.message).toContain('draft and attachments were kept')
      expect(result.message.toLowerCase()).toContain(hint.toLowerCase())
      expect(useSessionStore.getState().error).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps the draft until a running workflow launch is accepted', async () => {
    const useSessionStore = await readyStore()
    useSessionStore.setState({ activeWorkflowExecution: runningWorkflow() as never })
    const pending = useSessionStore.getState().sendMessage('session-1', 'keep me')
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wsSendMock).toHaveBeenCalledWith('runner.launch', expect.objectContaining({ content: 'keep me' }))

    emitLaunch({ id: 'launch-1', type: 'ack', payload: {} })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('keeps the draft when a running workflow launch is refused', async () => {
    const useSessionStore = await readyStore()
    useSessionStore.setState({ activeWorkflowExecution: runningWorkflow() as never })
    const pending = useSessionStore.getState().sendMessage('session-1', 'keep me')
    emitLaunch({
      id: 'launch-1',
      type: 'error',
      payload: { code: 'SESSION_INTERRUPTED', message: 'Session is interrupted' },
    })
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('SESSION_INTERRUPTED')
    expect(result.message).toContain('Resume')
    expect(result.message).toContain('draft and attachments were kept')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the draft when the workflow launch socket is down', async () => {
    const useSessionStore = await readyStore()
    useSessionStore.setState({ activeWorkflowExecution: runningWorkflow() as never })
    wsSendMock.mockImplementation(() => {
      throw new Error('WebSocket not connected')
    })
    const result = await useSessionStore.getState().sendMessage('session-1', 'keep me')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('SEND_FAILED')
    expect(result.message).toContain('WebSocket not connected')
    expect(result.message).toContain('draft and attachments were kept')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the draft when a workflow launch is never acknowledged', async () => {
    const useSessionStore = await readyStore()
    useSessionStore.setState({ activeWorkflowExecution: runningWorkflow() as never })
    vi.useFakeTimers()
    try {
      const pending = useSessionStore.getState().sendMessage('session-1', 'keep me')
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('draft and attachments were kept')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('launchWorkflow acknowledgement', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    wsSendMock.mockClear()
    launchHandlers.clear()
    wsSendMock.mockImplementation(() => 'launch-1')
  })

  it('does not open a transcript error when the launch is refused', async () => {
    const useSessionStore = await loadSessionStore()
    useSessionStore.setState({
      currentSession: session('session-1') as never,
      error: { code: 'CHAT_ERROR', message: 'stale' },
    })
    const pending = useSessionStore.getState().launchWorkflow('session-1', undefined, undefined, 'simple')
    emitLaunch({
      id: 'launch-1',
      type: 'error',
      payload: { code: 'SESSION_RUNNING', message: 'A turn is already running' },
    })
    const result = await pending
    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.message).toContain('draft and attachments were kept')
    expect(useSessionStore.getState().error).toBeNull()
  })
})

describe('background-exit reload and split parity', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    wsSendMock.mockClear()
  })

  it('keeps the same background-exit message on session reload and on a live split pane', async () => {
    const useSessionStore = await loadSessionStore()
    const notice = exitMessage('exit-1')
    useSessionStore.setState({
      currentSession: session('s1') as never,
      focusedSessionId: 's1',
      openSessionIds: ['s1', 's2'],
      messages: [],
      panes: {
        s1: pane('s1'),
        s2: pane('s2'),
      } as never,
    })

    useSessionStore.getState().handleServerMessage({
      id: 'reload-1',
      type: 'session.state',
      sessionId: 's1',
      payload: {
        session: session('s1'),
        messages: [notice],
        hiddenCount: 0,
        pendingConfirmations: [],
        pendingQuestions: [],
      },
    } as never)

    useSessionStore.getState().handleServerMessage({
      id: 'live-1',
      type: 'chat.message',
      sessionId: 's2',
      payload: { message: { ...notice, id: 'exit-2' } },
    } as never)

    const state = useSessionStore.getState()
    const reloaded = state.panes['s1']?.messages[0]
    const live = state.panes['s2']?.messages[0]
    expect(reloaded?.messageKind).toBe('background-exit')
    expect(live?.messageKind).toBe('background-exit')
    expect(reloaded?.content).toBe(exitContent)
    expect(live?.content).toBe(exitContent)
    expect(reloaded?.isSystemGenerated).toBe(true)
    expect(live?.isSystemGenerated).toBe(true)
  })
})
