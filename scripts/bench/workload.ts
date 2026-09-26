import type { ServerMessage } from '../../src/shared/protocol.js'
import type { Message } from '../../src/shared/types.js'

/**
 * Synthetic conversation workload for the web memory benchmark.
 *
 * Everything here is pure and deterministic: given the same config, the same
 * frames are produced, so two benchmark runs are comparable. Frames are shaped
 * exactly like the ones the server sends over the WebSocket, so the browser
 * exercises its real message handler, session store and React render path.
 */

/** The app's own context accounting is `Math.ceil(chars / 4)`. */
export const CHARS_PER_TOKEN = 4

/** Base timestamp for generated messages — fixed so runs are reproducible. */
export const TURN_BASE_EPOCH_MS = 1_700_000_000_000

const TOOL_NAMES = ['read_file', 'run_command', 'grep', 'edit_file', 'glob', 'write_file'] as const

/** Below this the 40-turn shape can no longer hold its user/thinking/tool split. */
export const MIN_TARGET_TOKENS = 20_000

export interface WorkloadConfig {
  /** Target conversation size in tokens (chars / 4). */
  targetTokens: number
  turns: number
  userCharsPerTurn: number
  assistantCharsPerTurn: number
  thinkingCharsPerTurn: number
  deltaChunkChars: number
  toolCallsPerTurn: number
  toolResultChars: number
  toolOutputChunkChars: number
  toolPreparingChunksPerTool: number
  /** Sample a checkpoint every N tokens of conversation growth. */
  checkpointTokens: number
}

/**
 * Default workload: 40 turns, each sized to hit the target conversation
 * (200K tokens → ~20K chars/turn), with 6 tool calls per turn. Small targets
 * compress the per-turn shape proportionally so nothing goes negative.
 */
