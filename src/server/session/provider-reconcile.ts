/**
 * Session Provider Reconciliation
 *
 * A session pins the provider it runs on by id. Nothing used to clear that pin when the
 * provider was deleted, so the session kept an id that no longer resolves: the context
 * window silently fell back to the global default (wrong denominator in the UI, which can
 * trip auto-compaction) and the provider badge rendered as remote for a local provider.
 *
 * Clearing the pin puts the session back on the global provider, which is what an unpinned
 * session already does.
 *
 * Heuristic, not a guarantee against partial configs: if NONE of the providers referenced
 * by existing sessions appear in the current configuration, we do not clear any pins.
 * That is the 2026-10-20 incident (a development config with one unknown provider pointed
 * at a production database and wiped 72 session pins). Isolated orphans are still repaired
 * when at least one session pin matches a configured provider. Explicit deletion via
 * clearSessionsForDeletedProvider is unchanged. A database with no pinned providers is a
 * no-op and does not log.
 */

import { listSessions, updateSessionProvider } from '../db/sessions.js'
import { logger } from '../utils/logger.js'

function clearSessionProviderWhere(isDangling: (providerId: string) => boolean): number {
  let cleared = 0
  for (const session of listSessions()) {
    if (session.providerId && isDangling(session.providerId)) {
      updateSessionProvider(session.id, null, null)
      cleared++
    }
  }
  return cleared
}

/**
 * Clear the provider pin of every session that referenced a provider being deleted.
 * Returns how many sessions were cleared.
 */
export function clearSessionsForDeletedProvider(providerId: string): number {
  return clearSessionProviderWhere((pinned) => pinned === providerId)
}

/**
 * Clear provider pins that no longer match a configured provider. Runs at startup to repair
 * sessions orphaned before the delete cascade existed, or by a hand-edited config.
 * Returns how many sessions were repaired.
 */
export function reconcileSessionProviders(configuredProviderIds: readonly string[]): number {
  const sessions = listSessions()
  const pinned = sessions.filter((session) => session.providerId != null)
  if (pinned.length === 0) {
    return 0
  }

  const configured = new Set(configuredProviderIds)
  const recognized = pinned.filter((session) => configured.has(session.providerId!))
  if (recognized.length === 0) {
    logger.error(
      'Provider reconciliation skipped: none of the session-pinned providers are in the current configuration. Leaving session pins intact.',
      { sessions: pinned.length, configuredProviders: configuredProviderIds.length },
    )
    return 0
  }

  return clearSessionProviderWhere((id) => !configured.has(id))
}
