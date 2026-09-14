import { describe, it, expect, vi } from 'vitest'
import { parseExtractionResponse, createLlmMemoryExtractor } from './extraction.js'

vi.mock('../chat/conversation-history.js', () => ({
  getConversationMessages: () => [
    { role: 'user', content: 'How do I deploy to host X?' },
    { role: 'assistant', content: 'Build the image, push it, restart the container.' },
  ],
}))

describe('parseExtractionResponse', () => {
  it('parses a clean JSON array', () => {
    const text = JSON.stringify([
      { type: 'fact', collection: 'ops', subject: 'host X', facts: [{ key: 'role', value: 'web' }] },
    ])
    const candidates = parseExtractionResponse(text)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.collection).toBe('ops')
    expect((candidates[0]?.payload as any).subject).toBe('host X')
  })

  it('tolerates prose/markdown fences around the array', () => {
    const text =
      'Sure, here is the JSON:\n```json\n[{"type":"fact","subject":"s","facts":[{"key":"k","value":"v"}]}]\n```\nDone.'
    const candidates = parseExtractionResponse(text)
    expect(candidates).toHaveLength(1)
  })

  it('returns [] for an empty array response (the common case)', () => {
    expect(parseExtractionResponse('[]')).toEqual([])
  })

  it('returns [] for malformed JSON instead of throwing', () => {
    expect(parseExtractionResponse('not json at all')).toEqual([])
  })

  it('drops items missing required procedure fields', () => {
    const text = JSON.stringify([{ type: 'procedure', title: 'x' }]) // missing goal/steps
    expect(parseExtractionResponse(text)).toEqual([])
  })

  it('caps the number of candidates at MAX_CANDIDATES_PER_TURN', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      type: 'fact',
      subject: `s${i}`,
      facts: [{ key: 'k', value: 'v' }],
    }))
    expect(parseExtractionResponse(JSON.stringify(items))).toHaveLength(3)
  })

  it('never returns a candidate carrying an obvious secret without at least surfacing it as data (extraction does not redact — propose-time scanning does)', () => {
    // Extraction only structures candidates; the actual secret refusal
    // happens server-side (Memory's scanForSecrets) before storage. This
    // test documents that boundary rather than re-implementing scanning here.
    const text = JSON.stringify([{ type: 'fact', subject: 's', facts: [{ key: 'token', value: 'not-a-real-secret' }] }])
    expect(parseExtractionResponse(text)).toHaveLength(1)
  })
})

describe('createLlmMemoryExtractor', () => {
  it('sends a bounded system prompt and the recent transcript, and parses the response', async () => {
    const complete = vi.fn(async (_request: { messages: Array<{ role: string; content: string }> }) => ({
      id: '1',
      content: '[{"type":"fact","collection":"ops","subject":"host X","facts":[{"key":"role","value":"web"}]}]',
      finishReason: 'stop' as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }))
    const fakeClient = { complete } as any
    const extractor = createLlmMemoryExtractor(fakeClient)
    const candidates = await extractor('session-1')
    expect(candidates).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> }
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[1]?.content).toContain('deploy to host X')
  })

  it('returns [] instead of throwing when the LLM call fails', async () => {
    const fakeClient = {
      complete: vi.fn(async () => {
        throw new Error('provider down')
      }),
    } as any
    const extractor = createLlmMemoryExtractor(fakeClient)
    await expect(extractor('session-1')).resolves.toEqual([])
  })
})
