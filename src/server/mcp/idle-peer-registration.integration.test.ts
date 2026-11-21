import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../shared/types.js'
import { getDatabase } from '../db/index.js'
import type { ServerHandle } from '../context.js'
import type { ToolContext } from '../tools/types.js'

const REPO_PACKAGE = join(import.meta.dirname, '../../../package.json')
const PEER_DELIVERY_PENDING: string = 'session.peer_delivery_pending'
const PEER_DELIVERY_DELIVERED: string = 'session.peer_delivery_delivered'

interface RegistrationNotice {
  count: number
  sample: string[]
  omitted: number
  reason: string
}

interface RegistrationDeps {
  listSessionIds: () => string[]
  callTool: () => Promise<unknown>
  schedule: (callback: () => void, delayMs: number) => () => void
  journal?: (line: string) => void
  attention?: (notice: RegistrationNotice) => void
}

interface RegistrationService {
  start: () => Promise<'ready' | 'degraded'>
  state: () => string
  audit: () => { state: string; sessionIds: string[] }
  register: (sessionId: string) => Promise<void>
}

interface RegistrationModule {
  IdlePeerRegistrationService: new (deps: RegistrationDeps) => RegistrationService
  drainPendingPeerDeliveries: () => Promise<void>
  recordPendingPeerDelivery: (delivery: {
    sessionId: string
    targetSessionId: string
    reason: 'blocked'
    error: string
    message: string
    peerId: string
  }) => void
  installIdlePeerRegistration: (
    deps: RegistrationDeps,
    deliver: (sessionId: string, peerId: string, message: string, msgSeq?: string) => Promise<{ success: boolean }>,
  ) => RegistrationService
  startsRegistrationFor?: (name: string) => boolean
}

const REGISTRATION_MODULE: string = './idle-peer-registration.js'

function loadRegistration(): Promise<RegistrationModule> {
  return import(REGISTRATION_MODULE) as Promise<RegistrationModule>
}

