import { getProject } from '../db/projects.js'
import { getSessionRemoteAgentTarget } from '../db/sessions.js'

/**
 * Resolve the effective remote-agent target for a session.
 *
 * Precedence (each layer only applies when it is SET):
 *   1. the explicit per-call `remote` argument (handled by the dispatcher),
 *   2. the session pin (`sessions.remote_agent_target`),
 *   3. the project default (`projects.remote_agent_target`).
 *
 * `null` means "nothing pinned" → execute locally. An **empty string** is a
 * meaningful pin meaning "force local", so it deliberately short-circuits the
 * project default (a session can opt out of a project-wide remote target).
 */
export function resolveRemoteAgentTarget(projectId: string, sessionId?: string): string | null {
  if (sessionId) {
    const sessionTarget = getSessionRemoteAgentTarget(sessionId)
    if (sessionTarget !== null) return sessionTarget
  }
  const project = getProject(projectId)
  return project?.remoteAgentTarget ?? null
}

/**
 * Normalize a resolved target into a routing decision: a non-empty trimmed
 * string routes remotely, anything else (null or empty) executes locally.
 */
export function normalizeRemoteTarget(target: string | null | undefined): string | null {
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  return trimmed.length > 0 ? trimmed : null
}
