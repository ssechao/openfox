import { fork, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import type { Config } from '../src/shared/types.js'
import type { ServerHandle } from '../src/server/context.js'

const MODEL = 'etape7-demo'
const WITNESS_MARKER = 'ETAPE7_WITNESS'
const PERTURBATOR_MARKER = 'ETAPE7_PERTURBATOR'
const MCP_MARKER = 'ETAPE7_MCP_CHECK'
const FILE_COUNT = 20_000
const PDF_PAGES = 50
const STDOUT_BYTES = 64 * 1024 * 1024
const WITNESS_CHUNKS = 1_501
const CHUNK_INTERVAL_MS = 20
const CLIENT_TIMEOUT_MS = 500
const KILL_AT_MS = 20_000
const POST_KILL_MS = 10_000
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

type LoadName = 'git' | 'pdf' | 'stdout'

interface LoadInterval {
  start: number
  end: number
}

interface WorkerIdentity {
  sessionId: string
  token: { workerId: string; generation: number }
  pid: number
}

interface WorkerIntrospection {
  activeWorkers: WorkerIdentity[]
  lastCrash: {
    sessionId: string
    pid: number
    inventory: { capturedAt: number }
    orphanCheck?: {
      checkedAt: number
      clean: boolean
      survivingIdentities: unknown[]
      survivingGroups: unknown[]
      liveReservations: unknown[]
      errors: string[]
    }
  } | null
}

interface SessionView {
  session: { isRunning: boolean; interruptedAt?: string | null }
  messages: Array<{
    role?: string
    content?: string
    toolCalls?: Array<{
      name?: string
      result?: { success: boolean; output?: string; error?: string; truncated: boolean }
    }>
  }>
}

interface ProbeResult {
  latencies: number[]
  failures: number
  deadlines: number
  missedDeadlines: number
}

interface WitnessObservation {
  at: number
  ok: boolean
  match: boolean
  pid: number | null
  workerId: string | null
  generation: number | null
}

interface ToolObservation {
  callId: string
  tool: string
  args: Record<string, unknown>
  startAt: number
  endAt: number
  result: { success: boolean; output?: string; error?: string; truncated: boolean } | null
}

interface ObserverResult {
  pid: number
  deltaTimes: number[]
  deltaChars: number
  firstDeltaAt: number
  streamDoneAt: number
  probes: { session: ProbeResult; health: ProbeResult }
  identityObservations: WitnessObservation[]
  toolCalls: ToolObservation[]
}

interface ObserverMessage {
  type: string
  pid?: number
  at?: number
  error?: string
  identity?: WorkerIdentity
  deltaTimes?: number[]
  deltaChars?: number
  firstDeltaAt?: number
  streamDoneAt?: number
  probes?: ObserverResult['probes']
  identityObservations?: WitnessObservation[]
  toolCalls?: ToolObservation[]
}

interface Verdict {
  label: string
  pass: boolean
  detail: string
}

interface MockState {
  witnessStart: number
  witnessEnd: number
  witnessChunkTimes: number[]
  loads: Record<LoadName, LoadInterval>
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function percentile(samples: number[], quantile: number): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY
}

function gapStats(timestamps: number[]): { count: number; p99: number; max: number } {
  const gaps = timestamps.slice(1).map((value, index) => value - timestamps[index]!)
  return {
    count: timestamps.length,
    p99: round(percentile(gaps, 0.99)),
    max: round(Math.max(...gaps, 0)),
  }
}

function latencyStats(result: ProbeResult): {
  count: number
  failures: number
  deadlines: number
  missedDeadlines: number
  p99: number
  max: number
} {
  return {
    count: result.latencies.length,
    failures: result.failures,
    deadlines: result.deadlines,
    missedDeadlines: result.missedDeadlines,
    p99: round(percentile(result.latencies, 0.99)),
    max: round(Math.max(...result.latencies, 0)),
  }
}

function waitForObserverMessage(
  child: ChildProcess,
  predicate: (message: ObserverMessage) => boolean,
  timeoutMs: number,
  label: string,
): Promise<ObserverMessage> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timeout waiting for ${label}`))
    }, timeoutMs)
    const onMessage = (value: unknown) => {
      const message = value as ObserverMessage
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`Observer exited before ${label}: code=${code} signal=${signal}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

function observerResult(message: ObserverMessage): ObserverResult {
  if (
    message.pid === undefined ||
    !message.deltaTimes ||
    message.deltaChars === undefined ||
    message.firstDeltaAt === undefined ||
    message.streamDoneAt === undefined ||
    !message.probes ||
    !message.identityObservations ||
    !message.toolCalls
  ) {
    throw new Error('Observer returned an incomplete result')
  }
  return {
    pid: message.pid,
    deltaTimes: message.deltaTimes,
    deltaChars: message.deltaChars,
    firstDeltaAt: message.firstDeltaAt,
    streamDoneAt: message.streamDoneAt,
    probes: message.probes,
    identityObservations: message.identityObservations,
    toolCalls: message.toolCalls,
  }
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== null) return value
    if (performance.now() >= deadline) throw new Error(`Timeout waiting for ${label}`)
    await sleep(25)
  }
}

