/**
 * Runner Orchestrator Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrchestratorOptions } from './types.js'

// Mock all dependencies
vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn(() => ({
    mode: 'production',
    activeWorkflowId: undefined,
    agent: { toolTimeout: 120000 },
  })),
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/mock/config'),
}))

vi.mock('../workflows/registry.js', () => ({
  loadAllWorkflows: vi.fn(async () => []),
  loadDefaultWorkflows: vi.fn(async () => []),
  loadUserWorkflows: vi.fn(async () => []),
  loadProjectWorkflows: vi.fn(async () => []),
  findWorkflowById: vi.fn(),
  normalizeWorkflowScope: vi.fn((value: unknown) =>
    typeof value === 'string' && ['auto', 'builtin', 'user', 'project'].includes(value) ? value : 'auto',
  ),
}))

vi.mock('../workflows/executor.js', () => ({
  executeWorkflow: vi.fn(async () => ({
    finalAction: { type: 'DONE' },
    iterations: 1,
    totalTime: 100,
  })),
}))

import { runOrchestrator } from './orchestrator.js'
import { getRuntimeConfig } from '../runtime-config.js'
import {
  loadAllWorkflows,
  loadDefaultWorkflows,
  loadUserWorkflows,
  loadProjectWorkflows,
  findWorkflowById,
  normalizeWorkflowScope,
} from '../workflows/registry.js'
import { executeWorkflow } from '../workflows/executor.js'

const mockOptions: OrchestratorOptions = {
  sessionManager: {
    requireSession: vi.fn(() => ({ workdir: '/mock/project' })),
  } as any,
  sessionId: 'test-session',
  llmClient: {} as any,
  scope: 'auto',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runOrchestrator', () => {
  it('should throw when workflow is not found', async () => {
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator(mockOptions)).rejects.toThrow('Workflow "default" not found')
  })

  it('should use "default" workflow ID when none specified', async () => {
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator(mockOptions)).rejects.toThrow('Workflow "default" not found')
    expect(findWorkflowById).toHaveBeenCalledWith('default', [])
  })

  it('should use options.workflowId when provided', async () => {
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator({ ...mockOptions, workflowId: 'custom' })).rejects.toThrow(
      'Workflow "custom" not found',
    )
    expect(findWorkflowById).toHaveBeenCalledWith('custom', [])
  })

  it('should use runtime config activeWorkflowId as fallback', async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      activeWorkflowId: 'from-config',
    } as any)
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator(mockOptions)).rejects.toThrow('Workflow "from-config" not found')
    expect(findWorkflowById).toHaveBeenCalledWith('from-config', [])
  })

  it('should delegate to executeWorkflow when workflow is found', async () => {
    const mockWorkflow = {
      metadata: { id: 'default', name: 'Default', description: '', version: '1' },
      entryStep: 'build',
      settings: { maxIterations: 50 },
      steps: [
        {
          id: 'build',
          name: 'Build',
          type: 'agent' as const,
          phase: 'build',
          transitions: [],
        },
      ],
    }

    vi.mocked(loadAllWorkflows).mockResolvedValue([mockWorkflow])
    vi.mocked(findWorkflowById).mockReturnValue(mockWorkflow)

    const result = await runOrchestrator(mockOptions)

    expect(executeWorkflow).toHaveBeenCalledWith(mockWorkflow, mockOptions, undefined)
    expect(result.finalAction.type).toBe('DONE')
    expect(result.iterations).toBe(1)
  })

  it('rejects an explicit resume target that does not exist in the resolved workflow', async () => {
    const mockWorkflow = {
      metadata: { id: 'custom', name: 'Custom', description: '', version: '1' },
      entryStep: 'build',
      settings: { maxIterations: 50 },
      steps: [
        {
          id: 'build',
          name: 'Build',
          type: 'agent' as const,
          phase: 'build',
          transitions: [],
        },
      ],
    }
    vi.mocked(loadAllWorkflows).mockResolvedValue([mockWorkflow])
    vi.mocked(findWorkflowById).mockReturnValue(mockWorkflow)

    await expect(runOrchestrator({ ...mockOptions, workflowId: 'custom', resumeFromStep: 'verify' })).rejects.toThrow(
      'Resume target step "verify" not found in workflow "custom"',
    )
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('should prefer options.workflowId over runtime config', async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      activeWorkflowId: 'config-wf',
    } as any)
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator({ ...mockOptions, workflowId: 'override' })).rejects.toThrow(
      'Workflow "override" not found',
    )
    expect(findWorkflowById).toHaveBeenCalledWith('override', [])
  })

  it('resolves from the user bucket when scope is "user"', async () => {
    const userWorkflow = { metadata: { id: 'review', name: 'Global Review', description: '', version: '1' } }
    vi.mocked(loadUserWorkflows).mockResolvedValue([userWorkflow as never])
    vi.mocked(findWorkflowById).mockReturnValue(userWorkflow as never)

    await runOrchestrator({ ...mockOptions, workflowId: 'review', scope: 'user' })

    expect(loadUserWorkflows).toHaveBeenCalledWith('/mock/config')
    expect(findWorkflowById).toHaveBeenCalledWith('review', [userWorkflow])
    expect(loadAllWorkflows).not.toHaveBeenCalled()
    expect(executeWorkflow).toHaveBeenCalledWith(userWorkflow, expect.anything(), undefined)
  })

  it('resolves from the project bucket when scope is "project"', async () => {
    const projectWorkflow = { metadata: { id: 'review', name: 'Project Review', description: '', version: '1' } }
    vi.mocked(loadProjectWorkflows).mockResolvedValue([projectWorkflow as never])
    vi.mocked(findWorkflowById).mockReturnValue(projectWorkflow as never)

    await runOrchestrator({ ...mockOptions, workflowId: 'review', scope: 'project' })

    expect(loadProjectWorkflows).toHaveBeenCalledWith('/mock/project')
    expect(loadAllWorkflows).not.toHaveBeenCalled()
    expect(executeWorkflow).toHaveBeenCalledWith(projectWorkflow, expect.anything(), undefined)
  })

  it('resolves from the builtin bucket when scope is "builtin"', async () => {
    const builtinWorkflow = { metadata: { id: 'review', name: 'Built-in Review', description: '', version: '1' } }
    vi.mocked(loadDefaultWorkflows).mockResolvedValue([builtinWorkflow as never])
    vi.mocked(findWorkflowById).mockReturnValue(builtinWorkflow as never)

    await runOrchestrator({ ...mockOptions, workflowId: 'review', scope: 'builtin' })

    expect(loadDefaultWorkflows).toHaveBeenCalled()
    expect(loadAllWorkflows).not.toHaveBeenCalled()
    expect(executeWorkflow).toHaveBeenCalledWith(builtinWorkflow, expect.anything(), undefined)
  })

  it('falls back to precedence when the requested scope lacks the workflow', async () => {
    const effectiveWorkflow = { metadata: { id: 'review', name: 'Project Review', description: '', version: '1' } }
    vi.mocked(loadUserWorkflows).mockResolvedValue([])
    vi.mocked(loadAllWorkflows).mockResolvedValue([effectiveWorkflow as never])
    vi.mocked(findWorkflowById).mockImplementation((_id, items) =>
      items.length > 0 ? (effectiveWorkflow as never) : undefined,
    )

    const result = await runOrchestrator({ ...mockOptions, workflowId: 'review', scope: 'user' })

    expect(loadAllWorkflows).toHaveBeenCalledWith('/mock/config', '/mock/project')
    expect(executeWorkflow).toHaveBeenCalledWith(effectiveWorkflow, expect.anything(), undefined)
    expect(result.finalAction.type).toBe('DONE')
  })

  it('throws when neither the scope bucket nor precedence finds the workflow', async () => {
    vi.mocked(loadUserWorkflows).mockResolvedValue([])
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator({ ...mockOptions, workflowId: 'missing', scope: 'user' })).rejects.toThrow(
      'Workflow "missing" not found',
    )
  })

  it('normalizes an unknown scope to auto', async () => {
    vi.mocked(normalizeWorkflowScope).mockReturnValue('auto')
    vi.mocked(loadAllWorkflows).mockResolvedValue([])
    vi.mocked(findWorkflowById).mockReturnValue(undefined)

    await expect(runOrchestrator({ ...mockOptions, workflowId: 'default', scope: 'system' as never })).rejects.toThrow(
      'Workflow "default" not found',
    )
    expect(loadUserWorkflows).not.toHaveBeenCalled()
    expect(loadAllWorkflows).toHaveBeenCalled()
  })
})
