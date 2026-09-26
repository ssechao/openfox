import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../src/shared/protocol.js'
import {
  CHARS_PER_TOKEN,
  MIN_TARGET_TOKENS,
  buildProse,
  buildToolOutput,
  buildTurnFrames,
  charsPerTurn,
  checkpointTurnIndices,
  chunkText,
  defaultWorkload,
  estimateTokens,
  percentile,
  slope,
  tokensAfterTurn,
  tokensPerTurn,
  totalTokens,
} from './workload.js'

interface Frame {
  type: string
  payload: Record<string, unknown>
}

function framesOf(frames: ServerMessage[]): Frame[] {
  return frames as unknown as Frame[]
}

function ofType(frames: ServerMessage[], type: string): Frame[] {
  return framesOf(frames).filter((frame) => frame.type === type)
}

describe('workload sizing', () => {
  it('maps characters to tokens the way the app does (chars / 4)', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
    expect(estimateTokens(800_000)).toBe(200_000)
  })

  it('defaults to a 200K token conversation', () => {
    const config = defaultWorkload()
    expect(config.targetTokens).toBe(200_000)
    expect(charsPerTurn(config)).toBe(20_000)
    expect(tokensPerTurn(config)).toBe(5_000)
    expect(totalTokens(config)).toBe(200_000)
  })

  it('scales the target to other sizes', () => {
    const config = defaultWorkload(50_000)
    expect(tokensPerTurn(config)).toBe(1_250)
    expect(totalTokens(config)).toBe(50_000)
    // The per-turn shape compresses proportionally instead of going negative.
    expect(config.toolResultChars).toBe(500)
    expect(config.assistantCharsPerTurn).toBe(1_250)
    expect(config.assistantCharsPerTurn).toBeGreaterThan(0)
  })

  it('rejects targets too small to hold the workload shape', () => {
    expect(() => defaultWorkload(10_000)).toThrow(/at least 20000/)
    expect(defaultWorkload(MIN_TARGET_TOKENS).assistantCharsPerTurn).toBeGreaterThan(0)
  })

  it('grows the conversation monotonically turn after turn', () => {
    const config = defaultWorkload()
    expect(tokensAfterTurn(config, 0)).toBe(5_000)
    expect(tokensAfterTurn(config, 1)).toBe(10_000)
    expect(tokensAfterTurn(config, 39)).toBe(200_000)
  })

  it('samples a checkpoint every checkpointTokens, plus the final turn', () => {
    const config = defaultWorkload()
    const indices = checkpointTurnIndices(config)
    // 5K tokens per turn, checkpoints every 20K → turns 3, 7, 11, ... 39
    expect(indices.slice(0, 4)).toEqual([3, 7, 11, 15])
    expect(indices[indices.length - 1]).toBe(39)
    expect(indices.length).toBe(10)
  })
})

describe('chunkText', () => {
  it('splits text into fixed-size chunks that rejoin losslessly', () => {
    const text = 'x'.repeat(101)
    const chunks = chunkText(text, 40)
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 21])
    expect(chunks.join('')).toBe(text)
  })

  it('returns the whole text when the size is not positive', () => {
    expect(chunkText('abc', 0)).toEqual(['abc'])
  })
})

describe('generated content', () => {
  it('produces prose of exactly the requested length', () => {
    expect(buildProse(3, 1_234)).toHaveLength(1_234)
  })

  it('produces tool output of exactly the requested length', () => {
    expect(buildToolOutput(1, 2, 987)).toHaveLength(987)
  })

  it('is deterministic', () => {
    expect(buildProse(7, 500)).toBe(buildProse(7, 500))
    expect(buildToolOutput(7, 1, 500)).toBe(buildToolOutput(7, 1, 500))
  })
})

