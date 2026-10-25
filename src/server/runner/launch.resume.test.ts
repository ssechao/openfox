import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.js'
import type { WorkflowExecutionStatus } from '../../shared/types.js'
import type { WorkflowLaunchPayload } from './launch.js'

const executeWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock('../workflows/executor.js', () => ({
  executeWorkflow: executeWorkflowMock,
}))

import { launchWorkflowRun } from './launch.js'
import { getSessionRuntimeRegistry, resetSessionRuntimeRegistry } from '../session/index.js'

describe('launchWorkflowRun resume targets', () => {
  let status: WorkflowExecutionStatus
  let executionParams: Record<string, string>
  let executionStepOutput: Record<string, string>
  let executionWorkflowId: string
  let executionWorkflowName: string
  let workdir: string | undefined
  let sessionManager: {
    setRunning: ReturnType<typeof vi.fn>
    requireSession: ReturnType<typeof vi.fn>
    getLatestWorkflowExecution: ReturnType<typeof vi.fn>
    resumeWorkflow: ReturnType<typeof vi.fn>
    blockWorkflow: ReturnType<typeof vi.fn>
  }
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetSessionRuntimeRegistry()
    executeWorkflowMock.mockReset()
    executeWorkflowMock.mockResolvedValue({ finalAction: { type: 'DONE' }, iterations: 1, totalTime: 1 })
    status = 'blocked'
    executionParams = {}
    executionStepOutput = { build: 'done' }
    executionWorkflowId = 'default'
    executionWorkflowName = 'Default'
    workdir = undefined
    sessionManager = {
      setRunning: vi.fn(),
      requireSession: vi.fn(() => ({ workdir })),
      getLatestWorkflowExecution: vi.fn(() => ({
        id: 'exec-1',
        sessionId: 'sess-1',
        workflowId: executionWorkflowId,
        workflowName: executionWorkflowName,
        status,
        currentStepId: 'build',
        currentStepName: 'Build',
        stepOutput: executionStepOutput,
        params: executionParams,
        createdAt: 1,
        updatedAt: 1,
      })),
      resumeWorkflow: vi.fn(() => {
        status = 'running'
        return { params: executionParams, stepOutput: executionStepOutput }
      }),
      blockWorkflow: vi.fn(() => {
        status = 'blocked'
      }),
    }
    broadcast = vi.fn()
  })

  afterEach(() => {
    resetSessionRuntimeRegistry()
    vi.restoreAllMocks()
  })

  const run = (payload: WorkflowLaunchPayload) =>
    launchWorkflowRun(
      {
        sessionManager: sessionManager as never,
        sessionId: 'sess-1',
        runtimeHandle: getSessionRuntimeRegistry().get('sess-1').acquire('workflow'),
        llmClient: { getModel: () => 'm', getBackend: () => 'openai' } as never,
        statsIdentity: { providerId: 'p', providerName: 'pn', backend: 'openai', model: 'm' },
        broadcastForSession: broadcast as never,
      },
      payload,
    )

  const errorMessage = () =>
    (
      broadcast.mock.calls.find(([, message]) => (message as ServerMessage).type === 'chat.error')?.[1] as
        ServerMessage<{ error: string }> | undefined
    )?.payload.error

  it.each(['verify', 'code_review'])('honors the explicit %s target over the blocked build step', async (target) => {
    await run({ workflowId: 'default', scope: 'builtin', resumeFrom: target })

    expect(executeWorkflowMock).toHaveBeenCalledOnce()
    expect(executeWorkflowMock.mock.calls[0]![1].resumeFromStep).toBe(target)
  })

  it('rejects an unknown explicit target without launching or leaving the execution reactivated', async () => {
    await run({ workflowId: 'default', scope: 'builtin', resumeFrom: 'missing-step' })

    expect(executeWorkflowMock).not.toHaveBeenCalled()
    expect(status).toBe('blocked')
    expect(errorMessage()).toContain('Resume target step "missing-step" not found')
  })

  it.each(['completed', 'cancelled'] as const)(
    'restores params and step output from a %s execution',
    async (terminalStatus) => {
      status = terminalStatus
      executionParams = { feature: 'saved' }
      executionStepOutput = { content: 'saved output' }

      await run({ workflowId: 'default', scope: 'builtin', resumeFrom: 'verify' })

      expect(sessionManager.resumeWorkflow).not.toHaveBeenCalled()
      expect(executeWorkflowMock).toHaveBeenCalledOnce()
      expect(executeWorkflowMock.mock.calls[0]![1]).toMatchObject({
        params: executionParams,
        initialStepOutput: executionStepOutput,
        resumeFromStep: 'verify',
      })
    },
  )

  it('asks for missing required params instead of launching a completed execution empty', async () => {
    status = 'completed'
    executionWorkflowId = 'review'
    executionWorkflowName = 'PR Review'
    executionParams = {}
    workdir = process.cwd()

    await run({ workflowId: 'review', scope: 'project', resumeFrom: 'setup' })

    expect(executeWorkflowMock).not.toHaveBeenCalled()
    expect(errorMessage()).toContain('Please provide the required workflow parameter before launching: PR Number')
  })

  it('merges newly supplied required params into the completed execution', async () => {
    status = 'completed'
    executionWorkflowId = 'review'
    executionWorkflowName = 'PR Review'
    executionParams = { retained: 'value' }
    workdir = process.cwd()

    await run({
      workflowId: 'review',
      scope: 'project',
      resumeFrom: 'setup',
      params: { pr_number: '42' },
    })

    expect(executeWorkflowMock).toHaveBeenCalledOnce()
    expect(executeWorkflowMock.mock.calls[0]![1].params).toEqual({ retained: 'value', pr_number: '42' })
  })
})
