import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './openai-types.js'
import { ChatHttpClient, DONE, parseStreamJson, type ChatRequest, type ResponsesChainParams } from './http-shared.js'
import './proxy.js'

export interface HttpClientOptions {
  baseURL: string
  apiKey: string
}

export class OpenAIHttpClient extends ChatHttpClient {
  private baseURL: string
  private apiKey: string

  constructor(options: HttpClientOptions) {
    super()
    this.baseURL = options.baseURL
    this.apiKey = options.apiKey
  }

  protected buildRequest(
    params: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
    _chain?: ResponsesChainParams,
  ): ChatRequest {
    return {
      url: `${this.baseURL}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(params),
    }
  }

  protected parseNonStreaming(data: unknown): ChatCompletionResponse {
    return data as ChatCompletionResponse
  }

  protected parseStreamLine(trimmed: string): ChatCompletionChunk | typeof DONE | null {
    if (!trimmed.startsWith('data: ')) return null

    const data = trimmed.slice(6)
    if (data === '[DONE]') return DONE

    return parseStreamJson<ChatCompletionChunk>(data, 'LLM')
  }
}
