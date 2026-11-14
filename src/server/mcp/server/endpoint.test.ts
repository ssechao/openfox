// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { McpManager } from '../manager.js'
import { createMcpTools } from '../tool-adapter.js'
import type { ToolContext } from '../../tools/types.js'
import { createOpenFoxMcpRouter } from './endpoint.js'
import type { OpenFoxMcpRouterOptions } from './endpoint.js'
import type { OpenFoxMcpToolDeps } from './types.js'

const projects = [
  {
    id: 'p-1',
    name: 'proj',
    workdir: '/tmp/proj',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

function makeDeps(): OpenFoxMcpToolDeps {
  return {
    sessionManager: {
      getSession: () => undefined,
      getProject: () => ({ id: 'p-1', name: 'proj', workdir: '/tmp/proj' }),
      createSession: vi.fn(),
      listSessionsByProject: vi.fn(() => ({ sessions: [], hasMore: false })),
      listSessionsLimited: vi.fn(() => ({ sessions: [], hasMore: false })),
      queueMessage: vi.fn(),
      getQueueState: vi.fn(() => []),
      getActiveWorkflowExecution: vi.fn(() => null),
      setPhase: vi.fn(),
    } as any,
    listProjects: vi.fn(() => projects),
    topLevelAgentIds: vi.fn(async () => []),
    listWorkflows: vi.fn(async () => []),
    launchWorkflow: vi.fn(),
    stopSession: vi.fn(),
    stopWorkflow: vi.fn(() => null),
    answerQuestion: vi.fn(() => 'not-handled' as const),
    pendingQuestions: vi.fn(() => []),
    confirmPath: vi.fn(() => false),
    pendingConfirmations: vi.fn(() => []),
    setMetadataEntries: vi.fn(),
    createProject: vi.fn(async () => ({
      id: 'p-2',
      name: 'x',
      workdir: '/tmp/x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    deleteProject: vi.fn(() => true),
    recentMessages: vi.fn(() => ({ messages: [], hiddenCount: 0 })),
  }
}

interface Started {
  url: string
  close: () => Promise<void>
}

function startRouter(options: OpenFoxMcpRouterOptions): Promise<Started> {
  const app = express()
  app.use(express.json())
  app.use('/mcp', createOpenFoxMcpRouter(options))
  const server = app.listen(0)
  return new Promise((resolve, reject) => {
    server.on('listening', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          }),
      })
    })
    server.on('error', reject)
  })
}

async function connectClient(url: string, headers?: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined)
  const client = new Client({ name: 'openfox-mcp-endpoint-test', version: '0.0.1' })
  await client.connect(transport as any)
  return client
}

type ProofInput = { callerSessionId: string; toolName: string; targetSessionId: string }
type VerifyInput = ProofInput & { proof: unknown }

function createTransportAuthority() {
  const issued = new Map<string, ProofInput>()
  let afterIssue: ((input: ProofInput) => void) | undefined
  const issueProof = vi.fn((input: ProofInput) => {
    const proof = `host-proof-${input.callerSessionId}-${input.toolName}-${input.targetSessionId}`
    issued.set(proof, { ...input })
    afterIssue?.(input)
    return proof
  })
  const verifyCallerIdentity = vi.fn((input: VerifyInput) => {
    const trusted = typeof input.proof === 'string' ? issued.get(input.proof) : undefined
    if (
      !trusted ||
      trusted.callerSessionId !== input.callerSessionId ||
      trusted.toolName !== input.toolName ||
      trusted.targetSessionId !== input.targetSessionId
    ) {
      return { ok: false as const, error: 'trusted OpenFox caller identity is required' }
    }
    return { ok: true as const, callerSessionId: trusted.callerSessionId }
  })
  return {
    issueProof,
    verifyCallerIdentity,
    setAfterIssue(callback: ((input: ProofInput) => void) | undefined) {
      afterIssue = callback
    },
  }
}

