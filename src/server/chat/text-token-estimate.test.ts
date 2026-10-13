import { describe, it, expect } from 'vitest'
import { estimateTextTokens } from './text-token-estimate.js'

const NON_GPT = 'deepseek-v4.1-flash'

describe('estimateTextTokens without a local tokenizer', () => {
  it('estimates Latin text by characters, not by UTF-8 bytes', () => {
    const text = 'a'.repeat(4_000)
    const bytes = Buffer.byteLength(text, 'utf8')

    // ~4 chars per token plus the 25% safety margin — NOT one token per byte.
    expect(estimateTextTokens(text, NON_GPT)).toBe(1_250)
    expect(estimateTextTokens(text, NON_GPT)).toBeLessThan(bytes)
  })

  it('keeps the same estimate when no model is given', () => {
    const text = 'a'.repeat(4_000)
    expect(estimateTextTokens(text, undefined)).toBe(estimateTextTokens(text, NON_GPT))
  })

  it('counts each non-Latin character as a token instead of a byte', () => {
    const text = '漢'.repeat(1_000)
    const bytes = Buffer.byteLength(text, 'utf8')

    // Three bytes per character: the byte bound used to triple the estimate.
    expect(bytes).toBe(3_000)
    expect(estimateTextTokens(text, NON_GPT)).toBe(1_250)
    expect(estimateTextTokens(text, NON_GPT)).toBeLessThan(bytes)
  })

  it('never discounts dense Unicode below one token per code unit', () => {
    const text = '漢字🙂'.repeat(100)
    const estimate = estimateTextTokens(text, NON_GPT)

    expect(estimate).toBeGreaterThanOrEqual(text.length)
    expect(estimate).toBeLessThan(Buffer.byteLength(text, 'utf8'))
  })

  it('returns zero for empty text', () => {
    expect(estimateTextTokens('', NON_GPT)).toBe(0)
    expect(estimateTextTokens('', 'gpt-5.6-sol')).toBe(0)
  })

  it('grows with the text', () => {
    const short = estimateTextTokens('const total = rows.reduce((sum, row) => sum + row.amount, 0)', NON_GPT)
    const long = estimateTextTokens('const total = rows.reduce((sum, row) => sum + row.amount, 0)'.repeat(50), NON_GPT)
    expect(long).toBeGreaterThan(short)
  })
})

describe('estimateTextTokens with the bundled GPT tokenizer', () => {
  it('keeps using the tokenizer for the GPT-5/GPT-6 families', () => {
    const text = 'hello world'
    const estimate = estimateTextTokens(text, 'gpt-5.6-sol')

    expect(estimate).toBeGreaterThan(0)
    // The tokenizer sees two tokens; a byte count would be 11.
    expect(estimate).toBeLessThan(Buffer.byteLength(text, 'utf8'))
    expect(estimateTextTokens(text, 'gpt-6-astra')).toBe(estimate)
  })

  it('does not route provider aliases outside the GPT families to the tokenizer', () => {
    const text = 'a'.repeat(400)
    expect(estimateTextTokens(text, 'claude-opus-5')).toBeLessThan(Buffer.byteLength(text, 'utf8'))
    expect(estimateTextTokens(text, 'gpt-4o')).toBeLessThan(Buffer.byteLength(text, 'utf8'))
  })
})