async function readRequest(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return body
}

async function writeResponse(res: ServerResponse, data: string): Promise<void> {
  if (res.write(data)) return
  await new Promise<void>((resolveWrite) => res.once('drain', resolveWrite))
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: randomUUID(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

async function finishStream(res: ServerResponse, finishReason: 'stop' | 'tool_calls'): Promise<void> {
  await writeResponse(res, streamChunk({}, finishReason))
  await writeResponse(
    res,
    `data: ${JSON.stringify({
      id: randomUUID(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })}\n\n`,
  )
  res.end('data: [DONE]\n\n')
}

async function sendTool(res: ServerResponse, id: string, name: string, args: Record<string, unknown>): Promise<void> {
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')
  await writeResponse(
    res,
    streamChunk({
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
  )
  await finishStream(res, 'tool_calls')
}

async function sendText(res: ServerResponse, text: string): Promise<void> {
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')
  await writeResponse(res, streamChunk({ content: text }))
  await finishStream(res, 'stop')
}

function closePreviousLoad(state: MockState, toolCount: number, now: number): void {
  const previous: LoadName | undefined =
    toolCount === 1 ? 'git' : toolCount === 2 ? 'pdf' : toolCount === 3 ? 'stdout' : undefined
  if (previous && state.loads[previous].end === 0) state.loads[previous].end = now
}

function createModelServer(state: MockState): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', max_model_len: 262_144 }] }))
        return
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.statusCode = 404
        res.end('{}')
        return
      }

      const raw = await readRequest(req)
      const payload = JSON.parse(raw || '{}') as {
        stream?: boolean
        messages?: Array<{ role?: string; content?: unknown }>
      }
      const serialized = JSON.stringify(payload.messages ?? [])
      const toolCount = (payload.messages ?? []).filter((message) => message.role === 'tool').length

      if (serialized.includes(WITNESS_MARKER)) {
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        for (let index = 0; index < WITNESS_CHUNKS; index++) {
          await sleep(CHUNK_INTERVAL_MS)
          await writeResponse(res, streamChunk({ content: 'x' }))
          const now = performance.now()
          if (index === 0) state.witnessStart = now
          state.witnessChunkTimes.push(now)
        }
        state.witnessEnd = performance.now()
        await finishStream(res, 'stop')
        return
      }

      if (serialized.includes(PERTURBATOR_MARKER)) {
        const now = performance.now()
        closePreviousLoad(state, toolCount, now)
        if (toolCount === 0) {
          state.loads.git.start = now
          await sendTool(res, 'etape7-git', 'run_command', {
            command: 'git diff --no-ext-diff --no-color; sleep 2.2',
            timeout: 120_000,
          })
          return
        }
        if (toolCount === 1) {
          state.loads.pdf.start = now
          await sendTool(res, 'etape7-pdf', 'run_command', {
            command: './pdf-load.sh demo.pdf',
            timeout: 120_000,
          })
          return
        }
        if (toolCount === 2) {
          state.loads.stdout.start = now
          await sendTool(res, 'etape7-stdout', 'run_command', {
            command: `node -e "let n=${STDOUT_BYTES},c='x'.repeat(1024*1024);while(n>0){process.stdout.write(c);n-=c.length}setTimeout(()=>{},2200)"`,
            timeout: 120_000,
          })
          return
        }
        if (toolCount === 3) {
          res.setHeader('content-type', 'text/event-stream')
          res.setHeader('cache-control', 'no-cache')
          let closed = false
          res.once('close', () => {
            closed = true
          })
          while (!closed) {
            await sleep(100)
            if (!closed) await writeResponse(res, streamChunk({ content: '.' }))
          }
          return
        }
        await sendText(res, 'Perturbator finished unexpectedly.')
        return
      }

      if (serialized.includes(MCP_MARKER)) {
        if (toolCount === 0) {
          await sendTool(res, 'etape7-mcp', 'test-server_greet', { name: 'Etape7' })
          return
        }
        await sendText(res, 'MCP alive.')
        return
      }

      if (payload.stream === false) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            id: randomUUID(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }

      await sendText(res, 'ok')
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

function pdfObject(id: number, body: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`),
    Buffer.isBuffer(body) ? body : Buffer.from(body),
    Buffer.from('\nendobj\n'),
  ])
}

function buildPdf(): Buffer {
  const objects: Buffer[] = []
  const pageIds: number[] = []
  for (let page = 0; page < PDF_PAGES; page++) pageIds.push(4 + page * 2)
  objects.push(pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'))
  objects.push(
    pdfObject(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${PDF_PAGES} >>`),
  )
  objects.push(pdfObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'))

  for (let page = 1; page <= PDF_PAGES; page++) {
    const pageId = 4 + (page - 1) * 2
    const contentId = pageId + 1
    const lines = Array.from(
      { length: 48 },
      (_, line) =>
        `page-${String(page).padStart(2, '0')}-line-${String(line + 1).padStart(2, '0')}-${'text'.repeat(14)}`,
    )
    const commands = [
      'BT',
      '/F1 8 Tf',
      '30 760 Td',
      ...lines.flatMap((line) => [`(${line}) Tj`, '0 -14 Td']),
      'ET',
    ].join('\n')
    const stream = Buffer.from(commands)
    objects.push(
      pdfObject(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    )
    objects.push(
      pdfObject(
        contentId,
        Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
      ),
    )
  }

  const padding = Buffer.alloc(16 * 1024 * 1024, 0x50)
  objects.push(
    pdfObject(
      4 + PDF_PAGES * 2,
      Buffer.concat([Buffer.from(`<< /Length ${padding.length} >>\nstream\n`), padding, Buffer.from('\nendstream')]),
    ),
  )

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\x80\x80\x80\x80\n', 'binary')]
  const offsets = [0]
  let offset = parts[0]!.length
  for (const object of objects) {
    offsets.push(offset)
    parts.push(object)
    offset += object.length
  }
  const xrefOffset = offset
  const size = objects.length + 1
  const xref = [
    'xref',
    `0 ${size}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${size} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n')
  parts.push(Buffer.from(xref))
  return Buffer.concat(parts)
}

async function writeInBatches(paths: string[], content: string): Promise<void> {
  for (let start = 0; start < paths.length; start += 400) {
    await Promise.all(paths.slice(start, start + 400).map((path) => writeFile(path, content)))
  }
}

async function runQuiet(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr}`))
    })
  })
}

