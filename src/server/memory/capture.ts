import { createHash } from 'node:crypto'
import { resolveSharedMemorySettings } from './settings.js'
import { isSharedMemoryAvailable, callSharedMemory } from './shared-memory-client.js'
import type { MemoryCandidate, MemoryExtractor } from './extraction.js'
import { MAX_CANDIDATES_PER_TURN } from './extraction.js'
import {
  enqueueOutboxItem,
  findOutboxItemByDedupKey,
  listPendingOutboxItems,
  markOutboxItemSent,
  markOutboxItemAttemptFailed,
  type OutboxItem,
} from '../db/shared-memory-outbox.js'
import { logger } from '../utils/logger.js'

export function computeCandidateDedupKey(candidate: MemoryCandidate): string {
  const payload = candidate.payload as { type?: string; title?: string; goal?: string; subject?: string }
  const normalized =
    payload.type === 'procedure'
      ? `procedure|${(payload.title ?? '').trim().toLowerCase()}|${(payload.goal ?? '').trim().toLowerCase()}`
      : `fact|${(payload.subject ?? '').trim().toLowerCase()}`
  return createHash('sha256').update(normalized).digest('hex')
}

async function safeExtract(sessionId: string, extractor: MemoryExtractor): Promise<MemoryCandidate[]> {
  try {
    return (await extractor(sessionId)).slice(0, MAX_CANDIDATES_PER_TURN)
  } catch (err) {
    logger.debug('shared memory extraction failed', { sessionId, error: String(err) })
    return []
  }
}

async function trySendOutboxItem(item: OutboxItem): Promise<void> {
  const result = await callSharedMemory('propose', {
    collection: item.collection,
    payload: item.payload,
    tags: item.tags,
    identifiers: item.identifiers,
  })
  if (result.success) {
    markOutboxItemSent(item.id)
  } else {
    markOutboxItemAttemptFailed(item.id, result.error ?? 'unknown error')
  }
}

export interface PostTurnMemoryCaptureOptions {
  projectId: string
  sessionId: string
}

/**
 * Post-turn automatic capture (criterion 5): "automatique avec validation".
 * Extraction is bounded (see MemoryExtractor implementations); the result is
 * placed in a durable local outbox BEFORE any network call, and proposals
 * stay invisible to ordinary search until a human approves them on the
 * Memory portal — this function never calls anything resembling "approve".
 * Pending items from earlier turns (network failure, Memory outage, crash) are
 * retried first, giving idempotent replay after reconnection (criterion 12).
 */
export async function runPostTurnMemoryCapture(
  options: PostTurnMemoryCaptureOptions,
  extractor: MemoryExtractor,
): Promise<void> {
  const settings = resolveSharedMemorySettings(options.projectId, options.sessionId)
  if (!settings.enabled || !settings.captureEnabled) return
  if (!isSharedMemoryAvailable()) return

  try {
    for (const pending of listPendingOutboxItems(options.sessionId)) {
      await trySendOutboxItem(pending)
    }
  } catch (err) {
    logger.debug('shared memory outbox retry failed', { sessionId: options.sessionId, error: String(err) })
  }

  const candidates = await safeExtract(options.sessionId, extractor)
  if (candidates.length === 0) return

  const defaultCollection = settings.collections[0]
  for (const candidate of candidates) {
    const collection = candidate.collection ?? defaultCollection
    if (!collection) continue

    const dedupKey = computeCandidateDedupKey(candidate)
    if (findOutboxItemByDedupKey(options.sessionId, dedupKey)) continue // already queued this session

    const item = enqueueOutboxItem({
      sessionId: options.sessionId,
      projectId: options.projectId,
      collection,
      payload: candidate.payload,
      tags: candidate.tags ?? [],
      identifiers: candidate.identifiers ?? [],
      dedupKey,
    })
    try {
      await trySendOutboxItem(item)
    } catch (err) {
      logger.debug('shared memory propose failed, left pending for retry', {
        sessionId: options.sessionId,
        error: String(err),
      })
    }
  }
}
