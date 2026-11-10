import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentRoutes } from './agents.js'

describe('GET /api/agents — Manager builtin', () => {
  let server: Server
  let baseUrl: string
  let configDir: string
  let projectDir: string

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'agents-manager-config-'))
    projectDir = await mkdtemp(join(tmpdir(), 'agents-manager-project-'))

    const app = express()
    app.use('/api/agents', createAgentRoutes(configDir, projectDir))

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all([
      rm(configDir, { recursive: true, force: true }),
      rm(projectDir, { recursive: true, force: true }),
    ])
  })

  it('returns Manager metadata in defaults without user or project overrides', async () => {
    const response = await fetch(`${baseUrl}/api/agents`)
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      defaults: Array<Record<string, unknown>>
      userItems: Array<Record<string, unknown>>
      projectItems: Array<Record<string, unknown>>
    }
    expect(body.userItems).toEqual([])
    expect(body.projectItems).toEqual([])
    expect(body.defaults).toContainEqual({
      id: 'manager',
      name: 'Manager',
      description: 'Manages project tasks and coordinates specialized sessions',
      subagent: false,
      color: '#0d9488',
      allowedTools: [
        'read_file',
        'describe_image',
        'web_fetch',
        'web_search',
        'ask_user',
        'session_metadata',
        'load_skill',
        'project_tasks',
      ],
    })
  })
})
