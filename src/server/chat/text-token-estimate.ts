import { createRequire } from 'node:module'
import type { Tiktoken, TiktokenBPE } from 'js-tiktoken/lite'

const require = createRequire(import.meta.url)

const CHUNK_CHARS = 2048
const MAX_CACHED_CHUNKS = 512
const counts = new Map<string, number>()
let encoder: Tiktoken | undefined

/** Local estimate, NOT provider usage. Unknown tokenizers keep the UTF-8 bound. */
export function estimateTextTokens(text: string, model?: string): number {
  if (!/^gpt-(?:5|6)(?:[.-]|$)/i.test(model ?? '')) return Buffer.byteLength(text, 'utf8')
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
  return Math.ceil(tokens * 1.25)
}