function makeDeleteHarness(authority: ReturnType<typeof createTransportAuthority>) {
  const sessions = new Map<string, any>()
  const deleted: string[] = []
  const deps = makeDeps()
  deps.sessionManager = {
    ...deps.sessionManager,
    getSession: (id: string) => sessions.get(id),
    deleteSession: vi.fn((id: string) => {
      deleted.push(id)
      sessions.delete(id)
    }),
  } as any
  ;(deps as any).verifyCallerIdentity = authority.verifyCallerIdentity
  const addSession = (id: string, overrides: { projectId?: string; mode?: string; isRunning?: boolean } = {}) => {
    const session = {
      id,
      projectId: overrides.projectId ?? 'p-1',
      mode: overrides.mode ?? 'builder',
      isRunning: overrides.isRunning ?? false,
    }
    sessions.set(id, session)
    return session
  }
  return { deps, sessions, deleted, addSession }
}

function createGateway(
  authority: ReturnType<typeof createTransportAuthority>,
  isOwnEndpoint: (input: {
    kind: 'direct' | 'proxy'
    serverName: string
    url?: string
    targetServerName?: string
  }) => boolean,
): McpManager {
  return new McpManager({
    openFoxCallerIdentity: {
      issueProof: authority.issueProof,
      isOwnEndpoint,
    },
  } as never)
}

function toolContext(sessionId: string): ToolContext {
  return { sessionId, workdir: '/tmp' } as unknown as ToolContext
}

function mcpText(result: unknown): string {
  const content = typeof result === 'object' && result !== null ? (result as { content?: unknown }).content : undefined
  return (Array.isArray(content) ? content : [])
    .filter((item): item is { type: string; text?: string } => {
      return typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text'
    })
    .map((item) => item.text ?? '')
    .join('\n')
}

function startProxy(targetUrl: string, targetHeaders: Record<string, string>): Promise<Started> {
  const app = express()
  app.use(express.json())
  app.all('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'openfox-proxy-test', version: '1.0.0' })
    server.registerTool(
      'mcp_execute_tool',
      {
        inputSchema: {
          server_name: z.string(),
          tool_name: z.string(),
          arguments: z.record(z.string(), z.unknown()).optional(),
        },
      } as never,
      async (args: any) => {
        if (args.server_name !== 'openfox') {
          return { content: [{ type: 'text', text: 'unknown downstream' }], isError: true }
        }
        const client = await connectClient(targetUrl, targetHeaders)
        try {
          return (await client.callTool({
            name: args.tool_name,
            arguments: args.arguments ?? {},
          })) as never
        } finally {
          await client.close()
        }
      },
    )
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never)
    await server.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res, req.body)
  })
  const server = app.listen(0)
  return new Promise((resolve, reject) => {
    server.on('listening', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
    server.on('error', reject)
  })
}