function peerIdFor(sessionId: string): string {
  const hex = createHash('sha256').update(sessionId).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function hubScript(): string {
  return `
const { createRequire } = require('module')
const { createHash } = require('crypto')
const { appendFileSync, readFileSync, watch } = require('fs')
const { createServer } = require('net')
const requireFromRepo = createRequire(process.env.HUB_REQUIRE_FROM)
const { McpServer } = requireFromRepo('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = requireFromRepo('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = requireFromRepo('zod')
const registered = new Set()
function peerIdFor(sessionId) {
  const hex = createHash('sha256').update(String(sessionId)).digest('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32)
}
function record(entry) {
  appendFileSync(process.env.HUB_LOG, JSON.stringify(entry) + '\\n')
}
function controlMode() {
  try { return readFileSync(process.env.HUB_CONTROL, 'utf8').trim() } catch { return '' }
}
function sendFails() {
  return controlMode() === 'fail'
}
const server = new McpServer({ name: 'hub-double', version: '0.0.0' })
const listener = createServer((socket) => {
  socket.end('open')
})
server.tool('mcp_execute_tool', {
  server_name: z.string(),
  tool_name: z.string(),
  arguments: z.any().optional(),
}, async (args) => {
  const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : {}
  const sessionId = typeof inner.openfox_session_id === 'string' ? inner.openfox_session_id : ''
  if (args.tool_name === 'hub_control') {
    const bound = listener.address()
    record({ tool: 'hub_control', ok: true, port: bound && bound.port, pid: process.pid })
    return { content: [{ type: 'text', text: 'ok' }] }
  }
  if (args.tool_name === 'ht_get_contact_info') {
    if (controlMode() === 'hang') {
      record({ tool: args.tool_name, sessionId, ok: false, error: 'hang' })
      return new Promise(() => {})
    }
    if (controlMode() === 'fail-contact') {
      record({ tool: args.tool_name, sessionId, ok: false, error: 'MCP error -32602: unknown peer' })
      return { isError: true, content: [{ type: 'text', text: 'MCP error -32602: unknown peer' }] }
    }
    if (!sessionId) {
      record({ tool: args.tool_name, sessionId, ok: false, error: 'missing session' })
      return { isError: true, content: [{ type: 'text', text: 'missing session' }] }
    }
    const peerId = peerIdFor(sessionId)
    const already = registered.has(sessionId)
    registered.add(sessionId)
    record({ tool: args.tool_name, sessionId, peerId, already, ok: true })
    return { content: [{ type: 'text', text: 'peer_id: ' + peerId }] }
  }
  if (args.tool_name === 'ht_send_to_peer') {
    const peerId = typeof inner.peer_id === 'string' ? inner.peer_id : ''
    const known = [...registered].some((id) => peerIdFor(id) === peerId)
    if (!known || sendFails()) {
      record({ tool: args.tool_name, sessionId, peerId, ok: false, error: 'MCP error -32602: unknown peer' })
      return { isError: true, content: [{ type: 'text', text: 'MCP error -32602: unknown peer' }] }
    }
    record({ tool: args.tool_name, sessionId, peerId, ok: true })
    return { content: [{ type: 'text', text: JSON.stringify({ delivery: 'notified' }) }] }
  }
  record({ tool: args.tool_name, sessionId, ok: false, error: 'unsupported tool' })
  return { isError: true, content: [{ type: 'text', text: 'unsupported tool' }] }
})
function waitReleased() {
  if (controlMode() !== 'hold') return Promise.resolve()
  return new Promise((resolve) => {
    const watcher = watch(process.env.HUB_CONTROL, () => {
      if (controlMode() === 'hold') return
      watcher.close()
      resolve()
    })
  })
}
function serve() {
  return waitReleased().then(() => new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const bound = listener.address()
      record({ event: 'bound', port: bound.port, pid: process.pid })
      server.connect(new StdioServerTransport()).then(() => {
        record({ event: 'serving', port: bound.port, pid: process.pid })
        resolve()
      }, reject)
    })
  }))
}
serve().catch((error) => {
  record({ event: 'fatal', error: String(error && error.stack || error) })
  process.exit(1)
})
`
}

interface HubRow {
  event?: string
  tool?: string
  sessionId?: string
  peerId?: string
  already?: boolean
  ok?: boolean
  error?: string
  port?: number
  pid?: number
  test?: string
  pending?: number
  registrations?: number
  idempotent?: boolean
}

async function readHub(logPath: string): Promise<HubRow[]> {
  try {
    const raw = await readFile(logPath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as HubRow)
  } catch {
    return []
  }
}

function deadlock<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock timeout: ${label}`)), 5_000)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function persistedMcpConfig(servers: Config['mcpServers']): string {
  const withoutCache: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(servers ?? {})) {
    const copy = { ...server } as Record<string, unknown>
    delete copy['cachedTools']
    withoutCache[name] = copy
  }
  return JSON.stringify({ mcpServers: withoutCache })
}

function whenWatched(file: string, ready: () => Promise<boolean>, label: string, anyChange = false): Promise<void> {
  let watcher: FSWatcher | undefined
  return deadlock(
    new Promise<void>((resolve, reject) => {
      const check = () => {
        void ready().then(
          (done) => {
            if (!done) return
            watcher?.close()
            resolve()
          },
          (error: unknown) => {
            watcher?.close()
            reject(error)
          },
        )
      }
      watcher = watch(dirname(file), (_event, filename) => {
        if (!anyChange && filename && filename !== basename(file)) return
        check()
      })
      check()
    }),
    label,
  ).finally(() => watcher?.close())
}

function processAlive(pid: number | null): void {
  if (pid === null) throw new Error('hub process is not running')
  process.kill(pid, 0)
}

function openSocket(port: number): Promise<void> {
  return deadlock(
    new Promise<void>((resolve, reject) => {
      const socket = connectTcp({ host: '127.0.0.1', port }, () => {
        socket.end()
        resolve()
      })
      socket.once('error', reject)
    }),
    'hub socket',
  )
}

interface Harness {
  server: ServerHandle
  root: string
  logPath: string
  controlPath: string
  base: string
}

async function startHarness(control: 'fail' | 'ok' | 'fail-contact' | 'hang' | 'hold'): Promise<Harness> {
  process.env['OPENFOX_MOCK_LLM'] = 'true'
  process.env['OPENFOX_SESSION_WORKER'] = 'false'
  const root = await mkdtemp(join(tmpdir(), 'openfox-idle-peer-'))
  const logPath = join(root, 'hub.jsonl')
  const controlPath = join(root, 'hub.control')
  const scriptPath = join(root, 'hub.cjs')
  await writeFile(controlPath, control)
  await writeFile(scriptPath, hubScript())
  const config: Config = {
    mode: 'test',
    llm: {
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'idle-peer-registration',
      backend: 'unknown',
      timeout: 30_000,
      idleTimeout: 30_000,
    },
    context: { maxTokens: 100_000, compactionThreshold: 0.85, compactionTarget: 0.6 },
    agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120_000 },
    server: { port: 0, host: '127.0.0.1' },
    database: { path: join(root, 'sessions.db') },
    logging: { level: 'error' },
    workdir: root,
    globalConfigPath: join(root, 'config.json'),
    mcpServers: {
      'mcp-lazy': {
        transport: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        env: { HUB_LOG: logPath, HUB_CONTROL: controlPath, HUB_REQUIRE_FROM: REPO_PACKAGE },
        sessionIdInjection: { 'llm-aether': 'openfox_session_id' },
      },
    },
  }
  await writeFile(config.globalConfigPath!, persistedMcpConfig(config.mcpServers))
  const { createServerHandle } = await import('../index.js')
  const server = await createServerHandle(config)
  const { port } = await server.start(0)
  return { server, root, logPath, controlPath, base: `http://127.0.0.1:${port}` }
}

