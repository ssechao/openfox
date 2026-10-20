import Database from 'better-sqlite3'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir, cpus, platform, arch } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import type { Config } from '../../src/shared/types.js'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(SELF, '../../..')
const MODEL = 'bench-model'
const WARMUP = 'BENCH-WARMUP'

interface Options {
  repo: string
  fragments: number
  calls: number
  fragmentsPerSecond: number
  probeIntervalMs: number
  sessionPollMs: number
  idleProbeMs: number
  timeoutMs: number
  out: string | undefined
  label: string
}

interface LlmStats {
  callsServed: number
  fragmentsSent: number
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function numberOption(name: string, env: string, fallback: number): number {
  const raw = argument(name) ?? process.env[env]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}: ${raw}`)
  return value
}

function parseOptions(): Options {
  return {
    repo: resolve(argument('repo') ?? process.env['BENCH_REPO'] ?? REPO_ROOT),
    fragments: numberOption('fragments', 'BENCH_FRAGMENTS', 300_000),
    calls: numberOption('calls', 'BENCH_CALLS', 830),
    fragmentsPerSecond: numberOption('rate', 'BENCH_FRAGMENTS_PER_SECOND', 3000),
    probeIntervalMs: numberOption('probe-interval', 'BENCH_PROBE_INTERVAL_MS', 25),
    sessionPollMs: numberOption('session-poll', 'BENCH_SESSION_POLL_MS', 5000),
    idleProbeMs: numberOption('idle-probe', 'BENCH_IDLE_PROBE_MS', 3000),
    timeoutMs: numberOption('timeout', 'BENCH_TIMEOUT_MS', 45 * 60_000),
    out: argument('out') ?? process.env['BENCH_OUT'],
    label: argument('label') ?? process.env['BENCH_LABEL'] ?? 'run',
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const tick = () => new Promise<void>((done) => setImmediate(done))

function quantiles(samples: number[]) {
  const values = [...samples].sort((a, b) => a - b)
  const at = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0
  const round = (value: number) => Math.round(value * 10) / 10
  return {
    samples: values.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(values.at(-1) ?? 0),
    over100ms: values.filter((value) => value > 100).length,
    over1s: values.filter((value) => value > 1000).length,
  }
}

function fragmentsForCall(call: number, options: Pick<Options, 'fragments' | 'calls'>): number {
  return (
    Math.floor(((call + 1) * options.fragments) / options.calls) -
    Math.floor((call * options.fragments) / options.calls)
  )
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'bench',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const part of req) body += String(part)
  return body
}

async function writeWithBackpressure(res: ServerResponse, data: string): Promise<void> {
  if (res.write(data)) return
  await new Promise<void>((done) => {
    const finish = () => {
      res.off('drain', finish)
      res.off('close', finish)
      done()
    }
    res.once('drain', finish)
    res.once('close', finish)
  })
}

async function llmRole(): Promise<void> {
  const options = JSON.parse(argument('options') ?? '{}') as Options
  const stats: LlmStats = { callsServed: 0, fragmentsSent: 0 }
  const burstEveryMs = 10
  const burst = Math.max(1, Math.round((options.fragmentsPerSecond * burstEveryMs) / 1000))

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', max_model_len: 262144 }] }))
        return
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.statusCode = 404
        res.end('{}')
        return
      }
      const request = JSON.parse(body || '{}') as { stream?: boolean }
      const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }
      if (!request.stream) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            id: 'bench',
            object: 'chat.completion',
            model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Bench' }, finish_reason: 'stop' }],
            usage,
          }),
        )
        return
      }

      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      if (body.includes(WARMUP)) {
        res.write(chunk({ reasoning_content: 'warm' }))
        res.write(chunk({ content: 'ok' }))
        res.write(chunk({}, 'stop'))
        res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      const call = stats.callsServed++
      let closed = false
      res.on('close', () => {
        closed = true
      })

      const total = fragmentsForCall(call, options)
      let sent = 0
      while (sent < total && !closed) {
        const started = performance.now()
        let payload = ''
        let written = 0
        for (; written < burst && sent < total; written++, sent++) {
          payload += chunk({ reasoning_content: `c${call}w${sent} ` })
        }
        await writeWithBackpressure(res, payload)
        stats.fragmentsSent += written
        const wait = burstEveryMs - (performance.now() - started)
        if (wait > 0) await sleep(wait)
        else await tick()
      }
      if (closed) return

      if (call < options.calls - 1) {
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call-${call}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'bench.txt' }) },
              },
            ],
          }),
        )
        res.write(chunk({}, 'tool_calls'))
      } else {
        res.write(chunk({ content: 'Done.' }))
        res.write(chunk({}, 'stop'))
      }
      res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
      res.end('data: [DONE]\n\n')
    })().catch((error: unknown) => {
      process.stderr.write(`[llm] ${error instanceof Error ? error.message : String(error)}\n`)
      res.destroy()
    })
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LLM server has no port')
  process.on('message', (message) => {
    if (message === 'stats') process.send?.({ stats })
  })
  process.send?.({ port: address.port })
}

async function serverRole(): Promise<void> {
  const repo = argument('repo')!
  type ServerModule = typeof import('../../src/server/index.js')
  type ConfigModule = typeof import('../../src/server/config.js')
  const { createServerHandle } = (await import(pathToFileURL(join(repo, 'src/server/index.ts')).href)) as ServerModule
  const { loadConfig } = (await import(pathToFileURL(join(repo, 'src/server/config.ts')).href)) as ConfigModule

  const config: Config = loadConfig()
  config.mode = 'test'
  config.globalConfigPath = argument('global-config')!
  const handle = await createServerHandle(config)
  const { port } = await handle.start(0)
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  process.on('message', (message) => {
    if (message === 'loop-reset') loop.reset()
    if (message === 'loop-stats') {
      const ms = (ns: number) => Math.round(ns / 1e5) / 10
      process.send?.({
        loop: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) },
      })
    }
    if (message === 'close') void handle.close().then(() => process.exit(0))
  })
  process.send?.({ port })
}

function forkRole(role: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  return fork(SELF, [`--role=${role}`, ...args], {
    cwd,
    env,
    execArgv: ['--import', import.meta.resolve('tsx/esm')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

function waitForMessage<T>(child: ChildProcess, key: string, timeoutMs: number): Promise<T> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${key}`)), timeoutMs)
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object' && key in message) {
        clearTimeout(timer)
        child.off('message', onMessage)
        done((message as Record<string, T>)[key] as T)
      }
    }
    child.on('message', onMessage)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`Child exited (${code}) before sending ${key}`))
    })
  })
}

