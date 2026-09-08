import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from './manager.js'
import type { Provider } from '../../shared/types.js'
import type { ProviderManager } from '../provider-manager.js'
import type { LLMClientWithModel } from '../llm/client.js'

describe('Responses client ownership per session', () => {
  it('reuses only the current selection, never resurrects A on A -> B -> A, and invalidates transport edits', () => {
    const provider = {
      id: 'provider',
      url: 'http://127.0.0.1:1',
      apiProtocol: 'responses',
      models: [{ id: 'A' }, { id: 'B' }],
      status: 'connected',
    } as Provider
    const manager = new SessionManager({ getProviders: () => [provider] } as ProviderManager)
    const create = vi.fn(() => ({}) as LLMClientWithModel)
    const resolve = (session: string, model: string) =>
      manager.getOrCreateSessionLLMClient(session, 'provider', model, undefined, create)
    const a = resolve('s1', 'A')
    expect(resolve('s1', 'A')).toBe(a)
    expect(resolve('s2', 'A')).not.toBe(a)
    resolve('s1', 'B')
    expect(resolve('s1', 'A')).not.toBe(a)
    const beforeChange = resolve('s1', 'A')
    provider.apiProtocol = 'chat-completions'
    expect(resolve('s1', 'A')).not.toBe(beforeChange)
    const beforeClear = resolve('s1', 'A')
    manager.clearSessionLLMClient('s1')
    expect(resolve('s1', 'A')).not.toBe(beforeClear)
    const stable = resolve('s1', 'A')
    provider.status = 'disconnected'
    expect(resolve('s1', 'A')).toBe(stable)
  })
})