describe('buildTurnFrames', () => {
  const config = defaultWorkload()
  const sessionId = 'session-1'
  const frames = buildTurnFrames(sessionId, 0, config)

  it('tags every frame with the session id', () => {
    expect(framesOf(frames).every((frame) => (frame as { sessionId?: string }).sessionId === sessionId)).toBe(true)
  })

  it('opens the turn with a user message and an assistant placeholder', () => {
    const messages = ofType(frames, 'chat.message')
    expect(messages).toHaveLength(2)
    const user = (messages[0]?.payload as { message: { role: string; content: string } }).message
    const assistant = (messages[1]?.payload as { message: { role: string; isStreaming: boolean } }).message
    expect(user.role).toBe('user')
    expect(user.content.length).toBe(config.userCharsPerTurn)
    expect(assistant.role).toBe('assistant')
    expect(assistant.isStreaming).toBe(true)
  })

  it('streams thinking and text as deltas that reconstruct the full content', () => {
    const thinking = ofType(frames, 'chat.thinking').map((f) => (f.payload as { content: string }).content)
    const text = ofType(frames, 'chat.delta').map((f) => (f.payload as { content: string }).content)
    expect(thinking.join('')).toHaveLength(config.thinkingCharsPerTurn)
    expect(text.join('')).toHaveLength(config.assistantCharsPerTurn)
    expect(thinking.length).toBeGreaterThan(1)
    expect(text.length).toBeGreaterThan(1)
  })

  it('declares each tool before calling it, and streams its output before the result', () => {
    const order = framesOf(frames)
      .map((frame) => frame.type)
      .filter((type) => type.startsWith('chat.tool_'))
    expect(order[0]).toBe('chat.tool_preparing')
    for (let toolIndex = 0; toolIndex < config.toolCallsPerTurn; toolIndex++) {
      const callId = `bench-c-0-${toolIndex}`
      const callIndex = framesOf(frames).findIndex(
        (frame) => frame.type === 'chat.tool_call' && (frame.payload as { callId: string }).callId === callId,
      )
      const resultIndex = framesOf(frames).findIndex(
        (frame) => frame.type === 'chat.tool_result' && (frame.payload as { callId: string }).callId === callId,
      )
      expect(callIndex).toBeGreaterThan(-1)
      expect(resultIndex).toBeGreaterThan(callIndex)

      const outputs = framesOf(frames).filter(
        (frame) => frame.type === 'chat.tool_output' && (frame.payload as { callId: string }).callId === callId,
      )
      expect(outputs.length).toBeGreaterThan(1)
      expect(outputs.map((f) => (f.payload as { output: string }).output).join('')).toHaveLength(config.toolResultChars)
    }
  })

  it('ends the turn with chat.done and a context.state matching the turn count', () => {
    const types = framesOf(frames).map((frame) => frame.type)
    expect(types[types.length - 1]).toBe('context.state')
    expect(types[types.length - 2]).toBe('chat.done')
    const last = frames[frames.length - 1]
    const context = (last?.payload as { context: { currentTokens: number } }).context
    expect(context.currentTokens).toBe(tokensAfterTurn(config, 0))
  })

  it('grows the reported context with the turn index', () => {
    const first = buildTurnFrames(sessionId, 0, config)
    const second = buildTurnFrames(sessionId, 1, config)
    const tokensOf = (list: ServerMessage[]) =>
      (list[list.length - 1]?.payload as { context: { currentTokens: number } }).context.currentTokens
    expect(tokensOf(second)).toBeGreaterThan(tokensOf(first))
  })

  it('produces unique message and call ids per turn', () => {
    const ids = new Set<string>()
    for (let turn = 0; turn < 5; turn++) {
      for (const frame of buildTurnFrames(sessionId, turn, config)) {
        const payload = frame.payload as { message?: { id: string }; callId?: string }
        if (payload.message) ids.add(payload.message.id)
        if (payload.callId) ids.add(payload.callId)
      }
    }
    const expected = 5 * (2 + config.toolCallsPerTurn)
    expect(ids.size).toBe(expected)
  })
})

describe('statistics helpers', () => {
  it('computes percentiles', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(percentile(values, 0.95)).toBe(95)
    expect(percentile(values, 1)).toBe(100)
    expect(percentile([], 0.5)).toBe(0)
  })

  it('computes a least-squares slope', () => {
    expect(slope([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(2)
    expect(slope([1, 2, 3], [5, 5, 5])).toBeCloseTo(0)
    expect(slope([1], [5])).toBe(0)
  })
})