async function countStdout(command: string, args: string[], cwd: string): Promise<number> {
  return await new Promise<number>((resolveCount, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let bytes = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveCount(bytes)
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr}`))
    })
  })
}

async function prepareWorkload(projectDir: string): Promise<{
  diffBytes: number
  pdfBytes: number
  pdfTextBytes: number
  pdfPages: number
  stdoutBytes: number
}> {
  const filesDir = join(projectDir, 'files')
  await mkdir(filesDir, { recursive: true })
  const paths = Array.from({ length: FILE_COUNT }, (_, index) =>
    join(filesDir, `${String(index).padStart(5, '0')}.txt`),
  )
  await writeInBatches(paths, `${'a'.repeat(1_400)}\n`)
  await runQuiet('git', ['init', '-q'], projectDir)
  await runQuiet('git', ['add', '.'], projectDir)
  await runQuiet(
    'git',
    ['-c', 'user.name=OpenFox Demo', '-c', 'user.email=demo@openfox.local', 'commit', '-qm', 'baseline'],
    projectDir,
  )
  await writeInBatches(paths, `${'b'.repeat(1_400)}\n`)
  const diffBytes = await countStdout('git', ['diff', '--no-ext-diff', '--no-color'], projectDir)

  const pdf = buildPdf()
  const pdfPath = join(projectDir, 'demo.pdf')
  await writeFile(pdfPath, pdf)
  const { extractPdfText } = await import('../src/server/tools/pdf-utils.js')
  const extracted = await extractPdfText(pdf)
  const pdfTextBytes = Buffer.byteLength(extracted.text)

  const tsxLoader = import.meta.resolve('tsx/esm')
  await writeFile(
    join(projectDir, 'pdf-load.mjs'),
    [
      "import { readFile } from 'node:fs/promises'",
      `import { extractPdfText } from ${JSON.stringify(new URL('../src/server/tools/pdf-utils.ts', import.meta.url).href)}`,
      'const result = await extractPdfText(await readFile(process.argv[2]))',
      'process.stdout.write(\`pages=\${result.pageCount} extracted_bytes=\${Buffer.byteLength(result.text)}\\n\`)',
      'await new Promise((resolve) => setTimeout(resolve, 2200))',
    ].join('\n'),
  )
  await writeFile(
    join(projectDir, 'pdf-load.sh'),
    `#!/bin/sh\nexec node --import ${JSON.stringify(tsxLoader)} pdf-load.mjs "$@"\n`,
  )
  await runQuiet('chmod', ['+x', 'pdf-load.sh'], projectDir)

  const generator = `let n=${STDOUT_BYTES},c='x'.repeat(1024*1024);while(n>0){process.stdout.write(c);n-=c.length}`
  const stdoutBytes = await countStdout(process.execPath, ['-e', generator], projectDir)
  return {
    diffBytes,
    pdfBytes: (await stat(pdfPath)).size,
    pdfTextBytes,
    pdfPages: extracted.pageCount,
    stdoutBytes,
  }
}

