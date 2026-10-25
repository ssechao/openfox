/**
 * Runner Orchestrator
 *
 * Loads the active workflow and delegates to the workflow executor
 * (state machine driven). All events are appended to EventStore.
 */

import type { OrchestratorOptions, OrchestratorResult } from './types.js'
import { logger } from '../utils/logger.js'
import { getRuntimeConfig } from '../runtime-config.js'
import { getGlobalConfigDir } from '../../cli/paths.js'
import {
  loadAllWorkflows,
  loadDefaultWorkflows,
  loadUserWorkflows,
  loadProjectWorkflows,
  findWorkflowById,
  normalizeWorkflowScope,
} from '../workflows/registry.js'
import { executeWorkflow } from '../workflows/executor.js'

/**
 * Run the orchestrator loop until done, blocked, or aborted.
 *
 * Loads the workflow (per-session override or global active) and
 * delegates to the workflow executor state machine. When the launcher
 * specifies an explicit scope, the workflow is resolved from that bucket;
 * otherwise (or when the bucket lacks the workflow) server precedence
 * (project > user > builtin) applies.
 */
export async function runOrchestrator(options: OrchestratorOptions): Promise<OrchestratorResult> {
  const runtimeConfig = getRuntimeConfig()
  const workflowId = options.workflowId ?? runtimeConfig.activeWorkflowId ?? 'default'
  const configDir = getGlobalConfigDir(runtimeConfig.mode ?? 'production')

  // Also load project workflows so project-specific workflows are discoverable
  const session = options.sessionManager.requireSession(options.sessionId)
  const projectDir = session.workdir

  const scope = normalizeWorkflowScope(options.scope)
  let workflow
  if (scope === 'builtin') {
    workflow = findWorkflowById(workflowId, await loadDefaultWorkflows())
  } else if (scope === 'user') {
    workflow = findWorkflowById(workflowId, await loadUserWorkflows(configDir))
  } else if (scope === 'project') {
    workflow = projectDir ? findWorkflowById(workflowId, await loadProjectWorkflows(projectDir)) : undefined
  } else {
    workflow = undefined
  }

  // Fall back to precedence when the explicit bucket has no matching workflow
  if (!workflow) {
    const workflows = await loadAllWorkflows(configDir, projectDir)
    workflow = findWorkflowById(workflowId, workflows)
  }

  if (!workflow) {
    throw new Error(`Workflow "${workflowId}" not found`)
  }

  if (options.resumeFromStep && !workflow.steps.some((step) => step.id === options.resumeFromStep)) {
    throw new Error(`Resume target step "${options.resumeFromStep}" not found in workflow "${workflow.metadata.id}"`)
  }

  // Validate required params
  const requiredParams = (workflow.metadata.parameters ?? []).filter((p) => p.required)
  const suppliedParams = options.params ?? {}
  const missing = requiredParams.filter((p) => !(p.id in suppliedParams))
  if (missing.length > 0) {
    const names = missing.map((p) => p.label || p.id).join(', ')
    throw new Error(`Missing required parameter${missing.length > 1 ? 's' : ''}: ${names}`)
  }

  logger.debug('Using workflow executor', {
    sessionId: options.sessionId,
    workflow: workflow.metadata.id,
    subGroup: options.subGroup,
  })
  return executeWorkflow(workflow, options, options.subGroup)
}