describe('openfox MCP endpoint', () => {
  it('exposes the openfox tool set to an MCP client (local mode, no auth)', async () => {
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => false,
      isAuthorized: vi.fn(async () => false),
    })

    try {
      const client = await connectClient(started.url)
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual(
        [
          'openfox_answer',
          'openfox_confirm',
          'openfox_continue',
          'openfox_create_project',
          'openfox_create_session',
          'openfox_delete_project',
          'openfox_delete_session',
          'openfox_launch_workflow',
          'openfox_projects',
          'openfox_resume_workflow',
          'openfox_send_message',
          'openfox_session_detail',
          'openfox_session_metadata',
          'openfox_session_status',
          'openfox_sessions',
          'openfox_set_mode',
          'openfox_stop',
          'openfox_stop_workflow',
          'openfox_wait',
          'openfox_workflows',
        ].sort(),
      )

      const result = await client.callTool({ name: 'openfox_projects', arguments: {} })
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
      expect(JSON.parse(text)).toHaveLength(1)
      expect(JSON.parse(text)[0]).toMatchObject({ id: 'p-1', name: 'proj' })
      await client.close()
    } finally {
      await started.close()
    }
  }, 30000)

  it('returns 401 when auth is required and no valid token is presented', async () => {
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => true,
      isAuthorized: vi.fn(async () => false),
    })

    try {
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      })
      expect(res.status).toBe(401)
      await started.close()
    } catch {
      await started.close()
      throw new Error('unreachable')
    }
  })

  it('accepts a valid token via x-session-token or Authorization: Bearer', async () => {
    const authorize = vi.fn(async (req: any) => {
      const token = req.headers['x-session-token'] ?? String(req.headers['authorization'] ?? '').replace(/^Bearer /, '')
      return token === 'sekrit'
    })
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => true,
      isAuthorized: authorize,
    })

    try {
      // x-session-token header: full MCP round-trip
      const client = await connectClient(started.url, { 'x-session-token': 'sekrit' })
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(20)
      await client.close()

      // Bearer header: initialize must not 401
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sekrit' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      })
      expect(res.status).not.toBe(401)
      await started.close()
    } catch (error) {
      await started.close()
      throw error
    }
  }, 30000)

  it('delete_session uses trusted direct gateway identity over real HTTP', async () => {
    const authority = createTransportAuthority()
    const harness = makeDeleteHarness(authority)
    harness.addSession('caller')
    harness.addSession('peer')
    const started = await startRouter({
      resolveDeps: () => harness.deps,
      isAuthRequired: () => true,
      isAuthorized: vi.fn(async (req: any) => req.headers['x-session-token'] === 'sekrit'),
    })
    const gateway = createGateway(
      authority,
      (input) => input.kind === 'direct' && input.serverName === 'self-openfox' && input.url === started.url,
    )
    try {
      await gateway.addServer('self-openfox', {
        transport: 'http',
        url: started.url,
        headers: { 'x-session-token': 'sekrit' },
      })
      expect(gateway.getServer('self-openfox')?.config.sessionIdInjection).toBeUndefined()
      const tool = createMcpTools(gateway).find((candidate) => candidate.name === 'self-openfox_openfox_delete_session')
      expect(tool).toBeDefined()

      const result = await tool!.execute(
        {
          sessionId: 'peer',
          openfox_session_id: 'forged-caller',
          openfox_session_proof: 'forged-proof',
        },
        toolContext('caller'),
      )

      expect(result.success).toBe(true)
      expect(harness.deleted).toEqual(['peer'])
      expect(authority.issueProof).toHaveBeenCalledWith({
        callerSessionId: 'caller',
        toolName: 'openfox_delete_session',
        targetSessionId: 'peer',
      })
    } finally {
      await gateway.disconnectAll()
      await started.close()
    }
  }, 30000)

  it('delete_session uses trusted proxy gateway identity without sessionIdInjection', async () => {
    const authority = createTransportAuthority()
    const harness = makeDeleteHarness(authority)
    harness.addSession('caller')
    harness.addSession('peer')
    const started = await startRouter({
      resolveDeps: () => harness.deps,
      isAuthRequired: () => true,
      isAuthorized: vi.fn(async (req: any) => req.headers['x-session-token'] === 'sekrit'),
    })
    const proxy = await startProxy(started.url, { 'x-session-token': 'sekrit' })
    const gateway = createGateway(
      authority,
      (input) =>
        input.kind === 'proxy' &&
        input.serverName === 'trusted-proxy' &&
        input.targetServerName === 'openfox' &&
        started.url.includes('/mcp'),
    )
    try {
      await gateway.addServer('trusted-proxy', { transport: 'http', url: proxy.url })
      expect(gateway.getServer('trusted-proxy')?.config.sessionIdInjection).toBeUndefined()
      const tool = createMcpTools(gateway).find((candidate) => candidate.name === 'trusted-proxy_mcp_execute_tool')
      expect(tool).toBeDefined()

      const result = await tool!.execute(
        {
          server_name: 'openfox',
          tool_name: 'openfox_delete_session',
          arguments: {
            sessionId: 'peer',
            openfox_session_id: 'forged-caller',
            openfox_session_proof: 'forged-proof',
          },
        },
        toolContext('caller'),
      )

      expect(result.success).toBe(true)
      expect(harness.deleted).toEqual(['peer'])
      expect(authority.issueProof).toHaveBeenCalledWith({
        callerSessionId: 'caller',
        toolName: 'openfox_delete_session',
        targetSessionId: 'peer',
      })
    } finally {
      await gateway.disconnectAll()
      await proxy.close()
      await started.close()
    }
  }, 30000)

  it('delete_session rejects a global token without trusted caller proof', async () => {
    const authority = createTransportAuthority()
    const harness = makeDeleteHarness(authority)
    harness.addSession('caller')
    harness.addSession('peer')
    const started = await startRouter({
      resolveDeps: () => harness.deps,
      isAuthRequired: () => true,
      isAuthorized: vi.fn(async (req: any) => req.headers['x-session-token'] === 'sekrit'),
    })
    const client = await connectClient(started.url, { 'x-session-token': 'sekrit' })
    try {
      const result = await client.callTool({
        name: 'openfox_delete_session',
        arguments: {
          sessionId: 'peer',
          openfox_session_id: 'caller',
          openfox_session_proof: 'forged-proof',
        },
      })
      await client.close()

      expect(result.isError).toBe(true)
      expect(mcpText(result)).toContain('trusted OpenFox caller identity is required')
      expect(harness.deleted).toEqual([])
      expect(harness.sessions.has('peer')).toBe(true)
    } finally {
      await client.close().catch(() => undefined)
      await started.close()
    }
  }, 30000)

  it('delete_session rechecks guards and replay state over real HTTP', async () => {
    const authority = createTransportAuthority()
    const harness = makeDeleteHarness(authority)
    harness.addSession('caller')
    harness.addSession('other-project', { projectId: 'p-2' })
    harness.addSession('running', { isRunning: true })
    harness.addSession('manager-peer', { mode: 'manager' })
    harness.addSession('turns-running')
    harness.addSession('turns-manager')
    harness.addSession('replay')
    const started = await startRouter({
      resolveDeps: () => harness.deps,
      isAuthRequired: () => true,
      isAuthorized: vi.fn(async (req: any) => req.headers['x-session-token'] === 'sekrit'),
    })
    const gateway = createGateway(
      authority,
      (input) => input.kind === 'direct' && input.serverName === 'self-openfox' && input.url === started.url,
    )
    authority.setAfterIssue((input) => {
      if (input.targetSessionId === 'turns-running') {
        harness.sessions.get('turns-running')!.isRunning = true
      }
      if (input.targetSessionId === 'turns-manager') {
        harness.sessions.get('turns-manager')!.mode = 'manager'
      }
    })
    try {
      await gateway.addServer('self-openfox', {
        transport: 'http',
        url: started.url,
        headers: { 'x-session-token': 'sekrit' },
      })
      const tool = createMcpTools(gateway).find((candidate) => candidate.name === 'self-openfox_openfox_delete_session')
      expect(tool).toBeDefined()
      const callDelete = (sessionId: string) =>
        tool!.execute(
          {
            sessionId,
            openfox_session_id: 'forged-caller',
            openfox_session_proof: 'forged-proof',
          },
          toolContext('caller'),
        )

      const refused = []
      for (const sessionId of [
        'other-project',
        'running',
        'caller',
        'manager-peer',
        'turns-running',
        'turns-manager',
      ]) {
        refused.push(await callDelete(sessionId))
      }
      const first = await callDelete('replay')
      const duplicate = await callDelete('replay')

      expect(refused.every((result) => result.success === false)).toBe(true)
      expect(first.success).toBe(true)
      expect(duplicate.success).toBe(false)
      expect(duplicate.error).toMatch(/not found/i)
      expect(harness.deleted).toEqual(['replay'])
      expect(harness.sessions.get('turns-running')).toMatchObject({ isRunning: true })
      expect(harness.sessions.get('turns-manager')).toMatchObject({ mode: 'manager' })
      expect(harness.sessions.has('other-project')).toBe(true)
      expect(harness.sessions.has('running')).toBe(true)
      expect(harness.sessions.has('caller')).toBe(true)
      expect(harness.sessions.has('manager-peer')).toBe(true)
    } finally {
      await gateway.disconnectAll()
      await started.close()
    }
  }, 30000)

  it('returns 503 when the tool dependencies are not ready yet', async () => {
    const started = await startRouter({
      resolveDeps: () => null,
      isAuthRequired: () => false,
      isAuthorized: vi.fn(async () => true),
    })

    try {
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      })
      expect(res.status).toBe(503)
      await started.close()
    } catch {
      await started.close()
      throw new Error('unreachable')
    }
  })

  it('leaves other routes untouched', async () => {
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => false,
      isAuthorized: vi.fn(async () => false),
    })

    try {
      const res = await fetch(started.url.replace('/mcp', '/api/health'))
      expect(res.status).toBe(404)
      await started.close()
    } catch {
      await started.close()
      throw new Error('unreachable')
    }
  })
})
