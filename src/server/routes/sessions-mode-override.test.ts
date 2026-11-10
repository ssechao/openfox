/**
 * Mode Switch + Agent Model Override Tests
 *
 * Plan B semantics: `session.provider_id`/`provider_model` are the user's STICKY
 * preference, written only by an explicit pick (POST /provider). Mode switch is a
 * pure `setMode` — it never writes, clears, or re-derives the stored provider.
 * The effective model is always derived: agent override > session preference > default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import { type Server } from 'node:http'
import { closeDatabase, getDatabase, initDatabase } from '../db/index.js'
import { loadConfig } from '../config.js'
import { createProject } from '../db/projects.js'
import { initEventStore } from '../events/index.js'
import { SessionManager } from '../session/manager.js'
import { getAgentModelOverride, setAgentModelOverride } from '../agents/model-overrides.js'
import { getTopLevelAgents, loadDefaultAgents } from '../agents/registry.js'
import { getSession, updateSessionProvider } from '../db/sessions.js'

const mockProviderManager = {
  getCurrentModelContext: () => 200000,
  getLLMClient: () => ({
    getModel: () => 'global-model',
    setModel: () => {},
    getProfile: () => {},
    getBackend: () => 'unknown',
    setBackend: () => {},
    complete: async () => {},
    stream: async function* () {},
  }),
  getActiveProviderId: () => 'test-provider',
  getCurrentModel: () => 'global-model',
  createClient: () => undefined,
  getProviders: () => [],
  getModelSettings: () => undefined,
  getDefaultModelSelection: () => 'test-provider/global-model',
}

const managerRoundTripCases = [
  {
    label: 'default preference across Planner to Manager to Planner',
    providerId: null,
    providerModel: null,
    providerManual: false,
    effective: { providerId: 'test-provider', model: 'global-model' },
    modes: ['planner', 'manager', 'planner'],
  },
  {
    label: 'manual preference across Planner to Manager to Planner',
    providerId: 'manual-provider',
    providerModel: 'manual-model',
    providerManual: true,
    effective: { providerId: 'manual-provider', model: 'manual-model' },
    modes: ['planner', 'manager', 'planner'],
  },
  {
    label: 'default preference across Builder to Manager to Builder',
    providerId: null,
    providerModel: null,
    providerManual: false,
    effective: { providerId: 'test-provider', model: 'global-model' },
    modes: ['builder', 'manager', 'builder'],
  },
  {
    label: 'manual preference across Builder to Manager to Builder',
    providerId: 'manual-provider',
    providerModel: 'manual-model',
    providerManual: true,
    effective: { providerId: 'manual-provider', model: 'manual-model' },
    modes: ['builder', 'manager', 'builder'],
  },
]

describe('PUT /api/sessions/:id/mode — pure mode switch (never writes provider)', () => {
  let server: Server
  let baseUrl: string
  let sessionManager: SessionManager
  let sessionId: string

  beforeEach(async () => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    initEventStore(getDatabase())

    const workdir = '/tmp/test'
    const projectId = createProject('Test', workdir).id

    sessionManager = new SessionManager(mockProviderManager as any)
    const session = sessionManager.createSession(projectId)
    sessionId = session.id

    const app = express()
    app.use(express.json())

    // Mini mode switch handler matching the real one: setMode only, no provider writes
    app.put('/api/sessions/:id/mode', async (req, res) => {
      const sid = req.params.id
      const sess = sessionManager.getSession(sid)
      if (!sess) return res.status(404).json({ error: 'Session not found' })

      const { mode } = req.body
      if (!mode) return res.status(400).json({ error: 'mode is required' })

      const topLevelAgents = getTopLevelAgents(await loadDefaultAgents())
      if (!topLevelAgents.some((agent) => agent.metadata.id === mode)) {
        return res.status(400).json({ error: 'Invalid mode' })
      }

      sessionManager.setMode(sid, mode)
      const updated = sessionManager.getSession(sid)
      res.json({ session: updated })
    })

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase()
  })

  it('does not write the session provider when the agent has an override', async () => {
    setAgentModelOverride('planner', { providerId: 'my-provider', model: 'my-model' })

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'planner' }),
    })
    expect(res.status).toBe(200)

    const session = getSession(sessionId)
    expect(session?.providerId).toBeNull()
    expect(session?.providerModel).toBeNull()
  })

  it('does not clear a manual session provider when switching to an agent without override', async () => {
    updateSessionProvider(sessionId, 'manual-provider', 'manual-model')

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'builder' }),
    })
    expect(res.status).toBe(200)

    const session = getSession(sessionId)
    expect(session?.providerId).toBe('manual-provider')
    expect(session?.providerModel).toBe('manual-model')
  })

  it('manual pick survives a round-trip through an override agent', async () => {
    setAgentModelOverride('planner', { providerId: 'agent-provider', model: 'agent-model' })
    updateSessionProvider(sessionId, 'manual-provider', 'manual-model', true)

    // Switch to override agent — stored preference (and its manual flag) untouched
    await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'planner' }),
    })
    let session = getSession(sessionId)
    expect(session?.providerId).toBe('manual-provider')
    expect(session?.providerModel).toBe('manual-model')
    expect(session?.providerManual).toBe(true)

    // Switch back to an agent without override — preference still intact
    await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'builder' }),
    })
    session = getSession(sessionId)
    expect(session?.providerId).toBe('manual-provider')
    expect(session?.providerModel).toBe('manual-model')
    expect(session?.providerManual).toBe(true)
  })

  it('mode switch toggles the manual pick active flag without clearing the preference', async () => {
    setAgentModelOverride('planner', { providerId: 'agent-provider', model: 'agent-model' })
    updateSessionProvider(sessionId, 'manual-provider', 'manual-model', true)
    sessionManager.setSessionProviderActive(sessionId, true)

    // Land on a non-override agent first (fresh sessions may default to the override agent)
    await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'builder' }),
    })

    // Switch to the override agent → preference intact, flag deactivated (label wins)
    await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'planner' }),
    })
    let session = getSession(sessionId)
    expect(session?.providerId).toBe('manual-provider')
    expect(session?.providerManual).toBe(true)
    expect(session?.providerManualActive).toBe(false)

    // Switch to a non-override agent → flag reactivated
    await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'builder' }),
    })
    session = getSession(sessionId)
    expect(session?.providerId).toBe('manual-provider')
    expect(session?.providerManualActive).toBe(true)
  })

  it('handles missing override gracefully (no crash)', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'builder' }),
    })
    expect(res.status).toBe(200)
  })

  it.each(managerRoundTripCases)('preserves $label', async (testCase) => {
    updateSessionProvider(sessionId, testCase.providerId, testCase.providerModel, testCase.providerManual)
    sessionManager.setSessionProviderActive(sessionId, true)

    for (const mode of testCase.modes) {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { session: { mode: string } }
      expect(body.session.mode).toBe(mode)

      const session = sessionManager.getSession(sessionId)
      expect(session).toMatchObject({
        mode,
        providerId: testCase.providerId,
        providerModel: testCase.providerModel,
        providerManual: testCase.providerManual,
        providerManualActive: true,
      })
      expect(sessionManager.resolveEffectiveProviderModel(sessionId)).toEqual(testCase.effective)
    }
  })

  it('uses a Planner override only while Planner is active during a Manager round-trip', async () => {
    setAgentModelOverride('planner', { providerId: 'planner-provider', model: 'planner-model' })
    updateSessionProvider(sessionId, 'manual-provider', 'manual-model', true)
    sessionManager.setSessionProviderActive(sessionId, true)

    const transitions = [
      {
        mode: 'builder',
        active: true,
        effective: { providerId: 'manual-provider', model: 'manual-model' },
      },
      {
        mode: 'planner',
        active: false,
        effective: { providerId: 'planner-provider', model: 'planner-model' },
      },
      {
        mode: 'manager',
        active: true,
        effective: { providerId: 'manual-provider', model: 'manual-model' },
      },
      {
        mode: 'builder',
        active: true,
        effective: { providerId: 'manual-provider', model: 'manual-model' },
      },
    ]

    for (const transition of transitions) {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: transition.mode }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { session: { mode: string } }
      expect(body.session.mode).toBe(transition.mode)

      const session = sessionManager.getSession(sessionId)
      expect(session).toMatchObject({
        mode: transition.mode,
        providerId: 'manual-provider',
        providerModel: 'manual-model',
        providerManual: true,
        providerManualActive: transition.active,
      })
      expect(sessionManager.resolveEffectiveProviderModel(sessionId, transition.mode)).toEqual(transition.effective)
    }

    expect(getAgentModelOverride('manager')).toBeUndefined()
  })
})

describe('DELETE /api/sessions/:id/provider — reset manual pick', () => {
  let server: Server
  let baseUrl: string
  let sessionManager: SessionManager
  let sessionId: string

  beforeEach(async () => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    initEventStore(getDatabase())

    const workdir = '/tmp/test'
    const projectId = createProject('Test', workdir).id

    sessionManager = new SessionManager(mockProviderManager as any)
    const session = sessionManager.createSession(projectId)
    sessionId = session.id

    const app = express()
    app.use(express.json())

    // Mini reset handler matching the real one
    app.delete('/api/sessions/:id/provider', async (req, res) => {
      const sid = req.params.id
      const sess = sessionManager.getSession(sid)
      if (!sess) return res.status(404).json({ error: 'Session not found' })
      sessionManager.setSessionProvider(sid, null, null, false)
      sessionManager.setSessionProviderActive(sid, true)
      const updated = sessionManager.getSession(sid)
      res.json({ session: updated })
    })

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase()
  })

  it('clears the manual pick so agent overrides apply again', async () => {
    setAgentModelOverride('planner', { providerId: 'agent-provider', model: 'agent-model' })
    sessionManager.setSessionProvider(sessionId, 'manual-provider', 'manual-model', true)

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/provider`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { session: { providerId: string | null; providerModel: string | null } }
    expect(data.session.providerId).toBeNull()
    expect(data.session.providerModel).toBeNull()

    const session = getSession(sessionId)
    expect(session?.providerManual).toBe(false)
    expect(session?.providerManualActive).toBe(true)
  })
})

describe('GET /api/sessions/:id — read-only provider (never materializes override)', () => {
  let server: Server
  let baseUrl: string
  let sessionManager: SessionManager
  let sessionId: string

  beforeEach(async () => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    initEventStore(getDatabase())

    const workdir = '/tmp/test'
    const projectId = createProject('Test', workdir).id

    sessionManager = new SessionManager(mockProviderManager as any)
    const session = sessionManager.createSession(projectId)
    sessionId = session.id

    const app = express()
    app.use(express.json())

    // GET handler matching the real one: returns the stored session as-is
    app.get('/api/sessions/:id', async (req, res) => {
      const sess = sessionManager.getSession(req.params.id)
      if (!sess) {
        return res.status(404).json({ error: 'Session not found' })
      }
      res.json({ session: sess })
    })

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase()
  })

  it('returns the stored provider as-is and never materializes an override', async () => {
    setAgentModelOverride('planner', { providerId: 'override-provider', model: 'override-model' })
    sessionManager.setMode(sessionId, 'planner')

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { session: { providerId: string | null; providerModel: string | null } }
    expect(data.session.providerId).toBeNull()
    expect(data.session.providerModel).toBeNull()
  })

  it('does not mutate a manual provider on GET', async () => {
    setAgentModelOverride('planner', { providerId: 'override-provider', model: 'override-model' })
    updateSessionProvider(sessionId, 'manual-provider', 'manual-model')
    sessionManager.setMode(sessionId, 'planner')

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { session: { providerId: string | null; providerModel: string | null } }
    expect(data.session.providerId).toBe('manual-provider')
    expect(data.session.providerModel).toBe('manual-model')

    // Stored value unchanged after GET
    const session = getSession(sessionId)
    expect(session?.providerId).toBe('manual-provider')
  })

  it('does nothing when agent has no override', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { session: { providerId: string | null; providerModel: string | null } }
    expect(data.session.providerId).toBeNull()
    expect(data.session.providerModel).toBeNull()
  })
})