function isolatedEnv(root: string, dbPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('OPENFOX_') && !key.startsWith('XDG_')) env[key] = value
  }
  return {
    ...env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
    OPENFOX_DB_PATH: dbPath,
    OPENFOX_LOG_LEVEL: 'error',
    OPENFOX_DISABLE_AUTO_SESSION_TITLE: 'true',
  }
}

async function api<T>(base: string, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(base + path, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

async function probeLoop(url: string, intervalMs: number, samples: number[], stop: { done: boolean }): Promise<void> {
  while (!stop.done) {
    const started = performance.now()
    try {
      const response = await fetch(url)
      await response.arrayBuffer()
      samples.push(performance.now() - started)
    } catch {
      samples.push(performance.now() - started)
    }
    const wait = intervalMs - (performance.now() - started)
    if (wait > 0) await sleep(wait)
  }
}

function databaseStats(dbPath: string, sessionId: string) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const count = (where: string) =>
      (
        db.prepare(`SELECT COUNT(*) AS count FROM events WHERE session_id = ? ${where}`).get(sessionId) as {
          count: number
        }
      ).count
    const maxSeq = (
      db.prepare('SELECT MAX(seq) AS seq FROM events WHERE session_id = ?').get(sessionId) as {
        seq: number
      }
    ).seq
    return {
      rowsAtEnd: count(''),
      thinkingRows: count(`AND event_type = 'message.thinking'`),
      snapshotRows: count(`AND event_type = 'turn.snapshot'`),
      eventsAppended: maxSeq,
    }
  } finally {
    db.close()
  }
}

