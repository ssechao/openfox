import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.js'

const runOrchestratorMock = vi.fn()

vi.mock('./index.js', () => ({
  runOrchestrator: (...args: unknown[]) => runOrchestratorMock(...args),
}))

import { launchWorkflowRun } from './launch.js'
import { getSessionRuntimeRegistry, resetSessionRuntimeRegistry } from '../session/index.js'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('launchWorkflowRun', () => {
  let sessionManager: {
    setRunning: ReturnType<typeof vi.fn>
    getActiveWorkflowExecution: ReturnType<typeof vi.fn>
    getLatestWorkflowExecution: ReturnType<typeof vi.fn>
    resumeWorkflow: ReturnType<typeof vi.fn>
  }
  let broadcast: ReturnType<typeof vi.fn>
  let onFinished: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runOrchestratorMock.mockReset()
    resetSessionRuntimeRegistry()
    sessionManager = {
      setRunning: vi.fn(),
      getActiveWorkflowExecution: vi.fn(() => null),
      getLatestWorkflowExecution: vi.fn(() => null),
      resumeWorkflow: vi.fn(),
    }
    broadcast = vi.fn()
    onFinished = vi.fn(() => 'settled')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetSessionRuntimeRegistry()
  })

  const run = (payload: Record<string, unknown> = {}) =>
    launchWorkflowRun(
      {
        sessionManager: sessionManager as never,
        sessionId: 'sess-1',
        runtimeHandle: getSessionRuntimeRegistry().get('sess-1').acquire('workflow'),
        llmClient: { getModel: () => 'm', getBackend: () => 'openai' } as never,
        statsIdentity: { providerId: 'p', providerName: 'pn', backend: 'openai', model: 'm' },
        broadcastForSession: broadcast as never,
        onFinished: onFinished as never,
      },
      payload as never,
    )

  it('marks the session running before the run and idle after it', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    run({ workflowId: 'wf' })
    await flush()

    expect(sessionManager.setRunning).toHaveBeenNthCalledWith(1, 'sess-1', true)
    expect(sessionManager.setRunning).toHaveBeenLastCalledWith('sess-1', false)
    const runningTrue = broadcast.mock.calls.find(
      ([, msg]) => msg.type === 'session.running' && msg.payload.isRunning === true,
    )
    const runningFalse = broadcast.mock.calls.find(
      ([, msg]) => msg.type === 'session.running' && msg.payload.isRunning === false,
    )
    expect(runningTrue).toBeTruthy()
    expect(runningFalse).toBeTruthy()
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it('passes workflowId, params and a normalized scope to the orchestrator', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    run({ workflowId: 'wf', params: { a: '1' }, scope: 'user' })
    await flush()

    const options = runOrchestratorMock.mock.calls[0]![0]
    expect(options.workflowId).toBe('wf')
    expect(options.params).toEqual({ a: '1' })
    expect(options.scope).toBe('user')
    expect(options.sessionId).toBe('sess-1')
    expect(typeof options.onMessage).toBe('function')
  })

  it('normalizes an invalid scope to auto', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    run({ workflowId: 'wf', scope: 'bogus' })
    await flush()
    expect(runOrchestratorMock.mock.calls[0]![0].scope).toBe('auto')
  })

  it('builds a userMessage from content and attachments', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    run({ content: 'hello', attachments: [{ id: 'a1' }] })
    await flush()
    expect(runOrchestratorMock.mock.calls[0]![0].userMessage).toEqual({
      content: 'hello',
      attachments: [{ id: 'a1' }],
    })
  })

  it('omits userMessage when there is no content or attachments', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    run({ workflowId: 'wf' })
    await flush()
    expect('userMessage' in runOrchestratorMock.mock.calls[0]![0]).toBe(false)
  })

  it('surfaces orchestrator errors as chat.error', async () => {
    runOrchestratorMock.mockRejectedValue(new Error('Missing required parameter: x'))
    run({ workflowId: 'wf' })
    await flush()

    const errorMsg = broadcast.mock.calls.find(([, msg]) => msg.type === 'chat.error')?.[1] as ServerMessage<{
      error: string
    }>
    expect(errorMsg).toBeTruthy()
    expect(errorMsg.payload.error).toContain('Missing required parameter: x')
  })

  it('does not surface a chat.error for a controlled abort', async () => {
    runOrchestratorMock.mockRejectedValue(new Error('Aborted'))
    run({ workflowId: 'wf' })
    await flush()

    expect(broadcast.mock.calls.some(([msg]) => msg.type === 'chat.error')).toBe(false)
    expect(sessionManager.setRunning).toHaveBeenLastCalledWith('sess-1', false)
  })

  it('calls onFinished even when the orchestrator rejects', async () => {
    runOrchestratorMock.mockRejectedValue(new Error('boom'))
    run({ workflowId: 'wf' })
    await flush()
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it('keeps the runtime acquired while onFinished runs, then releases it', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    const runtime = getSessionRuntimeRegistry().get('sess-1')
    onFinished.mockImplementation(() => {
      expect(runtime.currentHandle()).not.toBeNull()
      return 'settled'
    })
    run({ workflowId: 'wf' })
    await flush()
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(runtime.currentHandle()).toBeNull()
    expect(runtime.snapshot().state).toBe('idle')
  })

  it('leaves the running state to the successor when onFinished restarts a turn', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    onFinished.mockImplementation(() => {
      // cleanupAfterTurn released the workflow handle and acquired the
      // successor's chat handle before returning.
      const runtime = getSessionRuntimeRegistry().get('sess-1')
      runtime.release(runtime.currentHandle()!)
      runtime.acquire('chat')
      return 'restarted'
    })
    run({ workflowId: 'wf' })
    await flush()

    expect(onFinished).toHaveBeenCalledTimes(1)
    // No isRunning=false write, no running=false broadcast: the successor owns it
    expect(sessionManager.setRunning).toHaveBeenCalledTimes(1)
    expect(sessionManager.setRunning).toHaveBeenNthCalledWith(1, 'sess-1', true)
    expect(
      broadcast.mock.calls.some(([, msg]) => msg.type === 'session.running' && msg.payload.isRunning === false),
    ).toBe(false)
    // The old finally must not release the successor's handle either
    const handle = getSessionRuntimeRegistry().get('sess-1').currentHandle()
    expect(handle?.kind).toBe('chat')
  })

  it('does not write the running state when onFinished reports a stale handle', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    onFinished.mockReturnValue('stale')
    run({ workflowId: 'wf' })
    await flush()

    expect(sessionManager.setRunning).toHaveBeenCalledTimes(1)
    expect(
      broadcast.mock.calls.some(([, msg]) => msg.type === 'session.running' && msg.payload.isRunning === false),
    ).toBe(false)
  })

  it('does not recreate a runtime after the session is deleted mid-run', async () => {
    let settle!: (value: unknown) => void
    runOrchestratorMock.mockImplementation(
      () =>
        new Promise((done) => {
          settle = done
        }),
    )
    run({ workflowId: 'wf' })
    getSessionRuntimeRegistry().remove('sess-1')
    settle({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    await flush()
    expect(getSessionRuntimeRegistry().peek('sess-1')).toBeUndefined()
  })

  it('re-activates a blocked execution when retrying its step', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    sessionManager.getLatestWorkflowExecution = vi.fn(() => ({
      id: 'exec-1',
      sessionId: 'sess-1',
      workflowId: 'default',
      workflowName: 'Build & Verify',
      status: 'blocked',
      currentStepId: 'build',
      currentStepName: 'Implement',
      stepOutput: { content: 'x' },
      params: { feature: 'f' },
    }))
    sessionManager.resumeWorkflow = vi.fn(() => ({ params: { feature: 'f' }, stepOutput: { content: 'x' } }))

    run({ workflowId: 'default', resumeFrom: 'build' })
    await flush()

    // The blocked execution is flipped back to 'running' (reused id)
    expect(sessionManager.resumeWorkflow).toHaveBeenCalledWith(
      'sess-1',
      'exec-1',
      'default',
      'Build & Verify',
      undefined,
    )
    const options = runOrchestratorMock.mock.calls[0]![0]
    expect(options.resumeFromStep).toBe('build')
    expect(options.params).toEqual({ feature: 'f' })
    expect(options.initialStepOutput).toEqual({ content: 'x' })
  })

  it('keeps an explicit verify target when the latest execution is completed', async () => {
    runOrchestratorMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    sessionManager.getLatestWorkflowExecution = vi.fn(() => ({
      id: 'exec-1',
      sessionId: 'sess-1',
      workflowId: 'default',
      workflowName: 'Build & Verify',
      status: 'completed',
      currentStepId: 'finalize',
      currentStepName: 'Finalize',
      stepOutput: { content: 'old' },
      params: { feature: 'old' },
    }))

    run({ workflowId: 'default', resumeFrom: 'verify' })
    await flush()

    const options = runOrchestratorMock.mock.calls[0]![0]
    expect(options.resumeFromStep).toBe('verify')
    expect(options.params).toEqual({ feature: 'old' })
    expect(options.initialStepOutput).toEqual({ content: 'old' })
    expect(sessionManager.resumeWorkflow).not.toHaveBeenCalled()
  })
})
