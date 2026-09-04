// Custom types to replace OpenAI SDK types
// These types mirror the OpenAI API structure but without the SDK dependency

export interface ChatCompletionMessageToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatCompletionMessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content:
    | string
    | null
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'input_audio'; input_audio: { data: string; format: string } }
      >
  tool_call_id?: string
  tool_calls?: ChatCompletionMessageToolCall[]
  reasoning?: string
  reasoning_content?: string
  thinking?: string
}

export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ChatCompletionToolChoiceOption =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export interface ChatCompletionCreateParamsBase {
  model: string
  messages: ChatCompletionMessageParam[]
  tools?: ChatCompletionTool[]
  tool_choice?: ChatCompletionToolChoiceOption
  temperature?: number
  max_tokens?: number
  top_p?: number
  top_k?: number
  stream?: boolean | null
  stream_options?: { include_usage?: boolean } | null
  reasoning_effort?: string
  chat_template_kwargs?: Record<string, unknown>
  [key: string]: unknown
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
  stream?: false | null
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
  stream: true
  stream_options?: { include_usage?: boolean }
}

/**
 * Structured content block used by some APIs (e.g. Mistral with reasoning_effort).
 * Instead of returning content as a plain string, the API returns an array of content blocks.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: Array<{ type: 'text'; text: string }>; closed?: boolean }

export interface ChatCompletionResponse {
  id: string
  choices: Array<{
    finish_reason: string | null
    message: {
      content: string | ContentBlock[] | null
      reasoning_content?: string | null
      reasoning?: string | null
      thinking?: string | null
      tool_calls?: ChatCompletionMessageToolCall[]
    }
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  /** True when the underlying Responses API response reached `completed` status. */
  completed?: boolean
}

export interface ChatCompletionChunk {
  id: string
  choices: Array<{
    delta: {
      content?: string | ContentBlock[] | null
      reasoning_content?: string | null
      reasoning?: string | null
      thinking?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  /** True when the underlying Responses API response reached `completed` status
   *  (a failed/interrupted response leaves this false). */
  completed?: boolean
}