async function orchestrate(): Promise<void> {
  const options = parseOptions()
  const root = await mkdtemp(join(tmpdir(), 'openfox-stream-bench-'))
  const workdir = join(root, 'project')
  const dbPath = join(root, 'sessions.db')
  await mkdir(join(root, 'home'), { recursive: true })
  await mkdir(workdir, { recursive: true })
  await writeFile(join(workdir, 'bench.txt'), 'stream batching bench\n', 'utf-8')

  const env = isolatedEnv(root, dbPath)
  const children: ChildProcess[] = []
  const stderr: string[] = []
  const track = (child: ChildProcess, name: string) => {
    children.push(child)
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (data: Buffer) => {
      stderr.push(`[${name}] ${data.toString()}`)
      if (stderr.length > 200) stderr.shift()
    })
    return child
  }

  try {
    const llm = track(forkRole('llm', [`--options=${JSON.stringify(options)}`], env, root), 'llm')
    const llmPort = await waitForMessage<number>(llm, 'port', 30_000)
    const server = track(
      forkRole(
        'server',
        [`--repo=${options.repo}`, `--global-config=${join(root, 'config.json')}`],
        { ...env, OPENFOX_LLM_URL: `http://127.0.0.1:${llmPort}/v1` },
        root,
      ),
      'server',
    )
    const port = await waitForMessage<number>(server, 'port', 120_000)
    const base = `http://127.0.0.1:${port}`

    await api(base, '/api/providers', {
      method: 'POST',
      body: {
        name: 'Bench',
        url: `http://127.0.0.1:${llmPort}/v1`,
        backend: 'vllm',
        model: MODEL,
        isLocal: true,
        apiProtocol: 'chat-completions',
      },
    })
    const { project } = await api<{ project: { id: string } }>(base, '/api/projects', {
      method: 'POST',
      body: { name: 'Stream bench', workdir },
    })
    const createSession = async (title: string) =>
      (
        await api<{ session: { id: string } }>(base, '/api/sessions', {
          method: 'POST',
          body: { projectId: project.id, title },
        })
      ).session.id

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((done, fail) => {
      ws.once('open', () => done())
      ws.once('error', fail)
    })
    let liveThinking = 0
    const running = new Set<string>()
    const turnEnded = new Map<string, number>()
    ws.on('message', (raw: WebSocket.RawData) => {
      const text = raw.toString()
      if (text.startsWith('{"type":"chat.thinking"')) {
        liveThinking++
        return
      }
      if (!text.startsWith('{"type":"session.running"')) return
      const message = JSON.parse(text) as { sessionId: string; payload: { isRunning: boolean } }
      if (message.payload.isRunning) running.add(message.sessionId)
      else if (running.has(message.sessionId) && !turnEnded.has(message.sessionId)) {
        turnEnded.set(message.sessionId, performance.now())
      }
    })
    const waitForTurn = async (sessionId: string, since: number): Promise<number | undefined> => {
      while (!turnEnded.has(sessionId)) {
        if (performance.now() - since > options.timeoutMs) return undefined
        await sleep(100)
      }
      return turnEnded.get(sessionId)
    }

    const warmup = await createSession('Warm-up')
    const warmupStartedAt = performance.now()
    await api(base, `/api/sessions/${warmup}/message`, { method: 'POST', body: { content: WARMUP } })
    if ((await waitForTurn(warmup, warmupStartedAt)) === undefined) throw new Error('Warm-up turn did not finish')
    liveThinking = 0

    const sessionId = await createSession('Stream bench')

    const idle: number[] = []
    const idleStop = { done: false }
    const idleLoop = probeLoop(`${base}/api/config`, options.probeIntervalMs, idle, idleStop)
    await sleep(options.idleProbeMs)
    idleStop.done = true
    await idleLoop

    const configSamples: number[] = []
    const sessionSamples: number[] = []
    const stop = { done: false }
    const probes = [probeLoop(`${base}/api/config`, options.probeIntervalMs, configSamples, stop)]
    if (options.sessionPollMs > 0) {
      probes.push(probeLoop(`${base}/api/sessions/${sessionId}`, options.sessionPollMs, sessionSamples, stop))
    }

    server.send('loop-reset')
    const startedAt = performance.now()
    await api(base, `/api/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { content: 'Run the long task.' },
    })
    const turnEndedAt = await waitForTurn(sessionId, startedAt)
    const timedOut = turnEndedAt === undefined
    const endedAt = turnEndedAt ?? performance.now()
    stop.done = true
    await Promise.all(probes)

    server.send('loop-stats')
    const serverEventLoopDelayMs = await waitForMessage<Record<string, number>>(server, 'loop', 30_000)
    llm.send('stats')
    const llmStats = await waitForMessage<LlmStats>(llm, 'stats', 10_000)
    ws.close()
    server.send('close')
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL')
        done()
      }, 15_000)
      server.once('exit', () => {
        clearTimeout(timer)
        done()
      })
    })

    const result = {
      label: options.label,
      repo: options.repo,
      machine: { platform: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown' },
      workload: {
        fragments: options.fragments,
        llmCalls: options.calls,
        fragmentsPerSecond: options.fragmentsPerSecond,
        probeIntervalMs: options.probeIntervalMs,
        sessionPollMs: options.sessionPollMs,
      },
      timedOut,
      turnSeconds: Math.round((endedAt - startedAt) / 100) / 10,
      llm: llmStats,
      liveThinkingMessages: liveThinking,
      apiConfigIdleMs: quantiles(idle),
      apiConfigStreamingMs: quantiles(configSamples),
      sessionGetStreamingMs: quantiles(sessionSamples),
      serverEventLoopDelayMs,
      database: databaseStats(dbPath, sessionId),
    }
    const json = JSON.stringify(result, null, 2)
    console.log(json)
    if (options.out) await writeFile(options.out, json + '\n', 'utf-8')
    if (timedOut) process.exitCode = 1
  } catch (error) {
    process.stderr.write(stderr.join(''))
    throw error
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
}

const role = argument('role')
if (role === 'llm') await llmRole()
else if (role === 'server') await serverRole()
else await orchestrate()