export function defaultWorkload(targetTokens = 200_000): WorkloadConfig {
  const turns = 40
  const toolCallsPerTurn = 6
  const perTurnChars = Math.round((targetTokens * CHARS_PER_TOKEN) / turns)
  const toolResultChars = Math.max(40, Math.floor((perTurnChars * 0.6) / toolCallsPerTurn))
  const userCharsPerTurn = Math.min(300, Math.floor(perTurnChars * 0.05))
  const thinkingCharsPerTurn = Math.min(600, Math.floor(perTurnChars * 0.1))
  const assistantCharsPerTurn =
    perTurnChars - userCharsPerTurn - thinkingCharsPerTurn - toolCallsPerTurn * toolResultChars
  if (targetTokens < MIN_TARGET_TOKENS || assistantCharsPerTurn <= 0) {
    throw new Error(
      `Target of ${targetTokens} tokens is too small for ${turns} turns; use at least ${MIN_TARGET_TOKENS} tokens.`,
    )
  }

  return {
    targetTokens,
    turns,
    userCharsPerTurn,
    thinkingCharsPerTurn,
    toolCallsPerTurn,
    toolResultChars,
    assistantCharsPerTurn,
    deltaChunkChars: 40,
    toolOutputChunkChars: 200,
    toolPreparingChunksPerTool: 3,
    checkpointTokens: Math.max(1, Math.round(targetTokens / 10)),
  }
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Characters retained in the conversation after one full turn. */
export function charsPerTurn(config: WorkloadConfig): number {
  return (
    config.userCharsPerTurn +
    config.assistantCharsPerTurn +
    config.thinkingCharsPerTurn +
    config.toolCallsPerTurn * config.toolResultChars
  )
}

export function tokensPerTurn(config: WorkloadConfig): number {
  return estimateTokens(charsPerTurn(config))
}

/** Conversation size (tokens) once turns `0..turnIndex` have completed. */
export function tokensAfterTurn(config: WorkloadConfig, turnIndex: number): number {
  return tokensPerTurn(config) * (turnIndex + 1)
}

export function totalTokens(config: WorkloadConfig): number {
  return tokensAfterTurn(config, config.turns - 1)
}

/** Turn indices at which to sample memory (every `checkpointTokens`, plus the last turn). */
export function checkpointTurnIndices(config: WorkloadConfig): number[] {
  const perTurn = tokensPerTurn(config)
  const indices: number[] = []
  let next = config.checkpointTokens
  for (let turn = 0; turn < config.turns; turn++) {
    if (perTurn * (turn + 1) >= next) {
      indices.push(turn)
      next += config.checkpointTokens
    }
  }
  const last = config.turns - 1
  if (indices[indices.length - 1] !== last) indices.push(last)
  return indices
}

export function chunkText(text: string, size: number): string[] {
  if (size <= 0) return [text]
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

/** Deterministic markdown-ish prose, sized to `chars`. */
export function buildProse(seed: number, chars: number): string {
  const parts: string[] = []
  let length = 0
  let block = 0
  while (length < chars) {
    const text =
      block % 3 === 0
        ? `## Step ${seed}-${block}\n\nReviewing the module surface and every call site before touching it.\n\n`
        : block % 3 === 1
          ? `- item ${block}: verified behaviour of the ${seed} path\n- item ${block + 1}: noted the edge case and its blast radius\n\n`
          : `\`\`\`ts\nexport function compute${block}(input: number): number {\n  return input * ${block + 1}\n}\n\`\`\`\n\n`
    parts.push(text)
    length += text.length
    block++
  }
  return parts.join('').slice(0, chars)
}

/** Deterministic tool output, sized to `chars`. */
export function buildToolOutput(seed: number, toolIndex: number, chars: number): string {
  const parts: string[] = []
  let length = 0
  let line = 0
  while (length < chars) {
    const text = `src/module-${seed}-${toolIndex}.ts:${line}: export const symbol${line} = ${line}\n`
    parts.push(text)
    length += text.length
    line++
  }
  return parts.join('').slice(0, chars)
}

function toolNameFor(toolIndex: number): string {
  return TOOL_NAMES[toolIndex % TOOL_NAMES.length] ?? 'read_file'
}

function toolArgsFor(toolIndex: number, seed: number): Record<string, unknown> {
  const name = toolNameFor(toolIndex)
  if (name === 'run_command') return { command: `npm run bench -- --turn ${seed}` }
  if (name === 'grep') return { pattern: `bench-${seed}`, path: 'src' }
  if (name === 'glob') return { pattern: `src/**/*-${seed}.ts` }
  if (name === 'edit_file') return { path: `src/module-${seed}-${toolIndex}.ts`, oldString: 'a', newString: 'b' }
  if (name === 'write_file') return { path: `src/module-${seed}-${toolIndex}.ts`, content: 'export const x = 1' }
  return { path: `src/module-${seed}-${toolIndex}.ts` }
}

function timestampFor(turnIndex: number, offsetMs: number): string {
  return new Date(TURN_BASE_EPOCH_MS + turnIndex * 60_000 + offsetMs).toISOString()
}

function userMessage(turnIndex: number, config: WorkloadConfig): Message {
  const prefix = `Benchmark turn ${turnIndex}: keep going and report what you find. `
  const filler = 'context '.repeat(Math.ceil(config.userCharsPerTurn / 8) + 1)
  return {
    id: `bench-u-${turnIndex}`,
    role: 'user',
    content: (prefix + filler).slice(0, config.userCharsPerTurn),
    timestamp: timestampFor(turnIndex, 0),
  }
}

function assistantMessage(turnIndex: number): Message {
  return {
    id: `bench-a-${turnIndex}`,
    role: 'assistant',
    content: '',
    isStreaming: true,
    timestamp: timestampFor(turnIndex, 10),
    stats: {
      providerId: 'bench',
      providerName: 'Benchmark',
      backend: 'unknown',
      model: 'bench-model',
      mode: 'builder',
      totalTime: 12,
      toolTime: 5,
      prefillTokens: 5_000,
      prefillSpeed: 420,
      generationTokens: 1_500,
      generationSpeed: 38,
    },
  }
}

function contextStatePayload(turnIndex: number, config: WorkloadConfig): unknown {
  return {
    context: {
      currentTokens: tokensAfterTurn(config, turnIndex),
      maxTokens: Math.max(config.targetTokens, 200_000),
      compactionCount: 0,
      dangerZone: false,
      canCompact: true,
      dynamicContextChanged: false,
    },
  }
}

/**
 * All server frames for one complete turn: user message, assistant placeholder,
 * streamed thinking + text deltas, tool calls with streamed output, tool
 * results, turn completion and the resulting context state.
 */
export function buildTurnFrames(sessionId: string, turnIndex: number, config: WorkloadConfig): ServerMessage[] {
  const frames: ServerMessage[] = []
  const push = (type: ServerMessage['type'], payload: unknown): void => {
    frames.push({ type, payload, sessionId })
  }

  const assistantMessageId = `bench-a-${turnIndex}`
  push('chat.message', { message: userMessage(turnIndex, config) })
  push('chat.message', { message: assistantMessage(turnIndex) })

  const thinking = buildProse(turnIndex * 31 + 7, config.thinkingCharsPerTurn)
  for (const chunk of chunkText(thinking, config.deltaChunkChars)) {
    push('chat.thinking', { messageId: assistantMessageId, content: chunk })
  }

  const body = buildProse(turnIndex, config.assistantCharsPerTurn)
  for (const chunk of chunkText(body, config.deltaChunkChars)) {
    push('chat.delta', { messageId: assistantMessageId, content: chunk })
  }

  for (let toolIndex = 0; toolIndex < config.toolCallsPerTurn; toolIndex++) {
    const callId = `bench-c-${turnIndex}-${toolIndex}`
    const tool = toolNameFor(toolIndex)
    const output = buildToolOutput(turnIndex, toolIndex, config.toolResultChars)

    for (let preparing = 0; preparing < config.toolPreparingChunksPerTool; preparing++) {
      push('chat.tool_preparing', {
        messageId: assistantMessageId,
        index: toolIndex,
        name: tool,
        arguments: JSON.stringify(toolArgsFor(toolIndex, turnIndex)).slice(0, 20 * (preparing + 1)),
      })
    }

    push('chat.tool_call', {
      messageId: assistantMessageId,
      callId,
      tool,
      args: toolArgsFor(toolIndex, turnIndex),
    })

    for (const chunk of chunkText(output, config.toolOutputChunkChars)) {
      push('chat.tool_output', { messageId: assistantMessageId, callId, output: chunk, stream: 'stdout' })
    }

    push('chat.tool_result', {
      messageId: assistantMessageId,
      callId,
      tool,
      result: { success: true, output, durationMs: 14, truncated: false },
    })
  }

  push('chat.done', {
    messageId: assistantMessageId,
    reason: 'complete',
    stats: {
      model: 'bench-model',
      mode: 'builder',
      totalTime: 12,
      toolTime: 5,
      prefillTokens: 5_000,
      prefillSpeed: 420,
      generationTokens: 1_500,
      generationSpeed: 38,
    },
  })

  push('context.state', contextStatePayload(turnIndex, config))
  return frames
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

/** Linear least-squares slope of `values` against `xs` (units: values per x unit). */
export function slope(xs: number[], values: number[]): number {
  const n = Math.min(xs.length, values.length)
  if (n < 2) return 0
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let index = 0; index < n; index++) {
    const x = xs[index] ?? 0
    const y = values[index] ?? 0
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0) return 0
  return (n * sumXY - sumX * sumY) / denominator
}
