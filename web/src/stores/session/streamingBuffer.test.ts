// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { startTransitionSpy } = vi.hoisted(() => ({ startTransitionSpy: vi.fn() }))

// Spy on the real startTransition (kept, not replaced) so a test can prove a
// commit was scheduled as interruptible work rather than blocking the frame.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    startTransition: (cb: () => void) => {
      startTransitionSpy()
      return actual.startTransition(cb)
    },
  }
})

const { wsSendMock, wsSubscribeMock, wsConnectMock, wsDisconnectMock, wsStatusMock } = vi.hoisted(() => ({
  wsSendMock: vi.fn(() => 'message-id'),
  wsSubscribeMock: vi.fn(() => () => undefined),
  wsConnectMock: vi.fn(async () => undefined),
  wsDisconnectMock: vi.fn(() => undefined),
  wsStatusMock: vi.fn(() => undefined),
}))

vi.mock('../../lib/ws', () => ({
  wsClient: {
    send: wsSendMock,
    subscribe: wsSubscribeMock,
    connect: wsConnectMock,
    disconnect: wsDisconnectMock,
    onStatusChange: wsStatusMock,
  },
}))

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

describe('chat.tool_output streaming after message_updated', () => {
  beforeEach(() => {
    wsSendMock.mockClear()
    wsSubscribeMock.mockClear()
    wsConnectMock.mockClear()
    wsDisconnectMock.mockClear()
    wsStatusMock.mockClear()
    fetchMock.mockClear()
  })

  it('accumulates all tool_output chunks even after message_updated folds streamingMessage into messages', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const useSessionStore = await loadSessionStore()

    useSessionStore.setState({
      currentSession: {
        id: 'session-1',
        projectId: 'project-1',
        workdir: '/tmp/project-1',
        mode: 'builder',
        phase: 'build',
        isRunning: true,
        criteria: [],
        summary: null,
      } as any,
    })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.message',
      sessionId: 'session-1',
      payload: {
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          timestamp: '2024-01-01T00:00:00.000Z',
          tokenCount: 0,
          isStreaming: true,
        },
      },
    })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.tool_call',
      sessionId: 'session-1',
      payload: {
        messageId: 'msg-1',
        callId: 'call-1',
        tool: 'run_command',
        args: { command: 'echo hello' },
      },
    })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.message_updated',
      sessionId: 'session-1',
      payload: {
        messageId: 'msg-1',
        updates: { isStreaming: false },
      },
    })

    const msg = useSessionStore.getState().messages.find((m) => m.id === 'msg-1')
    expect(msg?.toolCalls).toHaveLength(1)
    expect(msg?.toolCalls?.[0]?.streamingOutput).toBeUndefined()
    expect(useSessionStore.getState().messages.find((m) => m.isStreaming)).toBeUndefined()

    useSessionStore.getState().handleServerMessage({
      type: 'chat.tool_output',
      sessionId: 'session-1',
      payload: { messageId: 'msg-1', callId: 'call-1', stream: 'stdout', output: 'first\n' },
    })
    vi.runAllTimers()

    const afterFirst = useSessionStore.getState().messages.find((m) => m.id === 'msg-1')
    expect(afterFirst?.toolCalls?.[0]?.streamingOutput?.map((c) => c.content).join('')).toBe('first\n')

    useSessionStore.getState().handleServerMessage({
      type: 'chat.tool_output',
      sessionId: 'session-1',
      payload: { messageId: 'msg-1', callId: 'call-1', stream: 'stdout', output: 'second\n' },
    })
    useSessionStore.getState().handleServerMessage({
      type: 'chat.tool_output',
      sessionId: 'session-1',
      payload: { messageId: 'msg-1', callId: 'call-1', stream: 'stdout', output: 'third\n' },
    })
    vi.runAllTimers()

    const updatedMsg = useSessionStore.getState().messages.find((m) => m.id === 'msg-1')
    const output = updatedMsg?.toolCalls?.[0]?.streamingOutput?.map((c) => c.content).join('') ?? ''
    expect(output).toBe('first\nsecond\nthird\n')
  })
})