async function stopHarness(harness: Harness | undefined): Promise<void> {
  if (harness) await harness.server.close().catch(() => {})
  const { closeDatabase } = await import('../db/index.js')
  const { resetAttentionService } = await import('../session/attention.js')
  const { setMcpTools } = await import('../tools/index.js')
  resetAttentionService()
  setMcpTools([])
  closeDatabase()
  delete process.env['OPENFOX_MOCK_LLM']
  delete process.env['OPENFOX_SESSION_WORKER']
  if (harness) await rm(harness.root, { recursive: true, force: true })
}

async function restart(harness: Harness): Promise<void> {
  await harness.server.close()
  const { createServerHandle } = await import('../index.js')
  const config = harness.server.ctx.config
  await mkdir(harness.root, { recursive: true })
  await writeFile(config.globalConfigPath!, persistedMcpConfig(config.mcpServers))
  harness.server = await createServerHandle(config)
  const { port } = await harness.server.start(0)
  harness.base = `http://127.0.0.1:${port}`
}

async function createSession(harness: Harness, title: string): Promise<string> {
  const projectDir = join(harness.root, title)
  await mkdir(projectDir, { recursive: true })
  const projectResponse = await fetch(`${harness.base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: title, workdir: projectDir }),
  })
  if (projectResponse.status !== 201) throw new Error(`project create failed: ${projectResponse.status}`)
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
  const sessionResponse = await fetch(`${harness.base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, title }),
  })
  if (sessionResponse.status !== 201) throw new Error(`session create failed: ${sessionResponse.status}`)
  return ((await sessionResponse.json()) as { session: { id: string } }).session.id
}

async function waitForHub(harness: Harness): Promise<void> {
  const configPath = harness.server.ctx.config.globalConfigPath
  if (!configPath) throw new Error('global config path is required')
  await whenWatched(
    configPath,
    async () => (await readFile(configPath, 'utf8').catch(() => '')).includes('"cachedTools"'),
    'mcp tool cache',
  )
}

function messageCount(sessionId: string): number {
  const row = getDatabase().prepare('SELECT message_count FROM sessions WHERE id = ?').get(sessionId) as
    { message_count: number } | undefined
  return row?.message_count ?? 0
}

async function assistantTurns(sessionId: string): Promise<number> {
  const { getEventStore } = await import('../events/index.js')
  return getEventStore()
    .getEvents(sessionId)
    .filter((event) => event.type === 'message.start' && (event.data as { role?: string }).role === 'assistant').length
}

