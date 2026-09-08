/** Opt-in synthetic live check. No real project tools, files or user history. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createLLMClient } from '../src/server/llm/client.js'
import type { LLMMessage, LLMCompletionRequest, LLMCompletionResponse } from '../src/server/llm/types.js'

const baseUrl = process.env['WRAPPER_BASE_URL']
const apiKey = process.env['WRAPPER_API_KEY']
const models = process.env['WRAPPER_SMOKE_MODELS']?.split(',').filter(Boolean)
assert(baseUrl && apiKey && models?.length, 'Explicit WRAPPER_BASE_URL, WRAPPER_API_KEY, WRAPPER_SMOKE_MODELS required')
const realFetch = globalThis.fetch
const wire: Array<{ path: string; previous?: string; store: unknown; inputCount: number; toolCount: number }> = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin === new URL(baseUrl).origin && init?.method === 'POST') {
    const body = JSON.parse(String(init.body))
    assert(url.pathname.endsWith('/v1/responses'), 'Unexpected protocol')
    assert(!('messages' in body) && !('conversation' in body))
    assert.equal(body.store, true)
    wire.push({
      path: url.pathname,
      previous: body.previous_response_id,
      store: body.store,
      inputCount: body.input.length,
      toolCount: body.tools?.length ?? 0,
    })
  }
  return realFetch(input, init)
}

try {
  for (const model of models) {
    const start = wire.length
    const marker = `MEMORY_${randomUUID()}`
    const value = `VALUE_${randomUUID()}`
    const chain = `continuity-smoke-${randomUUID()}`
    const client = createLLMClient(
      { llm: { baseUrl, apiKey, model, apiProtocol: 'responses', timeout: 60000, idleTimeout: 60000 } } as never,
      'openai',
    )
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'external_lookup',
          description: 'Return a synthetic opaque value from the API caller; no side effects.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ]
    const system: LLMMessage = {
      role: 'system',
      content: 'Follow the user request. Use only declared external tools. Keep replies concise.',
    }
    let messages: LLMMessage[] = [
      system,
      { role: 'user', content: `Remember ${marker}. Do not call tools. Reply only READY.` },
    ]
    const ids: string[] = []
    const usages: LLMCompletionResponse['usage'][] = []
    const run = async (extra: Partial<LLMCompletionRequest> = {}) => {
      let result: LLMCompletionResponse | undefined
      for await (const event of client.stream({
        messages,
        tools,
        toolChoice: 'auto',
        responsesChainKey: chain,
        reasoningEffort: 'low',
        modelSettings: { maxTokens: 2048 },
        signal: AbortSignal.timeout(60000),
        ...extra,
      })) {
        if (event.type === 'error') throw new Error(event.error)
        if (event.type === 'done') result = event.response
      }
      assert(result, 'Missing terminal response')
      assert.notEqual(result.finishReason, 'length', 'Truncated response')
      ids.push(result.id)
      usages.push(result.usage)
      console.log(
        JSON.stringify({
          model,
          turn: ids.length,
          responseId: result.id,
          finishReason: result.finishReason,
          contentLength: result.content.length,
          toolCount: result.toolCalls?.length ?? 0,
          usage: result.usage,
          wire: wire.at(-1),
        }),
      )
      messages.push({
        role: 'assistant',
        content: result.content,
        ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
      })
      return result
    }
    const first = await run()
    assert.match(first.content, /READY/)
    messages.push({
      role: 'user',
      content: 'Call external_lookup exactly once now. Wait for its result, then reply only with that result.',
    })
    const second = await run()
    assert.equal(second.toolCalls?.length, 1)
    const call = second.toolCalls![0]!
    assert.equal(call.name, 'external_lookup')
    messages.push({ role: 'tool', content: value, toolCallId: call.id })
    const third = await run()
    assert(third.content.includes(value), 'Tool result was lost')
    messages.push({ role: 'user', content: 'Reply only with the MEMORY_ value you were asked to remember.' })
    const fourth = await run()
    assert(fourth.content.includes(marker), 'Context was lost after final answer')
    for (let n = 1; n < 4; n++) {
      assert.equal(wire[start + n]!.previous, ids[n - 1], `No chain on turn ${n + 1}`)
      assert.equal(wire[start + n]!.inputCount, 1, 'History was retransmitted')
    }
    messages.push({
      role: 'user',
      content:
        'Summarize this conversation for continuation. Preserve the exact MEMORY_ value and the tool result. Output only the summary, no tools.',
    })
    const beforeSummary = wire.length
    const summary = await run({ tools: [], toolChoice: 'none', modelSettings: { maxTokens: 8192 } })
    assert.equal(wire.length - beforeSummary, 1, 'Summary retried')
    assert.equal(wire.at(-1)!.toolCount, 0)
    assert(!summary.toolCalls?.length && summary.content.trim(), 'Summary is empty or contains a tool call')
    assert(summary.content.includes(marker), 'Summary lost the continuity marker')
    client.resetResponsesChain?.(chain)
    messages = [
      system,
      { role: 'assistant', content: summary.content },
      { role: 'user', content: 'Reply only with the MEMORY_ value from the summary.' },
    ]
    const resumed = await run()
    assert(resumed.content.includes(marker))
    assert.equal(wire.at(-1)!.previous, undefined)
    assert.equal(wire.at(-1)!.inputCount, 2)
    console.log(JSON.stringify({ model, status: 'PASS', ids, wire: wire.slice(start), usages }))
  }
} finally {
  globalThis.fetch = realFetch
}
