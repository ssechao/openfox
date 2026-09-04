import type { ToolCall, Attachment } from '../../shared/types.js'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinkingContent?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  attachments?: Attachment[]
}

export interface LLMToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LLMCompletionRequest {
  messages: LLMMessage[]
  tools?: LLMToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  temperature?: number
  maxTokens?: number
  stream?: boolean
  signal?: AbortSignal
  reasoningEffort?: ReasoningEffort
  // User-configured model settings override
  modelSettings?: {
    temperature?: number
    topP?: number
    topK?: number
    maxTokens?: number
    supportsVision?: boolean
    chatTemplateKwargs?: Record<string, unknown>
    queryParams?: Record<string, unknown>
    /** Top-level request body params to strip from outgoing requests. */
    omitParams?: string[]
    /** The model's context window — sent as top-level num_ctx to backends that support it (Ollama). */
    numCtx?: number
  }
  /** When true, include the raw API response body in the result */
  returnRaw?: boolean
  /** Key scoping the Responses-API conversation chain (e.g. session id). When set
   *  and the protocol is `responses`, the client maintains `previous_response_id`
   *  continuity for this key and sends only the delta of new messages. */
  responsesChainKey?: string
  /** When true, the client-level reasoningEffort (from thinkingLevel) is NOT applied.
   *  Used by non-thinking callers (e.g. title generation) that want to opt out. */
  skipClientReasoningEffort?: boolean
}

export interface LLMCompletionResponse {
  id: string
  content: string
  toolCalls?: ToolCall[]
  thinkingContent?: string
  reasoning_content?: string
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** True when the underlying Responses API response reached `completed` status
   *  (a failed/interrupted response leaves this false). */
  completed?: boolean
  /** Raw API response body, only set when returnRaw was requested */
  raw?: string
}

export type LLMStreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'done'; response: LLMCompletionResponse }
  | { type: 'error'; error: string }

export type StreamEvent = LLMStreamEvent

export interface LLMClient {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>
  stream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent>
}