describe.sequential('idle peer registration', () => {
  let probeRoot: string | undefined

  beforeAll(async () => {
    probeRoot = await mkdtemp(join(tmpdir(), 'openfox-hub-probe-'))
    const logPath = join(probeRoot, 'hub.jsonl')
    const controlPath = join(probeRoot, 'hub.control')
    const scriptPath = join(probeRoot, 'hub.cjs')
    await writeFile(controlPath, 'ok')
    await writeFile(scriptPath, hubScript())
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [scriptPath],
      env: {
        ...getDefaultEnvironment(),
        HUB_LOG: logPath,
        HUB_CONTROL: controlPath,
        HUB_REQUIRE_FROM: REPO_PACKAGE,
      },
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    const client = new Client({ name: 'hub-probe', version: '0.0.0' })
    try {
      await deadlock(client.connect(transport), 'mcp initialize')
      await whenWatched(logPath, async () => (await readHub(logPath)).some((row) => row.event === 'bound'), 'hub bind')
      const bound = (await readHub(logPath)).find((row) => row.event === 'bound')
      if (!bound?.port) throw new Error(`hub did not bind a socket: ${stderr}`)
      processAlive(transport.pid)
      await openSocket(bound.port)
      const control = await deadlock(
        client.callTool({
          name: 'mcp_execute_tool',
          arguments: { server_name: 'llm-aether', tool_name: 'hub_control', arguments: {} },
        }),
        'hub control',
      )
      if ('isError' in control && control.isError) {
        throw new Error(`hub control failed: ${JSON.stringify(control)} ${stderr}`)
      }
      processAlive(transport.pid)
      await appendFile(logPath, `${JSON.stringify({ event: 'ready', port: bound.port, pid: transport.pid })}\n`)
      const ready = (await readHub(logPath)).some((row) => row.event === 'ready')
      if (!ready) throw new Error('hub ready was not recorded after the control roundtrip')
      console.log(`HARNESS_READY port=${bound.port} pid=${transport.pid}`)
    } finally {
      await client.close().catch(() => {})
    }
  }, 30_000)

  afterAll(async () => {
    if (probeRoot) await rm(probeRoot, { recursive: true, force: true })
  })

  it('an idle session is reachable immediately after a gateway restart', async () => {
    const harness = await startHarness('ok')
    try {
      const senderId = await createSession(harness, `sender-${randomUUID()}`)
      const idleId = await createSession(harness, `idle-${randomUUID()}`)
      await restart(harness)
      await waitForHub(harness)
      const { createToolRegistry } = await import('../tools/index.js')
      const sent = await createToolRegistry().execute(
        'mcp-lazy_mcp_execute_tool',
        {
          server_name: 'llm-aether',
          tool_name: 'ht_send_to_peer',
          arguments: { peer_id: peerIdFor(idleId), message: 'go' },
        },
        {
          workdir: harness.root,
          sessionId: senderId,
          sessionManager: harness.server.ctx.sessionManager,
        } as ToolContext,
      )
      const deliveries = (await readHub(harness.logPath)).filter((row) => row.tool === 'ht_send_to_peer' && row.ok)
      expect({
        error: sent.error ?? null,
        deliveries: deliveries.length,
        idleMessages: messageCount(idleId),
        idleTurns: await assistantTurns(idleId),
      }).toEqual({ error: null, deliveries: 1, idleMessages: 0, idleTurns: 0 })
    } finally {
      await stopHarness(harness)
    }
  }, 60_000)

  it('an unavailable peer leaves a durable retryable delivery record', async () => {
    const harness = await startHarness('fail')
    try {
      const creatorId = await createSession(harness, `creator-${randomUUID()}`)
      const stalledId = await createSession(harness, `stalled-${randomUUID()}`)
      const { setSessionCreatedBy } = await import('../db/sessions.js')
      setSessionCreatedBy(stalledId, creatorId)
      await waitForHub(harness)
      const { getAttentionService } = await import('../session/attention.js')
      getAttentionService().observeBlocked(stalledId, 'blocked in test')
      await whenWatched(
        harness.server.ctx.config.database.path,
        async () => {
          const { getEventStore } = await import('../events/index.js')
          return getEventStore()
            .getEvents(stalledId)
            .some((event) => event.type === PEER_DELIVERY_PENDING)
        },
        'pending delivery',
        true,
      )
      const { getEventStore } = await import('../events/index.js')
      const pending = getEventStore()
        .getEvents(stalledId)
        .filter((event) => event.type === PEER_DELIVERY_PENDING)
      const hub = (await readHub(harness.logPath)).filter((row) => row.tool === 'ht_send_to_peer').at(-1)
      expect({ hub, pending: pending.map((event) => event.data) }).toEqual({
        hub: expect.objectContaining({ ok: false, error: expect.stringMatching(/unknown peer/) }),
        pending: [
          expect.objectContaining({
            targetSessionId: creatorId,
            reason: 'blocked',
            error: expect.stringMatching(/unknown peer/),
          }),
        ],
      })
      const message = (pending[0]?.data as { message?: string } | undefined)?.message ?? ''
      expect(Buffer.byteLength(message)).toBeGreaterThan(0)
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(800)
      await writeFile(harness.controlPath, 'ok')
      const registration = await loadRegistration()
      await registration.drainPendingPeerDeliveries()
      expect((await readHub(harness.logPath)).filter((row) => row.tool === 'ht_send_to_peer' && row.ok)).toHaveLength(1)
      expect(
        getEventStore()
          .getEvents(stalledId)
          .filter((event) => event.type === PEER_DELIVERY_DELIVERED),
      ).toHaveLength(1)
      await registration.drainPendingPeerDeliveries()
      expect((await readHub(harness.logPath)).filter((row) => row.tool === 'ht_send_to_peer' && row.ok)).toHaveLength(1)
    } finally {
      await stopHarness(harness)
    }
  }, 60_000)

  it('peer registration neither launches a turn nor duplicates a live peer', async () => {
    const harness = await startHarness('ok')
    try {
      await waitForHub(harness)
      const idleId = await createSession(harness, `idle-${randomUUID()}`)
      const before = messageCount(idleId)
      await restart(harness)
      await waitForHub(harness)
      await restart(harness)
      await waitForHub(harness)
      const contacts = (await readHub(harness.logPath)).filter(
        (row) => row.tool === 'ht_get_contact_info' && row.sessionId === idleId,
      )
      const peerId = peerIdFor(idleId)
      expect(contacts.map((row) => row.peerId)).toEqual([peerId, peerId, peerId])
      expect(messageCount(idleId)).toBe(before)
      expect(await assistantTurns(idleId)).toBe(0)
      let calls = 0
      let release = (): void => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const registration = await loadRegistration()
      const service = new registration.IdlePeerRegistrationService({
        listSessionIds: () => [],
        callTool: () => {
          calls += 1
          return held.then(() => ({ success: true, output: `peer_id: ${peerIdFor('same')}` }))
        },
        schedule: () => () => {},
      })
      const pending = Promise.all([service.register('same'), service.register('same')])
      expect(calls).toBe(1)
      release()
      await pending
      expect(calls).toBe(1)
    } finally {
      await stopHarness(harness)
    }
  }, 60_000)

  it('a registration deadline exposes degraded state exactly once', async () => {
    let api: RegistrationModule
    try {
      api = await loadRegistration()
    } catch (error) {
      throw new Error(
        `degraded state is silent: no registration deadline journal or attention (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    const ids = Array.from({ length: 20 }, (_value, index) => `s${String(index + 1).padStart(2, '0')}`)
    const journal: string[] = []
    const notices: Array<{ count: number; sample: string[]; omitted: number; reason: string }> = []
    let inFlight = 0
    const timers: Array<() => void> = []
    const scheduled: number[] = []
    const service = new api.IdlePeerRegistrationService({
      listSessionIds: () => ids,
      callTool: () => {
        inFlight += 1
        return new Promise(() => {})
      },
      schedule: (callback, delayMs) => {
        scheduled.push(delayMs)
        timers.push(callback)
        return () => {}
      },
      journal: (line) => journal.push(line),
      attention: (notice) => notices.push(notice),
    })
    const done = service.start()
    await Promise.resolve()
    expect(inFlight).toBe(16)
    expect(scheduled).toEqual([30_000])
    const fire = timers[0]
    if (!fire) throw new Error('deadline was not scheduled at 30000ms')
    fire()
    await expect(done).resolves.toBe('degraded')
    expect(service.state()).toBe('degraded')
    const sample = ids.slice(0, 8)
    const omitted = ids.slice(8)
    expect(journal).toHaveLength(1)
    expect(journal[0]).toContain('degraded')
    expect(journal[0]).toContain('count=20')
    expect(journal[0]).toContain('omitted=12')
    for (const id of sample) expect(journal[0]).toContain(id)
    for (const id of omitted) expect(journal[0]).not.toContain(id)
    expect(notices).toEqual([{ count: 20, sample, omitted: 12, reason: 'registration_deadline' }])
    expect(service.audit()).toEqual({ state: 'degraded', sessionIds: ids })
    fire()
    await expect(service.start()).resolves.toBe('degraded')
    expect(journal).toHaveLength(1)
    expect(notices).toHaveLength(1)
    expect(service.audit()).toEqual({ state: 'degraded', sessionIds: ids })
  })
})

describe.sequential('idle peer registration B1-B6', () => {
  it.fails('a rejected registration is not ready', async () => {
    const api = await loadRegistration()
    const service = new api.IdlePeerRegistrationService({
      listSessionIds: () => ['s1'],
      callTool: () => Promise.reject(new Error('hub down')),
      schedule: () => () => {},
    })
    const outcome = await service.start()
    console.log(`DEFECT ${JSON.stringify({ test: 'B1-reject', outcome })}`)
    expect(outcome).toBe('degraded')
    expect(service.audit()).toMatchObject({ state: 'degraded', sessionIds: ['s1'] })
  })

  it.fails('a false registration result is not ready', async () => {
    const api = await loadRegistration()
    const service = new api.IdlePeerRegistrationService({
      listSessionIds: () => ['s1'],
      callTool: () => Promise.resolve({ success: false, error: 'unknown peer' }),
      schedule: () => () => {},
    })
    const outcome = await service.start()
    console.log(`DEFECT ${JSON.stringify({ test: 'B1-false', outcome })}`)
    expect(outcome).toBe('degraded')
  })

  it.fails('registration starts only for mcp-lazy', async () => {
    const api = await loadRegistration()
    const gate = (api as { startsRegistrationFor?: (name: string) => boolean }).startsRegistrationFor
    const observed = {
      other: gate ? gate('other') : true,
      lazy: gate ? gate('mcp-lazy') : false,
    }
    console.log(`DEFECT ${JSON.stringify({ test: 'B1-discovery', ...observed })}`)
    expect(observed).toEqual({ other: false, lazy: true })
  })

  it.fails(
    'barrier wait does not start before mcp-lazy discovery',
    async () => {
      const api = await loadRegistration()
      const managerMod = await import('./manager.js')
      const originalStart = api.IdlePeerRegistrationService.prototype.start
      const originalSet = managerMod.setPeerSendBarrier
      let lazyLog = ''
      let starts = 0
      let installed: (() => Promise<void>) | null = null
      api.IdlePeerRegistrationService.prototype.start = function (this: RegistrationService) {
        let discovered = false
        if (lazyLog.length > 0) {
          try {
            discovered = readFileSync(lazyLog, 'utf8').includes('"event":"serving"')
          } catch {
            discovered = false
          }
        }
        if (!discovered) starts += 1
        return originalStart.call(this)
      }
      const spy = vi.spyOn(managerMod, 'setPeerSendBarrier').mockImplementation((barrier) => {
        installed = barrier
        originalSet(barrier)
      })
      let harness: Harness | undefined
      try {
        harness = await startHarness('hold')
        lazyLog = harness.logPath
        let discoveredDuringBoot = false
        try {
          discoveredDuringBoot = readFileSync(lazyLog, 'utf8').includes('"event":"serving"')
        } catch {
          discoveredDuringBoot = false
        }
        if (!installed) throw new Error('precondition: production barrier was not installed')
        if (discoveredDuringBoot) throw new Error('precondition: mcp-lazy discovered before the barrier')
        const before = starts
        const pending = installed().then(
          () => undefined,
          () => undefined,
        )
        await Promise.resolve()
        const startsBeforeDiscovery = starts - before
        console.log(
          `DEFECT ${JSON.stringify({ test: 'B1-barrier', startsBeforeDiscovery, discovered: false, before })}`,
        )
        expect(startsBeforeDiscovery).toBe(0)
        await writeFile(harness.controlPath, 'ok')
        await deadlock(pending, 'barrier wait')
      } finally {
        spy.mockRestore()
        api.IdlePeerRegistrationService.prototype.start = originalStart
        if (harness) await writeFile(harness.controlPath, 'ok').catch(() => {})
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails(
    'degraded audit and attention survive a new service',
    async () => {
      const harness = await startHarness('ok')
      try {
        await waitForHub(harness)
        const ids: string[] = []
        for (let index = 0; index < 20; index += 1) ids.push(await createSession(harness, `audit-${index}`))
        const api = await loadRegistration()
        const timers: Array<() => void> = []
        const service = new api.IdlePeerRegistrationService({
          listSessionIds: () => ids,
          callTool: () => new Promise(() => {}),
          schedule: (callback) => {
            timers.push(callback)
            return () => {}
          },
        })
        const done = service.start()
        const fire = timers[0]
        if (!fire) throw new Error('deadline was not scheduled')
        fire()
        await done
        const reloaded = new api.IdlePeerRegistrationService({
          listSessionIds: () => [],
          callTool: () => Promise.resolve({ success: true }),
          schedule: () => () => {},
        })
        const { getEventStore } = await import('../events/index.js')
        const attention = ids.flatMap((id) =>
          getEventStore()
            .getEvents(id)
            .filter((event) => String(event.type) === 'session.peer_registration_attention'),
        )
        const durable = reloaded.audit()
        console.log(
          `DEFECT ${JSON.stringify({ test: 'B2', state: durable.state, durable: durable.sessionIds.length, attention: attention.length })}`,
        )
        expect({ state: durable.state, sessionIds: durable.sessionIds, attention: attention.length }).toEqual({
          state: 'degraded',
          sessionIds: ids,
          attention: 1,
        })
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails(
    'a failed contact lookup leaves a pending delivery',
    async () => {
      const harness = await startHarness('fail-contact')
      try {
        const creatorId = await createSession(harness, `creator-${randomUUID()}`)
        const stalledId = await createSession(harness, `stalled-${randomUUID()}`)
        const { setSessionCreatedBy } = await import('../db/sessions.js')
        setSessionCreatedBy(stalledId, creatorId)
        await waitForHub(harness)
        const { getAttentionService } = await import('../session/attention.js')
        getAttentionService().observeBlocked(stalledId, 'blocked in test')
        const { getEventStore } = await import('../events/index.js')
        await whenWatched(
          harness.server.ctx.config.database.path,
          async () =>
            getEventStore()
              .getEvents(stalledId)
              .some((event) => event.type === PEER_DELIVERY_PENDING),
          'contact lookup pending',
          true,
        )
        const pending = getEventStore()
          .getEvents(stalledId)
          .filter((event) => event.type === PEER_DELIVERY_PENDING)
        console.log(`DEFECT ${JSON.stringify({ test: 'B3-lookup', pending: pending.length })}`)
        expect(pending).toHaveLength(1)
        expect(pending[0]?.data).toMatchObject({
          targetSessionId: creatorId,
          reason: 'blocked',
          error: expect.stringMatching(/unknown peer/),
        })
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails(
    'a gateway restart drains a pending delivery',
    async () => {
      const harness = await startHarness('fail')
      try {
        const creatorId = await createSession(harness, `creator-${randomUUID()}`)
        const stalledId = await createSession(harness, `stalled-${randomUUID()}`)
        const { setSessionCreatedBy } = await import('../db/sessions.js')
        setSessionCreatedBy(stalledId, creatorId)
        await waitForHub(harness)
        const { getAttentionService } = await import('../session/attention.js')
        getAttentionService().observeBlocked(stalledId, 'blocked in test')
        await whenWatched(
          harness.server.ctx.config.database.path,
          async () => {
            const { getEventStore } = await import('../events/index.js')
            return getEventStore()
              .getEvents(stalledId)
              .some((event) => event.type === PEER_DELIVERY_PENDING)
          },
          'pending delivery',
          true,
        )
        await writeFile(harness.controlPath, 'ok')
        await restart(harness)
        await waitForHub(harness)
        const { getEventStore } = await import('../events/index.js')
        await whenWatched(
          harness.server.ctx.config.database.path,
          async () =>
            getEventStore()
              .getEvents(stalledId)
              .some((event) => event.type === PEER_DELIVERY_DELIVERED),
          'restart drain',
          true,
        ).catch(() => {})
        const delivered = getEventStore()
          .getEvents(stalledId)
          .filter((event) => event.type === PEER_DELIVERY_DELIVERED)
        const sends = (await readHub(harness.logPath)).filter((row) => row.tool === 'ht_send_to_peer' && row.ok)
        console.log(
          `DEFECT ${JSON.stringify({ test: 'B3-restart', delivered: delivered.length, sends: sends.length })}`,
        )
        expect(delivered).toHaveLength(1)
        expect(sends).toHaveLength(1)
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails(
    'pending records stay bounded and drop secrets',
    async () => {
      const harness = await startHarness('ok')
      try {
        const sessionId = await createSession(harness, `bounded-${randomUUID()}`)
        const api = await loadRegistration()
        const secret = 'sk-secret-token'
        api.recordPendingPeerDelivery({
          sessionId,
          targetSessionId: sessionId,
          reason: 'blocked',
          error: `${secret} ${'e'.repeat(100_000)}`,
          message: `${secret} ${'m'.repeat(100_000)}`,
          peerId: 'peer',
        })
        const { getEventStore } = await import('../events/index.js')
        const stored = getEventStore()
          .getEvents(sessionId)
          .find((event) => event.type === PEER_DELIVERY_PENDING)?.data as
          { error?: string; message?: string } | undefined
        const error = stored?.error ?? ''
        const message = stored?.message ?? ''
        console.log(
          `DEFECT ${JSON.stringify({ test: 'B4-bounds', errorBytes: Buffer.byteLength(error), messageBytes: Buffer.byteLength(message), secret: error.includes(secret) || message.includes(secret) })}`,
        )
        expect(Buffer.byteLength(error)).toBeLessThanOrEqual(240)
        expect(Buffer.byteLength(message)).toBeLessThanOrEqual(800)
        expect(error.includes(secret) || message.includes(secret)).toBe(false)
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails(
    'one crashed delivery is retried once under the same msg_seq',
    async () => {
      const harness = await startHarness('ok')
      try {
        const sessionId = await createSession(harness, `crash-${randomUUID()}`)
        const api = await loadRegistration()
        const seen = new Map<string, number>()
        let crash = true
        api.installIdlePeerRegistration(
          {
            listSessionIds: () => [sessionId],
            callTool: () => Promise.resolve({ success: true }),
            schedule: () => () => {},
          },
          (id, peerId, message, msgSeq) => {
            const seq = msgSeq && msgSeq.length > 0 ? msgSeq : 'missing'
            seen.set(seq, (seen.get(seq) ?? 0) + 1)
            if (crash) {
              crash = false
              throw new Error('crash after accept')
            }
            void id
            void peerId
            void message
            return Promise.resolve({ success: true })
          },
        )
        api.recordPendingPeerDelivery({
          sessionId,
          targetSessionId: sessionId,
          reason: 'blocked',
          error: 'unknown peer',
          message: 'retry me',
          peerId: 'peer',
        })
        await api.drainPendingPeerDeliveries().catch(() => {})
        await api.drainPendingPeerDeliveries()
        const seqs = [...seen.keys()]
        console.log(`DEFECT ${JSON.stringify({ test: 'B4-seq', seqs })}`)
        expect(seqs).toEqual([expect.not.stringMatching(/^missing$/)])
        expect(seen.get(seqs[0] ?? '')).toBe(2)
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails(
    'two drains send one delivery',
    async () => {
      const harness = await startHarness('ok')
      try {
        const sessionId = await createSession(harness, `race-${randomUUID()}`)
        const api = await loadRegistration()
        let sends = 0
        let release = (): void => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        api.installIdlePeerRegistration(
          {
            listSessionIds: () => [sessionId],
            callTool: () => Promise.resolve({ success: true }),
            schedule: () => () => {},
          },
          () => {
            sends += 1
            return held.then(() => ({ success: true }))
          },
        )
        api.recordPendingPeerDelivery({
          sessionId,
          targetSessionId: sessionId,
          reason: 'blocked',
          error: 'unknown peer',
          message: 'once',
          peerId: 'peer',
        })
        const pending = Promise.all([api.drainPendingPeerDeliveries(), api.drainPendingPeerDeliveries()])
        await Promise.resolve()
        console.log(`DEFECT ${JSON.stringify({ test: 'B4-race', sends })}`)
        expect(sends).toBe(1)
        release()
        await pending
        expect(sends).toBe(1)
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )

  it.fails('register joins the sweep and forgets a deleted session', async () => {
    const api = await loadRegistration()
    let active = 0
    let maxActive = 0
    const service = new api.IdlePeerRegistrationService({
      listSessionIds: () => Array.from({ length: 20 }, (_value, index) => `s${index}`),
      callTool: () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        return new Promise(() => {})
      },
      schedule: () => () => {},
    })
    void service.start()
    void service.register('extra')
    await Promise.resolve()
    const forget = (service as { forget?: (sessionId: string) => void }).forget
    forget?.('s0')
    console.log(
      `DEFECT ${JSON.stringify({ test: 'B5-flight', maxActive, forgot: typeof forget === 'function', keeps: service.audit().sessionIds.includes('s0') })}`,
    )
    expect({
      maxActive,
      forgot: typeof forget === 'function',
      keeps: service.audit().sessionIds.includes('s0'),
    }).toEqual({
      maxActive: 16,
      forgot: true,
      keeps: false,
    })
  })

  it.fails('an inflight registration can run again after it settles', async () => {
    const api = await loadRegistration()
    let calls = 0
    let release = (): void => {}
    const service = new api.IdlePeerRegistrationService({
      listSessionIds: () => [],
      callTool: () => {
        calls += 1
        return new Promise((resolve) => {
          release = () => resolve({ success: true })
        })
      },
      schedule: () => () => {},
    })
    const first = service.register('same')
    expect(calls).toBe(1)
    release()
    await first
    const second = service.register('same')
    console.log(`DEFECT ${JSON.stringify({ test: 'B5-inflight', calls })}`)
    expect(calls).toBe(2)
    release()
    await second
  })

  it.fails(
    'session creation does not block on registration',
    async () => {
      const harness = await startHarness('hang')
      try {
        await waitForHub(harness)
        const projectDir = join(harness.root, 'fast')
        await mkdir(projectDir, { recursive: true })
        const projectResponse = await fetch(`${harness.base}/api/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'fast', workdir: projectDir }),
        })
        if (projectResponse.status !== 201) throw new Error(`project create failed: ${projectResponse.status}`)
        const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id
        let status = 0
        try {
          const response = await fetch(`${harness.base}/api/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectId, title: 'fast' }),
            signal: AbortSignal.timeout(4_000),
          })
          status = response.status
        } catch {
          status = 0
        }
        console.log(`DEFECT ${JSON.stringify({ test: 'B5-post', status })}`)
        expect(status).toBe(201)
      } finally {
        await stopHarness(harness)
      }
    },
    60_000,
  )
})
