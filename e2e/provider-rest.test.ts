/**
 * Provider Configuration REST API E2E Tests
 *
 * Tests session provider/model configuration via REST API.
 * Following TDD: these tests should FAIL initially before implementation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createTestServer, type TestServerHandle } from './utils/index.js'
import { createTestProject, type TestProject } from './utils/index.js'
import { loadGlobalConfig } from '../src/cli/config.js'

describe('Provider Configuration REST API', () => {
  let server: TestServerHandle
  let testProject: TestProject
  let projectId: string
  let sessionId: string

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    testProject = await createTestProject({ template: 'empty' })
    // Create a project via REST
    const createRes = await fetch(`${server.url}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Project', workdir: testProject.path }),
    })
    const data: any = await createRes.json()
    projectId = data.project.id

    // Create a session
    const sessionRes = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'Test Session' }),
    })
    const sessionData: any = await sessionRes.json()
    sessionId = sessionData.session.id
  })

  afterEach(async () => {
    await testProject.cleanup()
  })

  describe('POST /api/sessions/:id/provider', () => {
    it('persists the protocol override through provider POST, PUT and reload', async () => {
      const created = await fetch(`${server.url}/api/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Protocol fixture',
          url: 'http://127.0.0.1:9/v1',
          backend: 'unknown',
          apiProtocol: 'responses',
          models: [],
        }),
      })
      expect(created.status).toBe(201)
      const { provider } = (await created.json()) as { provider: { id: string; apiProtocol?: string } }
      expect(provider.apiProtocol).toBe('responses')
      for (const apiProtocol of ['chat-completions', 'auto', null]) {
        const updated = await fetch(`${server.url}/api/providers/${provider.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiProtocol }),
        })
        expect(updated.status).toBe(200)
        const config = await loadGlobalConfig('test', server.globalConfigPath)
        expect(config.providers.find((candidate) => candidate.id === provider.id)?.apiProtocol).toBe(
          apiProtocol ?? undefined,
        )
      }
    })

    it('sets session provider and model', async () => {
      // Get available providers first
      const providersRes = await fetch(`${server.url}/api/providers`)
      const providersData: any = await providersRes.json()
      const providerId = providersData.providers?.[0]?.id ?? providersData.activeProviderId

      if (!providerId) {
        // Skip test if no providers available (mock mode)
        console.log('No providers available, skipping test')
        return
      }

      // Set provider for session
      const response = await fetch(`${server.url}/api/sessions/${sessionId}/provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      })

      expect(response.status).toBe(200)
      const data: any = await response.json()
      expect(data.session.providerId).toBe(providerId)
    })

    it('updates context state with new maxTokens', async () => {
      // Get available providers first
      const providersRes = await fetch(`${server.url}/api/providers`)
      const providersData: any = await providersRes.json()
      const providerId = providersData.providers?.[0]?.id ?? providersData.activeProviderId

      if (!providerId) {
        // Skip test if no providers available (mock mode)
        console.log('No providers available, skipping test')
        return
      }

      // Set provider for session
      const response = await fetch(`${server.url}/api/sessions/${sessionId}/provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      })

      expect(response.status).toBe(200)
      const data: any = await response.json()

      // Context state should be included
      expect(data.contextState).toBeDefined()
      expect(data.contextState.maxTokens).toBeGreaterThan(0)
    })

    it('returns 404 for non-existent session', async () => {
      const providersRes = await fetch(`${server.url}/api/providers`)
      const providersData: any = await providersRes.json()
      const providerId = providersData.activeProviderId

      const response = await fetch(`${server.url}/api/sessions/nonexistent-id/provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      })

      expect(response.status).toBe(404)
    })

    it('returns 400 for missing providerId', async () => {
      const response = await fetch(`${server.url}/api/sessions/${sessionId}/provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      const data: any = await response.json()
      expect(data.error).toBeDefined()
    })
  })

  describe('PUT /api/providers/:id/models/:modelId/settings', () => {
    async function createProvider(models: Record<string, unknown>[]): Promise<string> {
      const createRes = await fetch(`${server.url}/api/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Settings Test Provider',
          url: 'http://127.0.0.1:9/v1',
          backend: 'openai',
          models,
          isActive: true,
        }),
      })
      expect(createRes.status).toBe(201)
      const createData = (await createRes.json()) as { success: boolean; provider: { id: string } }
      return createData.provider.id
    }

    it('persists thinkingLevel and thinkingEnabled to the config file and in-memory state', async () => {
      const providerId = await createProvider([
        {
          id: 'gpt-4',
          contextWindow: 128000,
          reasoningEfforts: ['low', 'medium', 'high'],
          thinkingEnabled: true,
          thinkingLevel: 'medium',
        },
      ])

      const response = await fetch(`${server.url}/api/providers/${providerId}/models/gpt-4/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingLevel: 'high', thinkingEnabled: true }),
      })
      expect(response.status).toBe(200)
      const data: any = await response.json()
      expect(data.success).toBe(true)
      expect(data.model.thinkingLevel).toBe('high')

      // Survives a restart: the isolated config file carries the new default.
      const config = await loadGlobalConfig('test', server.globalConfigPath)
      const provider = config.providers?.find((p) => p.id === providerId)
      const model = provider?.models.find((m) => m.id === 'gpt-4')
      expect(model?.thinkingLevel).toBe('high')
      expect(model?.thinkingEnabled).toBe(true)

      // In-memory provider state reflects the update for immediate use.
      const providersRes = await fetch(`${server.url}/api/providers`)
      const providersData: any = await providersRes.json()
      const inMemModel = providersData.providers
        .find((p: any) => p.id === providerId)
        .models.find((m: any) => m.id === 'gpt-4')
      expect(inMemModel.thinkingLevel).toBe('high')
    })

    it('returns 404 for an unknown provider', async () => {
      const response = await fetch(`${server.url}/api/providers/unknown-id/models/gpt-4/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingLevel: 'high' }),
      })
      expect(response.status).toBe(404)
    })

    it('returns 404 for an unknown model', async () => {
      const providerId = await createProvider([
        { id: 'gpt-4', contextWindow: 128000, thinkingEnabled: true, thinkingLevel: 'medium' },
      ])
      const response = await fetch(`${server.url}/api/providers/${providerId}/models/nope/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingLevel: 'high' }),
      })
      expect(response.status).toBe(404)
    })

    it('returns 400 for an out-of-vocabulary effort value', async () => {
      const providerId = await createProvider([
        { id: 'gpt-4', contextWindow: 128000, thinkingEnabled: true, thinkingLevel: 'medium' },
      ])
      const response = await fetch(`${server.url}/api/providers/${providerId}/models/gpt-4/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingLevel: 'bogus' }),
      })
      expect(response.status).toBe(400)
    })
  })

  describe('PUT /api/providers/order', () => {
    async function createProvider(name: string): Promise<string> {
      const createRes = await fetch(`${server.url}/api/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          url: `http://127.0.0.1:9/${name}/v1`,
          backend: 'openai',
          isActive: false,
        }),
      })
      expect(createRes.status).toBe(201)
      const createData = (await createRes.json()) as { success: boolean; provider: { id: string } }
      return createData.provider.id
    }

    async function getProviderIds(): Promise<string[]> {
      const res = await fetch(`${server.url}/api/providers`)
      const data: any = await res.json()
      return data.providers.map((p: any) => p.id)
    }

    it('reorders providers in memory and persists to the config file', async () => {
      const before = await getProviderIds()
      const first = await createProvider('Order A')
      const second = await createProvider('Order B')
      const third = await createProvider('Order C')
      const original = await getProviderIds()
      expect(original).toEqual([...before, first, second, third])

      // Move the last-created provider to the front, keep the rest in order.
      const reordered = [third, ...original.filter((id) => id !== third)]

      const response = await fetch(`${server.url}/api/providers/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerIds: reordered }),
      })
      expect(response.status).toBe(200)
      const data: any = await response.json()
      expect(data.success).toBe(true)
      expect(data.providers.map((p: any) => p.id)).toEqual(reordered)

      // In-memory state reflects the new order for the UI.
      expect(await getProviderIds()).toEqual(reordered)

      // The reordered list survives a reload from the isolated config file.
      const config = await loadGlobalConfig('test', server.globalConfigPath)
      expect(config.providers?.map((p) => p.id)).toEqual(reordered)
    })

    it('keeps the active provider and default model selection unchanged', async () => {
      const before = await fetch(`${server.url}/api/providers`).then((r) => r.json() as any)
      const ids = before.providers.map((p: any) => p.id)
      expect(ids.length).toBeGreaterThanOrEqual(2)
      const beforeConfig = await loadGlobalConfig('test', server.globalConfigPath)

      const response = await fetch(`${server.url}/api/providers/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerIds: [...ids].reverse() }),
      })
      expect(response.status).toBe(200)
      const data: any = await response.json()

      expect(data.activeProviderId).toBe(before.activeProviderId)
      expect(data.providers.map((p: any) => p.id)).toEqual([...ids].reverse())

      // The config file's default model selection is untouched.
      const afterConfig = await loadGlobalConfig('test', server.globalConfigPath)
      expect(afterConfig.defaultModelSelection).toBe(beforeConfig.defaultModelSelection)
    })

    it('returns 400 for an incomplete set of provider ids', async () => {
      const ids = await getProviderIds()
      const response = await fetch(`${server.url}/api/providers/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerIds: ids.slice(0, ids.length - 1) }),
      })
      expect(response.status).toBe(400)
    })

    it('returns 400 for an unknown provider id', async () => {
      const ids = await getProviderIds()
      const response = await fetch(`${server.url}/api/providers/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerIds: ['nope', ...ids.slice(1)] }),
      })
      expect(response.status).toBe(400)
    })
  })
})
