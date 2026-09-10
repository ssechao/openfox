import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildNonStreamingCreateParams, buildStreamingCreateParams, convertMessages } from './client-pure.js'
import { getModelProfile, modelSupportsVision } from './profiles.js'
import { OpenAIHttpClient } from './http-client.js'
import type { LLMMessage } from './types.js'
import type { Attachment } from '../../shared/types.js'

describe('user vision override', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeAttachment(): Attachment {
    return {
      id: 'a1',
      filename: 'test.png',
      mimeType: 'image/png',
      size: 100,
      data: 'abc',
    }
  }

  function makeMessagesWithImage(): LLMMessage[] {
    return [
      {
        role: 'user' as const,
        content: 'hello',
        attachments: [makeAttachment()],
      },
    ]
  }

  it('profile says no vision -> image replaced with placeholder', async () => {
    const result = await convertMessages(makeMessagesWithImage(), false)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: '[Image: test.png] (vision not supported, cannot describe)' },
      ],
    })
  })

  it('profile says vision -> image sent as image_url', async () => {
    const result = await convertMessages(makeMessagesWithImage(), true)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'abc' } },
      ],
    })
  })

  it('modern Claude profile sends an image and an explicit override can disable it', async () => {
    const profile = getModelProfile('claude-opus-5')
    const enabled = await buildStreamingCreateParams({
      model: 'claude-opus-5',
      request: { messages: makeMessagesWithImage() },
      profile,
      capabilities: {
        supportsTopK: false,
        supportsChatTemplateKwargs: false,
        supportsNumCtx: false,
        routesEffortViaChatTemplateKwargs: false,
        usesMaxCompletionTokens: false,
      },
    })

    expect((enabled.params as any).messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'abc' },
    })
    expect(modelSupportsVision('claude-opus-5', false)).toBe(false)
    expect(modelSupportsVision('claude-opus-5', true)).toBe(true)
  })

  it('does not expose image base64 in a provider error', async () => {
    const marker = 'PRIVATE_IMAGE_BASE64_PAYLOAD'
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'hello',
        attachments: [{ ...makeAttachment(), data: `data:image/png;base64,${marker}` }],
      },
    ]
    const { params } = await buildNonStreamingCreateParams({
      model: 'claude-opus-5',
      request: { messages },
      profile: getModelProfile('claude-opus-5'),
      capabilities: {
        supportsTopK: false,
        supportsChatTemplateKwargs: false,
        supportsNumCtx: false,
        routesEffortViaChatTemplateKwargs: false,
        usesMaxCompletionTokens: false,
      },
    })
    let sentBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        sentBody = String(init?.body ?? '')
        return new Response(JSON.stringify({ error: { message: 'image rejected' } }), { status: 400 })
      }),
    )
    const client = new OpenAIHttpClient({ baseURL: 'https://provider.example/v1', apiKey: 'test-key' })

    expect(JSON.stringify(params)).toContain(marker)
    await expect(client.createChatCompletion(params)).rejects.toThrow('image rejected')
    try {
      await client.createChatCompletion(params)
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(marker)
    }
    expect(sentBody).toContain(marker)
  })

  it('buildStreamingCreateParams: profile says no vision, no override -> text placeholder', async () => {
    const profile = {
      temperature: 0.7,
      defaultMaxTokens: 4096,
      topP: 0.9,
      supportsVision: false,
    }

    const result = await buildStreamingCreateParams({
      model: 'test-model',
      request: {
        messages: makeMessagesWithImage(),
      },
      profile,
      capabilities: {
        supportsTopK: false,
        supportsChatTemplateKwargs: false,
        supportsNumCtx: false,
        routesEffortViaChatTemplateKwargs: false,
        usesMaxCompletionTokens: false,
      },
    })

    expect((result.params as any).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: '[Image: test.png] (vision not supported, cannot describe)' },
        ],
      },
    ])
  })

  it('buildStreamingCreateParams: profile says no vision, user overrides to true -> image_url', async () => {
    const profile = {
      temperature: 0.7,
      defaultMaxTokens: 4096,
      topP: 0.9,
      supportsVision: false,
    }

    const result = await buildStreamingCreateParams({
      model: 'test-model',
      request: {
        messages: makeMessagesWithImage(),
        modelSettings: { supportsVision: true },
      },
      profile,
      capabilities: {
        supportsTopK: false,
        supportsChatTemplateKwargs: false,
        supportsNumCtx: false,
        routesEffortViaChatTemplateKwargs: false,
        usesMaxCompletionTokens: false,
      },
    })

    expect((result.params as any).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: 'abc' } },
        ],
      },
    ])
  })

  it('buildStreamingCreateParams: profile says vision, user overrides to false -> text placeholder', async () => {
    const profile = {
      temperature: 0.7,
      defaultMaxTokens: 4096,
      topP: 0.9,
      supportsVision: true,
    }

    const result = await buildStreamingCreateParams({
      model: 'test-model',
      request: {
        messages: makeMessagesWithImage(),
        modelSettings: { supportsVision: false },
      },
      profile,
      capabilities: {
        supportsTopK: false,
        supportsChatTemplateKwargs: false,
        supportsNumCtx: false,
        routesEffortViaChatTemplateKwargs: false,
        usesMaxCompletionTokens: false,
      },
    })

    expect((result.params as any).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: '[Image: test.png] (vision not supported, cannot describe)' },
        ],
      },
    ])
  })

  it('buildNonStreamingCreateParams: user vision override works the same way', async () => {
    const profile = {
      temperature: 0.7,
      defaultMaxTokens: 4096,
      topP: 0.9,
      supportsVision: false,
    }

    const result = await buildNonStreamingCreateParams({
      model: 'test-model',
      request: {
        messages: makeMessagesWithImage(),
        modelSettings: { supportsVision: true },
      },
      profile,
      capabilities: {
        supportsTopK: false,
        supportsChatTemplateKwargs: false,
        supportsNumCtx: false,
        routesEffortViaChatTemplateKwargs: false,
        usesMaxCompletionTokens: false,
      },
    })

    expect((result.params as any).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: 'abc' } },
        ],
      },
    ])
  })
})
