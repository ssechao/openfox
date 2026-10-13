import { createRequire } from 'node:module'
import type { Tiktoken, TiktokenBPE } from 'js-tiktoken/lite'

const require = createRequire(import.meta.url)

const CHUNK_CHARS = 2048
const MAX_CACHED_CHUNKS = 512
const counts = new Map<string, number>()
let encoder: Tiktoken | undefined

/** The families whose vocabulary is bundled locally. */
const BUNDLED_TOKENIZER_MODEL = /^gpt-(?:5|6)(?:[.-]|$)/i

/** Latin-script approximation, matching the chars-per-token rule used elsewhere. */
const LATIN_CHARS_PER_TOKEN = 4

/**
 * A local estimate is a proxy, never the provider's count: keep the same 25%
 * margin for both paths so neither can drift below the real usage.
 */
const ESTIMATE_MARGIN = 1.25

/**
 * Local estimate, NOT provider usage.
 *
 * Models with a bundled vocabulary are counted with the tokenizer. Everything
 * else is estimated from the text's own shape: Latin characters cost ~1/4 token
 * each, every non-Latin character costs ~1 token. Returning the UTF-8 byte
 * length instead — what this used to do — over-counted Latin text ~4x and CJK
 * ~3x, which fires compaction (and used to fail the summary request outright)
 * long before the context window is actually full.
 */
export function estimateTextTokens(text: string, model?: string): number {
  if (!BUNDLED_TOKENIZER_MODEL.test(model ?? '')) return estimateWithoutTokenizer(text)
  if (!encoder) {
    // Most turns have real usage and need no tokenizer at all. Load the single
    // bundled vocabulary lazily, never fetch ranks or load every encoding.
    const { Tiktoken: Encoder } = require('js-tiktoken/lite') as typeof import('js-tiktoken/lite')
    encoder = new Encoder(require('js-tiktoken/ranks/o200k_base') as TiktokenBPE)
  }
  let tokens = 0
  // Bound BPE work per segment, including hostile long unbroken strings. The
  // cache is bounded and contains only local text; nothing is sent to an API.
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + CHUNK_CHARS)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    const chunk = text.slice(offset, end)
    let count = counts.get(chunk)
    if (count === undefined) {
      // Special-token-looking user text is ordinary text, never an instruction
      // to the tokenizer and never a reason to throw during preflight.
      count = encoder.encode(chunk, [], []).length
      if (counts.size >= MAX_CACHED_CHUNKS) counts.delete(counts.keys().next().value!)
    } else {
      counts.delete(chunk)
    }
    counts.set(chunk, count)
    tokens += count
    offset = end
  }
  // o200k is a local proxy for the selected GPT family, not a guarantee about
  // a provider alias's tokenizer/framing. Keep a 25% margin; usage stays Unknown.
  return Math.ceil(tokens * ESTIMATE_MARGIN)
}

/**
 * Tokenizer-free estimate for the models whose vocabulary is not bundled.
 *
 * Counting non-Latin characters individually keeps dense scripts (CJK, emoji,
 * which are the expensive ones per character) from being discounted, while
 * Latin text is no longer charged one token per byte.
 */
function estimateWithoutTokenizer(text: string): number {
  if (text.length === 0) return 0
  let nonLatin = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) nonLatin += 1
  }
  const latin = text.length - nonLatin
  return Math.ceil((latin / LATIN_CHARS_PER_TOKEN + nonLatin) * ESTIMATE_MARGIN)
}
