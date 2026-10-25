import { createHash } from 'node:crypto'
import type { ChatCompletionCreateParamsBase, ChatCompletionCreateParamsNonStreaming } from './openai-types.js'
import { buildResponsesRequest, type ResponsesRequestBody } from './responses-native.js'
import { logger } from '../utils/logger.js'

export interface ResponsesRawDigests {
  d_instr: string
  d_tools: string
  d_text: string
  d_model: string
  d_reasoning: string
  d_first: string
}

export interface RequestInvariantHashes extends Partial<ResponsesRawDigests> {
  invariantHash: string
  firstItemHash: string
}

export interface RequestInvariantLog extends RequestInvariantHashes {
  sessionId?: string
  apiProtocol: 'chat-completions' | 'responses'
  model: string
  reasoningEffort: string | null
}

let reporter: ((data: RequestInvariantLog) => void) | null = null

export function setRequestInvariantReporter(next: ((data: RequestInvariantLog) => void) | null): void {
  reporter = next
}

export function reportRequestInvariantHashes(data: RequestInvariantLog): void {
  if (reporter) reporter(data)
  else logger.debug('LLM request invariant hashes', { ...data })
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  )
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function rawSha256(value: string | undefined): string {
  return createHash('sha256')
    .update(value ?? '')
    .digest('hex')
    .slice(0, 8)
}

export function computeResponsesRequestInvariantHashes(body: ResponsesRequestBody): RequestInvariantHashes {
  return {
    invariantHash: sha256({
      instructions: body.instructions ?? '',
      tools: body.tools ?? [],
      text: body['text'] ?? null,
      model: body.model,
      reasoning: body.reasoning ?? null,
    }),
    firstItemHash: sha256(body.input[0] ?? null),
    d_instr: rawSha256(body.instructions ?? ''),
    d_tools: rawSha256(JSON.stringify(body.tools)),
    d_text: rawSha256(JSON.stringify(body['text'])),
    d_model: rawSha256(body.model),
    d_reasoning: rawSha256(JSON.stringify(body.reasoning)),
    d_first: rawSha256(JSON.stringify(body.input[0])),
  }
}

export function computeRequestInvariantHashes(
  params: ChatCompletionCreateParamsBase,
  apiProtocol: 'chat-completions' | 'responses',
): RequestInvariantHashes {
  if (apiProtocol === 'responses') {
    const body = buildResponsesRequest(params as ChatCompletionCreateParamsNonStreaming)
    return computeResponsesRequestInvariantHashes(body)
  }

  const instructions = params.messages.filter((message) => message.role === 'system' || message.role === 'developer')
  const input = params.messages.filter((message) => message.role !== 'system' && message.role !== 'developer')
  return {
    invariantHash: sha256({
      instructions,
      tools: params.tools ?? [],
      text: params['text'] ?? null,
      model: params.model,
      reasoning: params.reasoning_effort ?? null,
    }),
    firstItemHash: sha256(input[0] ?? null),
  }
}
