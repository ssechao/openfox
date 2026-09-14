import type { SharedMemorySettings } from '../../shared/types.js'
import { getProject } from '../db/projects.js'
import { getSessionSharedMemoryOverride } from '../db/sessions.js'

/** Off by default: an operator must opt a project into shared memory. */
export const DEFAULT_SHARED_MEMORY_SETTINGS: Required<SharedMemorySettings> = {
  enabled: false,
  collections: [],
  captureEnabled: true,
  retrievalEnabled: true,
}

function mergeSettings(
  base: Required<SharedMemorySettings>,
  override?: SharedMemorySettings | null,
): Required<SharedMemorySettings> {
  if (!override) return base
  return {
    enabled: override.enabled ?? base.enabled,
    collections: override.collections ?? base.collections,
    captureEnabled: override.captureEnabled ?? base.captureEnabled,
    retrievalEnabled: override.retrievalEnabled ?? base.retrievalEnabled,
  }
}

/**
 * Resolve effective settings: DEFAULT -> project.sharedMemorySettings ->
 * session.sharedMemoryOverride, each layer only overriding the fields it
 * sets (criterion 8: "activation, collections, capture/récupération par
 * projet/session").
 */
export function resolveSharedMemorySettings(projectId: string, sessionId?: string): Required<SharedMemorySettings> {
  const project = getProject(projectId)
  const withProject = mergeSettings(DEFAULT_SHARED_MEMORY_SETTINGS, project?.sharedMemorySettings)
  if (!sessionId) return withProject
  const sessionOverride = getSessionSharedMemoryOverride(sessionId)
  return mergeSettings(withProject, sessionOverride)
}
