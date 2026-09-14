import { getConversationMessages } from '../chat/conversation-history.js'
import type { LLMClientWithModel } from '../llm/client.js'

export interface MemoryCandidate {
  collection?: string
  payload: Record<string, unknown>
  tags?: string[]
  identifiers?: string[]
}

export type MemoryExtractor = (sessionId: string) => Promise<MemoryCandidate[]>

export const MAX_CANDIDATES_PER_TURN = 3
const MAX_TRANSCRIPT_CHARS = 8000
const MAX_MESSAGES = 20
const EXTRACTION_TIMEOUT_MS = 8000

const EXTRACTION_SYSTEM_PROMPT = `You extract durable, reusable knowledge from a coding-agent conversation excerpt, for a shared team memory used by OTHER sessions later.

Output ONLY a JSON array, nothing else. Maximum 3 items. Output [] if nothing durable/reusable was established in this excerpt (most turns should yield nothing).

Each item is one of:
- {"type":"procedure","title":string,"goal":string,"prerequisites":string[],"variables":[{"name":string,"description":string}],"steps":string[],"verifications":string[],"rollback":string[],"risks":string[]}
- {"type":"fact","subject":string,"facts":[{"key":string,"value":string}],"constraints":string[]}

Each item also has: "collection" (a short slug like "ops" or "infra"), optional "tags": string[], optional "identifiers": string[] (exact hostnames/machine names/service names worth boosting in search).

Rules:
- NEVER include secrets, API keys, passwords, tokens, or private keys.
- Only extract knowledge that is durable and reusable ACROSS sessions (deployment procedures, machine roles/constraints, naming conventions) — not one-off session details.
- If in doubt, output [].`

function buildTranscript(sessionId: string): string {
  const messages = getConversationMessages({ type: 'toplevel', sessionId })
  const recent = messages.slice(-MAX_MESSAGES)
  const text = recent.map((m) => `${m.role}: ${m.content}`).join('\n')
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text
}

function isValidCandidate(value: unknown): value is MemoryCandidate {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  const payload = obj['payload'] ?? obj // tolerate the model emitting the payload fields at the top level
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (p['type'] === 'procedure') {
    return typeof p['title'] === 'string' && typeof p['goal'] === 'string' && Array.isArray(p['steps'])
  }
  if (p['type'] === 'fact') {
    return typeof p['subject'] === 'string' && Array.isArray(p['facts'])
  }
  return false
}

function toCandidate(raw: Record<string, unknown>): MemoryCandidate | null {
  const payload = (raw['payload'] as Record<string, unknown> | undefined) ?? raw
  if (!isValidCandidate({ payload })) return null
  const candidate: MemoryCandidate = { payload }
  if (typeof raw['collection'] === 'string') candidate.collection = raw['collection']
  if (Array.isArray(raw['tags'])) candidate.tags = raw['tags'].filter((t): t is string => typeof t === 'string')
  if (Array.isArray(raw['identifiers'])) {
    candidate.identifiers = raw['identifiers'].filter((t): t is string => typeof t === 'string')
  }
  return candidate
}

/** Tolerant of a model wrapping the array in prose/markdown fences. */
export function parseExtractionResponse(text: string): MemoryCandidate[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: MemoryCandidate[] = []
  for (const item of raw.slice(0, MAX_CANDIDATES_PER_TURN)) {
    if (item && typeof item === 'object') {
      const candidate = toCandidate(item as Record<string, unknown>)
      if (candidate) out.push(candidate)
    }
  }
  return out
}

/**
 * Real (LLM-based) extractor, bounded by transcript size, item count and a
 * hard timeout. Any failure (timeout, malformed JSON, provider error) yields
 * zero candidates rather than throwing — extraction must never break or
 * delay a turn (criterion 5: "de façon bornée zéro ou plusieurs").
 */
export function createLlmMemoryExtractor(llmClient: LLMClientWithModel): MemoryExtractor {
  return async (sessionId: string) => {
    const transcript = buildTranscript(sessionId)
    if (transcript.trim() === '') return []

    try {
      const response = await llmClient.complete({
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        temperature: 0,
        maxTokens: 1200,
        signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
      })
      return parseExtractionResponse(response.content)
    } catch {
      return []
    }
  }
}