function isolatedEnvironment(root: string, dbPath: string): void {
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'home', '.config')
  process.env['XDG_DATA_HOME'] = join(root, 'home', '.local', 'share')
  process.env['OPENFOX_DB_PATH'] = dbPath
  process.env['OPENFOX_LOG_LEVEL'] = 'error'
  process.env['OPENFOX_DISABLE_AUTO_SESSION_TITLE'] = 'true'
  process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR'] = 'true'
  process.env['OPENFOX_SESSION_WORKER'] = 'true'
  process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES'] = '2'
}

async function api<T>(base: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(base + path, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

async function createSession(base: string, projectId: string, title: string): Promise<string> {
  const created = await api<{ session: { id: string } }>(base, '/api/sessions', {
    method: 'POST',
    body: { projectId, title },
  })
  return created.session.id
}

function findWorker(introspection: WorkerIntrospection, sessionId: string): WorkerIdentity | null {
  return introspection.activeWorkers.find((worker) => worker.sessionId === sessionId) ?? null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function toolResult(
  view: SessionView,
  name: string,
): { success: boolean; output?: string; error?: string; truncated: boolean } | null {
  for (const message of view.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.name === name && call.result) return call.result
    }
  }
  return null
}

function printSummary(
  root: string,
  port: number,
  workload: Awaited<ReturnType<typeof prepareWorkload>>,
  gatewayPid: number,
  witnessWorker: WorkerIdentity,
  perturbatorWorker: WorkerIdentity,
  observerPid: number,
  streamStats: { received: ReturnType<typeof gapStats>; duration: number; chars: number },
  sessionProbe: ReturnType<typeof latencyStats>,
  healthProbe: ReturnType<typeof latencyStats>,
  loads: Record<LoadName, LoadInterval>,
  killAt: number,
  streamEnd: number,
  finalWitness: WorkerIdentity,
  witnessStable: boolean,
  perturbatorAlive: boolean,
  crash: NonNullable<WorkerIntrospection['lastCrash']>,
  witnessView: SessionView,
  perturbatorView: SessionView,
  mcpView: SessionView,
  mcpConnected: boolean,
  gitResult: NonNullable<ReturnType<typeof toolResult>>,
  stdoutResult: NonNullable<ReturnType<typeof toolResult>>,
): boolean {
  const mib = (bytes: number) => round(bytes / (1024 * 1024))
  const postKill = streamEnd - killAt
  const orphanDelay = crash.orphanCheck ? crash.orphanCheck.checkedAt - crash.inventory.capturedAt : Number.NaN
  const witnessContent = Math.max(
    0,
    ...witnessView.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content?.length ?? 0),
  )
  const mcpSerialized = JSON.stringify(mcpView.messages)
  const loadDetails = (Object.entries(loads) as Array<[LoadName, LoadInterval]>).map(([name, interval]) => {
    const duration = interval.end - interval.start
    const overlapStart = Math.max(
      interval.start,
      streamStats.duration > 0 ? streamEnd - streamStats.duration : interval.start,
    )
    const overlapEnd = Math.min(interval.end, streamEnd)
    return { name, duration, overlap: overlapEnd - overlapStart }
  })

  const verdicts: Verdict[] = [
    {
      label: 'C3.1 isolation/pool',
      pass: root.startsWith(tmpdir()) && port > 0 && witnessWorker.pid !== perturbatorWorker.pid,
      detail: `db_temp=true port=${port} pool=2 gateway_pid=${gatewayPid} observer_pid=${observerPid} observer_external=${observerPid !== gatewayPid} workers=${witnessWorker.pid},${perturbatorWorker.pid}`,
    },
    {
      label: 'C3.2 charges réelles',
      pass:
        workload.diffBytes >= 50 * 1024 * 1024 &&
        workload.pdfBytes >= 15 * 1024 * 1024 &&
        workload.pdfBytes <= 20 * 1024 * 1024 &&
        workload.pdfPages === PDF_PAGES &&
        workload.pdfTextBytes >= 100 * 1024 &&
        workload.stdoutBytes === STDOUT_BYTES &&
        gitResult.truncated &&
        (gitResult.output?.length ?? 0) <= 50_100 &&
        stdoutResult.truncated &&
        (stdoutResult.output?.length ?? 0) <= 50_100 &&
        loadDetails.every((load) => load.duration >= 2_000 && load.overlap >= 2_000),
      detail: `files=${FILE_COUNT} diff_mib=${mib(workload.diffBytes)} pdf_pages=${workload.pdfPages} pdf_mib=${mib(workload.pdfBytes)} pdf_text_kib=${round(workload.pdfTextBytes / 1024)} stdout_mib=${mib(workload.stdoutBytes)} tool_caps=${gitResult.output?.length ?? 0}/${stdoutResult.output?.length ?? 0} intervals_ms=${loadDetails.map((load) => `${load.name}:${round(load.duration)}/overlap:${round(load.overlap)}`).join(',')}`,
    },
    {
      label: 'C3.3 sondes session',
      pass:
        sessionProbe.count >= 500 &&
        sessionProbe.failures === 0 &&
        sessionProbe.missedDeadlines === 0 &&
        sessionProbe.p99 < 100,
      detail: `deadlines=${sessionProbe.deadlines} responses=${sessionProbe.count} failures=${sessionProbe.failures} missed_deadlines=${sessionProbe.missedDeadlines} p99_ms=${sessionProbe.p99} max_ms=${sessionProbe.max} timeout_ms=${CLIENT_TIMEOUT_MS}`,
    },
    {
      label: 'C3.4 sondes santé',
      pass:
        healthProbe.count >= 500 &&
        healthProbe.failures === 0 &&
        healthProbe.missedDeadlines === 0 &&
        healthProbe.p99 < 100,
      detail: `deadlines=${healthProbe.deadlines} responses=${healthProbe.count} failures=${healthProbe.failures} missed_deadlines=${healthProbe.missedDeadlines} p99_ms=${healthProbe.p99} max_ms=${healthProbe.max} timeout_ms=${CLIENT_TIMEOUT_MS}`,
    },
    {
      label: 'C3.5 stream témoin',
      pass:
        observerPid !== gatewayPid &&
        streamStats.received.count >= 1_500 &&
        streamStats.received.p99 < 100 &&
        streamStats.received.max < 250 &&
        streamStats.duration >= 30_000 &&
        streamStats.chars === WITNESS_CHUNKS &&
        witnessContent === WITNESS_CHUNKS,
      detail: `source=external_ws observer_pid=${observerPid} duration_ms=${round(streamStats.duration)} chunks_received=${streamStats.received.count} chars_received=${streamStats.chars} gap_p99_ms=${streamStats.received.p99} gap_max_ms=${streamStats.received.max} final_chars=${witnessContent}`,
    },
    {
      label: 'C3.6 SIGKILL/isolation',
      pass:
        !perturbatorAlive &&
        crash.sessionId === perturbatorWorker.sessionId &&
        perturbatorView.session.interruptedAt != null &&
        witnessView.session.interruptedAt == null &&
        !witnessView.session.isRunning &&
        finalWitness.pid === witnessWorker.pid &&
        finalWitness.token.workerId === witnessWorker.token.workerId &&
        finalWitness.token.generation === witnessWorker.token.generation &&
        witnessStable &&
        gatewayPid === process.pid &&
        postKill >= POST_KILL_MS,
      detail: `kill_t_ms=${round(killAt - (streamEnd - streamStats.duration))} post_kill_ms=${round(postKill)} gateway_pid=${gatewayPid} witness_pid=${witnessWorker.pid}->${finalWitness.pid} generation=${witnessWorker.token.generation}->${finalWitness.token.generation} stable=${witnessStable} perturbator_pid=${perturbatorWorker.pid} alive=${perturbatorAlive}`,
    },
    {
      label: 'C3.7 MCP/orphelins',
      pass:
        mcpConnected &&
        mcpSerialized.includes('Hello, Etape7!') &&
        mcpView.session.interruptedAt == null &&
        crash.orphanCheck?.clean === true &&
        orphanDelay >= 2_000 &&
        orphanDelay <= 2_500 &&
        crash.orphanCheck.survivingIdentities.length === 0 &&
        crash.orphanCheck.survivingGroups.length === 0 &&
        crash.orphanCheck.liveReservations.length === 0 &&
        crash.orphanCheck.errors.length === 0,
      detail: `mcp_connected=${mcpConnected} mcp_reply=${mcpSerialized.includes('Hello, Etape7!')} orphan_delay_ms=${orphanDelay} identities=${crash.orphanCheck?.survivingIdentities.length ?? -1} groups=${crash.orphanCheck?.survivingGroups.length ?? -1} reservations=${crash.orphanCheck?.liveReservations.length ?? -1} errors=${crash.orphanCheck?.errors.length ?? -1}`,
    },
  ]

  process.stdout.write('RÉSUMÉ CHIFFRÉ — Étape 7 C3\n')
  for (const verdict of verdicts) {
    process.stdout.write(`${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.label} — ${verdict.detail}\n`)
  }
  const passed = verdicts.every((verdict) => verdict.pass)
  process.stdout.write(`VERDICT GLOBAL: ${passed ? 'PASS' : 'FAIL'}\n`)
  return passed
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'openfox-etape7-'))
  const projectDir = join(root, 'project')
  const dbPath = join(root, 'data', 'sessions.db')
  await mkdir(projectDir, { recursive: true })
  await mkdir(dirname(dbPath), { recursive: true })
  await mkdir(join(root, 'home'), { recursive: true })
  isolatedEnvironment(root, dbPath)

  const state: MockState = {
    witnessStart: 0,
    witnessEnd: 0,
    witnessChunkTimes: [],
    loads: {
      git: { start: 0, end: 0 },
      pdf: { start: 0, end: 0 },
      stdout: { start: 0, end: 0 },
    },
  }
  const modelServer = createModelServer(state)
  let server: ServerHandle | undefined
  let observer: ChildProcess | undefined
  let observerStderr = ''
  const witnessIdentities: WorkerIdentity[] = []

  try {
    const workload = await prepareWorkload(projectDir)
    const modelPort = await listen(modelServer)
    const config: Config = {
      mode: 'test',
      llm: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: MODEL,
        backend: 'vllm',
        apiProtocol: 'chat-completions',
        timeout: 300_000,
        idleTimeout: 300_000,
      },
      context: { maxTokens: 262_144, compactionThreshold: 0.85, compactionTarget: 0.6 },
      agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 120_000 },
      server: { port: 0, host: '127.0.0.1' },
      database: { path: dbPath },
      logging: { level: 'error' },
      workdir: projectDir,
      globalConfigPath: join(root, 'config.json'),
      mcpServers: {
        'test-server': {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', import.meta.resolve('tsx/esm'), join(repoRoot, 'e2e', 'mock-mcp-server.ts')],
        },
      },
    }

    const { createServerHandle } = await import('../src/server/index.js')
    server = await createServerHandle(config)
    const { port } = await server.start(0)
    const base = `http://127.0.0.1:${port}`
    const project = await api<{ project: { id: string } }>(base, '/api/projects', {
      method: 'POST',
      body: { name: 'Etape 7 C3', workdir: projectDir },
    })
    const witnessId = await createSession(base, project.project.id, 'Témoin')
    const perturbatorId = await createSession(base, project.project.id, 'Perturbateur')
    const mcpId = await createSession(base, project.project.id, 'MCP après crash')

    await waitFor(
      async () => {
        const servers = await api<{ servers: Array<{ name: string; status: string }> }>(base, '/api/mcp/servers')
        return servers.servers.some((item) => item.name === 'test-server' && item.status === 'connected') ? true : null
      },
      30_000,
      'MCP connection',
    )

    observer = fork(join(here, 'demo-etape7-observer.mjs'), [base, witnessId, perturbatorId], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    observer.stderr?.on('data', (chunk: Buffer) => {
      observerStderr += chunk.toString()
    })
    const observerReady = await waitForObserverMessage(
      observer,
      (message) => message.type === 'ready',
      10_000,
      'external observer readiness',
    )
    if (!observerReady.pid || observerReady.pid === process.pid) {
      throw new Error('External observer did not start in an independent process')
    }

    const firstDeltaPromise = waitForObserverMessage(
      observer,
      (message) => message.type === 'firstDelta',
      20_000,
      'first externally received witness delta',
    )
    const streamDonePromise = waitForObserverMessage(
      observer,
      (message) => message.type === 'streamDone',
      60_000,
      'externally received witness completion',
    )
    await api(base, `/api/sessions/${witnessId}/message`, {
      method: 'POST',
      body: { content: WITNESS_MARKER },
    })
    const witnessWorker = await waitFor(
      async () => findWorker(await api<WorkerIntrospection>(base, '/api/test/worker'), witnessId),
      20_000,
      'witness worker',
    )
    const firstDelta = await firstDeltaPromise
    if (firstDelta.at === undefined) throw new Error('External observer omitted first delta time')
    observer.send?.({ type: 'expectedWitness', identity: witnessWorker })

    await api(base, `/api/sessions/${perturbatorId}/message`, {
      method: 'POST',
      body: { content: PERTURBATOR_MARKER },
    })
    const perturbatorWorker = await waitFor(
      async () => findWorker(await api<WorkerIntrospection>(base, '/api/test/worker'), perturbatorId),
      20_000,
      'perturbator worker',
    )

    await waitFor(() => (state.loads.stdout.end > 0 ? true : null), 30_000, 'three perturbator loads')

    const identityPoll = setInterval(() => {
      void api<WorkerIntrospection>(base, '/api/test/worker')
        .then((current) => {
          const identity = findWorker(current, witnessId)
          if (identity) witnessIdentities.push(identity)
        })
        .catch(() => {})
    }, 100)

    const waitToKill = firstDelta.at + KILL_AT_MS - (performance.timeOrigin + performance.now())
    if (waitToKill > 0) await sleep(waitToKill)
    const killAt = performance.timeOrigin + performance.now()
    const beforeKill = await api<WorkerIntrospection>(base, '/api/test/worker')
    const livePerturbator = findWorker(beforeKill, perturbatorId)
    if (!livePerturbator || livePerturbator.pid !== perturbatorWorker.pid) {
      throw new Error('Perturbator worker was not alive at T+20s')
    }
    process.kill(perturbatorWorker.pid, 'SIGKILL')

    await waitFor(
      async () => {
        const view = await api<SessionView>(base, `/api/sessions/${perturbatorId}`)
        return view.session.interruptedAt && !view.session.isRunning ? view : null
      },
      10_000,
      'perturbator interruption',
    )

    await api(base, `/api/sessions/${mcpId}/message`, { method: 'POST', body: { content: MCP_MARKER } })
    const mcpView = await waitFor(
      async () => {
        const view = await api<SessionView>(base, `/api/sessions/${mcpId}`)
        return !view.session.isRunning && JSON.stringify(view.messages).includes('Hello, Etape7!') ? view : null
      },
      20_000,
      'post-crash MCP call',
    )

    const witnessView = await waitFor(
      async () => {
        const view = await api<SessionView>(base, `/api/sessions/${witnessId}`)
        return !view.session.isRunning ? view : null
      },
      20_000,
      'witness completion',
    )
    await streamDonePromise
    clearInterval(identityPoll)
    const observerResultPromise = waitForObserverMessage(
      observer,
      (message) => message.type === 'result',
      5_000,
      'external observer result',
    )
    observer.send?.({ type: 'stop' })
    const observed = observerResult(await observerResultPromise)

    const crash = await waitFor(
      async () => {
        const current = await api<WorkerIntrospection>(base, '/api/test/worker')
        return current.lastCrash?.orphanCheck ? current.lastCrash : null
      },
      10_000,
      'zero-orphan proof',
    )
    const perturbatorView = await api<SessionView>(base, `/api/sessions/${perturbatorId}`)
    const mcpServers = await api<{ servers: Array<{ name: string; status: string }> }>(base, '/api/mcp/servers')
    const mcpConnected = mcpServers.servers.some((item) => item.name === 'test-server' && item.status === 'connected')
    const finalWitness =
      witnessIdentities.at(-1) ??
      (() => {
        throw new Error('No witness identity observed after SIGKILL')
      })()
    const witnessStable = witnessIdentities.every(
      (identity) =>
        identity.pid === witnessWorker.pid &&
        identity.token.workerId === witnessWorker.token.workerId &&
        identity.token.generation === witnessWorker.token.generation,
    )
    const gitResult = toolResult(perturbatorView, 'run_command')
    const runResults = perturbatorView.messages.flatMap((message) =>
      (message.toolCalls ?? [])
        .filter((call) => call.name === 'run_command' && call.result)
        .map((call) => call.result!),
    )
    const stdoutResult = runResults[2] ?? null
    if (!gitResult || !stdoutResult) throw new Error('Perturbator tool results are incomplete')

    const passed = printSummary(
      root,
      port,
      workload,
      process.pid,
      witnessWorker,
      perturbatorWorker,
      observed.pid,
      {
        received: gapStats(observed.deltaTimes),
        duration: observed.streamDoneAt - observed.firstDeltaAt,
        chars: observed.deltaChars,
      },
      latencyStats(observed.probes.session),
      latencyStats(observed.probes.health),
      state.loads,
      killAt,
      observed.streamDoneAt,
      finalWitness,
      witnessStable,
      alive(perturbatorWorker.pid),
      crash,
      witnessView,
      perturbatorView,
      mcpView,
      mcpConnected,
      gitResult,
      stdoutResult,
    )
    if (!passed) process.exitCode = 1
  } finally {
    if (observer && observer.exitCode === null && observer.signalCode === null) {
      observer.send?.({ type: 'stop' })
      await Promise.race([
        new Promise<void>((resolveExit) => observer?.once('exit', () => resolveExit())),
        sleep(2_000),
      ])
      if (observer.exitCode === null && observer.signalCode === null) observer.kill('SIGKILL')
    }
    if (observerStderr) process.stderr.write(observerStderr)
    if (server) await Promise.race([server.close().catch(() => {}), sleep(10_000)])
    await closeServer(modelServer).catch(() => {})
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENFOX_DB_PATH']
    delete process.env['OPENFOX_SESSION_PROCESS_SUPERVISOR']
    delete process.env['OPENFOX_SESSION_WORKER']
    delete process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES']
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.stdout.write(
      'RÉSUMÉ CHIFFRÉ — Étape 7 C3\nFAIL exécution — arrêt avant verdict complet\nVERDICT GLOBAL: FAIL\n',
    )
    process.exit(1)
  },
)