describe('streaming flush throttling', () => {
  async function loadStreamingBuffer() {
    vi.resetModules()
    return import('./streamingBuffer')
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces multiple schedule calls within the throttle window into a single flush', async () => {
    const { scheduleStreamingFlush, setFlushFn, getBuffer } = await loadStreamingBuffer()
    const received: string[] = []
    setFlushFn(() => {
      received.push(getBuffer().deltaContent)
    })

    const buf = getBuffer()
    buf.messageId = 'm1'
    buf.deltaContent = ''
    scheduleStreamingFlush()
    buf.deltaContent += 'a'
    scheduleStreamingFlush()
    buf.deltaContent += 'b'
    scheduleStreamingFlush()

    expect(received).toEqual([])
    await vi.runAllTimersAsync()
    expect(received).toEqual(['ab'])
  })

  it('enforces a minimum 16ms interval between flushes', async () => {
    const { scheduleStreamingFlush, setFlushFn, getBuffer } = await loadStreamingBuffer()
    const flushFn = vi.fn()
    setFlushFn(flushFn)

    const buf = getBuffer()
    buf.messageId = 'm1'
    buf.deltaContent = 'first'
    scheduleStreamingFlush()
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(1)

    buf.deltaContent = 'second'
    scheduleStreamingFlush()
    expect(flushFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(8)
    expect(flushFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(flushFn).toHaveBeenCalledTimes(2)
  })

  it('flushes pending content and clears the buffer only when the flush consumed it', async () => {
    const { scheduleStreamingFlush, cancelStreamingFlush, setFlushFn, getBuffer } = await loadStreamingBuffer()

    // When the flush does not consume the content (the target message has not
    // landed in the store yet), cancelling must keep the buffer so the stream
    // is not silently dropped.
    const idleFlush = vi.fn()
    setFlushFn(idleFlush)
    const buf = getBuffer()
    buf.messageId = 'm1'
    buf.deltaContent = 'partial'
    scheduleStreamingFlush()
    cancelStreamingFlush()

    expect(idleFlush).toHaveBeenCalledTimes(1)
    expect(buf.messageId).toBe('m1')
    expect(buf.deltaContent).toBe('partial')

    // When the flush consumes the pending content, cancelling resets the buffer.
    const consumingFlush = vi.fn(() => {
      buf.deltaContent = ''
      buf.thinkingContent = ''
      buf.toolOutput = []
    })
    setFlushFn(consumingFlush)
    buf.messageId = 'm1'
    buf.deltaContent = 'partial'
    scheduleStreamingFlush()
    cancelStreamingFlush()

    expect(consumingFlush).toHaveBeenCalledTimes(1)
    expect(buf.messageId).toBeNull()
    expect(buf.deltaContent).toBe('')
    expect(buf.thinkingContent).toBe('')
    expect(buf.toolOutput).toEqual([])

    await vi.runAllTimersAsync()
    expect(idleFlush).toHaveBeenCalledTimes(1)
  })

  it('uses the rAF fast path when enough time elapsed since the last flush', async () => {
    const { scheduleStreamingFlush, setFlushFn, getBuffer } = await loadStreamingBuffer()
    const flushFn = vi.fn()
    setFlushFn(flushFn)

    const buf = getBuffer()
    buf.messageId = 'm1'
    buf.deltaContent = 'first'
    scheduleStreamingFlush()
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(1)

    // More than the throttle window elapses before the next schedule
    await vi.advanceTimersByTimeAsync(150)

    buf.deltaContent = 'second'
    scheduleStreamingFlush()
    // The rAF stub fires on a 0ms timer — no 100ms throttle delay
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(2)
  })

  it('renders the first delta of the next message immediately after cancel', async () => {
    const { scheduleStreamingFlush, cancelStreamingFlush, setFlushFn, getBuffer } = await loadStreamingBuffer()
    const flushFn = vi.fn()
    setFlushFn(flushFn)

    const buf = getBuffer()
    buf.messageId = 'm1'
    buf.deltaContent = 'first'
    scheduleStreamingFlush()
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(1)

    // Terminal event: commit remaining content
    cancelStreamingFlush()
    expect(flushFn).toHaveBeenCalledTimes(2)

    // Next message starts right away — its first delta must not be throttled
    buf.messageId = 'm2'
    buf.deltaContent = 'next message'
    scheduleStreamingFlush()
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(3)
  })

  it('cancels a pending rAF flush on cancel', async () => {
    const cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { scheduleStreamingFlush, cancelStreamingFlush, setFlushFn, getBuffer } = await loadStreamingBuffer()
    const flushFn = vi.fn()
    setFlushFn(flushFn)

    const buf = getBuffer()
    buf.messageId = 'm1'
    buf.deltaContent = 'first'
    scheduleStreamingFlush()
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(1)

    // More than the throttle window elapses so the next schedule takes the rAF path
    await vi.advanceTimersByTimeAsync(150)
    cancelRafSpy.mockClear()

    buf.deltaContent = 'second'
    scheduleStreamingFlush()
    cancelStreamingFlush()

    expect(cancelRafSpy).toHaveBeenCalledTimes(1)
    expect(flushFn).toHaveBeenCalledTimes(2)

    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(2)
  })
})

// Finding E (remediation plan): a raw delta feeds a private accumulator. It
// must not publish Zustand state, clone the panes map, or wake subscribers.
describe('zustand commit accounting during streaming', () => {
  it('keeps a 674-message thinking fixture bounded across 4000 deltas and terminal publication', async () => {
    const store = await bootStreamingSession()
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    const { ThinkingBlock } = await import('../../components/shared/ThinkingBlock')
    const { getMarkdownCacheSizeForTest, resetMarkdownCacheForTest } = await import('../../components/shared/Markdown')
    for (let i = 0; i < 673; i++) {
      store.getState().handleServerMessage({
        type: 'chat.message',
        sessionId: 'session-1',
        payload: {
          message: { id: `history-${i}`, role: 'user', content: `History ${i}`, timestamp: new Date(0).toISOString() },
        },
      } as never)
    }
    expect(store.getState().messages).toHaveLength(674)
    resetMarkdownCacheForTest()
    let commits = 0
    const unsubscribe = store.subscribe(() => {
      commits++
    })
    try {
      for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 1000; i++) {
          store.getState().handleServerMessage({
            type: 'chat.thinking',
            sessionId: 'session-1',
            payload: {
              messageId: 'msg-1',
              content: '**think** &self\n',
            },
          } as never)
        }
        expect(commits).toBe(batch)
        vi.runAllTimers()
        expect(commits).toBe(batch + 1)
        const message = store.getState().messages.find((message) => message.id === 'msg-1')!
        expect(message.thinkingContent).toBe('**think** &self\n'.repeat((batch + 1) * 1000))
        renderToString(createElement(ThinkingBlock, { content: message.thinkingContent!, isStreaming: true }))
        expect(getMarkdownCacheSizeForTest()).toBe(0)
      }
      store.getState().handleServerMessage({
        type: 'chat.message_updated',
        sessionId: 'session-1',
        payload: {
          messageId: 'msg-1',
          updates: { isStreaming: false },
        },
      } as never)
      store.getState().handleServerMessage({
        type: 'session.running',
        sessionId: 'session-1',
        payload: { isRunning: false },
      } as never)
      const message = store.getState().messages.find((message) => message.id === 'msg-1')!
      expect(message.isStreaming).toBe(false)
      expect(store.getState().currentSession?.isRunning).toBe(false)
      renderToString(createElement(ThinkingBlock, { content: message.thinkingContent! }))
      expect(getMarkdownCacheSizeForTest()).toBe(1)
    } finally {
      unsubscribe()
      resetMarkdownCacheForTest()
    }
  })

  async function bootStreamingSession() {
    const useSessionStore = await loadSessionStore()
    useSessionStore.setState({
      currentSession: {
        id: 'session-1',
        projectId: 'project-1',
        workdir: '/tmp/project-1',
        mode: 'builder',
        phase: 'build',
        isRunning: true,
        criteria: [],
        summary: null,
      } as any,
    })
    useSessionStore.getState().handleServerMessage({
      type: 'chat.message',
      sessionId: 'session-1',
      payload: {
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          timestamp: '2024-01-01T00:00:00.000Z',
          tokenCount: 0,
          isStreaming: true,
        },
      },
    } as never)
    return useSessionStore
  }

  const sendDelta = (store: Awaited<ReturnType<typeof bootStreamingSession>>, content: string) =>
    store.getState().handleServerMessage({
      type: 'chat.delta',
      sessionId: 'session-1',
      payload: { messageId: 'msg-1', content },
    } as never)

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes one state update per flush, not one per raw delta', async () => {
    const useSessionStore = await bootStreamingSession()

    let commits = 0
    const unsubscribe = useSessionStore.subscribe(() => {
      commits++
    })

    for (let i = 0; i < 50; i++) sendDelta(useSessionStore, `d${i} `)
    expect(commits).toBe(0)

    vi.runAllTimers()
    expect(commits).toBe(1)

    const expected = Array.from({ length: 50 }, (_, i) => `d${i} `).join('')
    expect(useSessionStore.getState().messages.find((m) => m.id === 'msg-1')?.content).toBe(expected)

    unsubscribe()
  })

  it('keeps state and panes identity across a raw delta', async () => {
    const useSessionStore = await bootStreamingSession()

    const before = useSessionStore.getState()
    sendDelta(useSessionStore, 'chunk')

    const after = useSessionStore.getState()
    expect(after).toBe(before)
    expect(after.panes).toBe(before.panes)
    expect(after.messages).toBe(before.messages)
  })

  it('commits a scheduled streaming flush as an interruptible transition', async () => {
    const useSessionStore = await bootStreamingSession()
    startTransitionSpy.mockClear()

    for (let i = 0; i < 20; i++) sendDelta(useSessionStore, `d${i} `)
    // Buffered only — nothing committed, so nothing scheduled yet.
    expect(startTransitionSpy).not.toHaveBeenCalled()

    vi.runAllTimers()

    // The frame commit must be deferred work: React can interrupt it to serve
    // user input, so a long feed never freezes the tab mid-stream.
    expect(startTransitionSpy).toHaveBeenCalledTimes(1)
    const expected = Array.from({ length: 20 }, (_, i) => `d${i} `).join('')
    expect(useSessionStore.getState().messages.find((m) => m.id === 'msg-1')?.content).toBe(expected)
  })

  it('commits a terminal flush urgently, never as a transition', async () => {
    const useSessionStore = await bootStreamingSession()
    sendDelta(useSessionStore, 'tail')
    startTransitionSpy.mockClear()

    // A terminal event closes the message: deferring it would let React show a
    // still-streaming bubble after the turn already ended.
    useSessionStore.getState().handleServerMessage({
      type: 'chat.message_updated',
      sessionId: 'session-1',
      payload: { messageId: 'msg-1', updates: { isStreaming: false } },
    } as never)

    expect(startTransitionSpy).not.toHaveBeenCalled()
    expect(useSessionStore.getState().messages.find((m) => m.id === 'msg-1')?.content).toBe('tail')
  })

  it('forces the pending content out on a terminal event', async () => {
    const useSessionStore = await bootStreamingSession()

    sendDelta(useSessionStore, 'tail content')
    expect(useSessionStore.getState().messages.find((m) => m.id === 'msg-1')?.content).toBe('')

    // Terminal broadcast — no timer runs in between.
    useSessionStore.getState().handleServerMessage({
      type: 'chat.message_updated',
      sessionId: 'session-1',
      payload: { messageId: 'msg-1', updates: { isStreaming: false } },
    } as never)

    const msg = useSessionStore.getState().messages.find((m) => m.id === 'msg-1')
    expect(msg?.content).toBe('tail content')
    expect(msg?.isStreaming).toBe(false)
  })
})
