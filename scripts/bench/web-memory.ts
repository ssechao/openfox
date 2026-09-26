/**
 * Web memory benchmark — baseline for the browser-side memory footprint of a
 * long, fast-streaming conversation.
 *
 * Boots the built app headlessly (in-memory DB, mock LLM, isolated config),
 * opens a single session, then streams a synthetic 200K-token conversation
 * through the app's real WebSocket handler and React render path, sampling the
 * renderer's JS heap and DOM counters at regular context intervals.
 *
 * Report-only: it never asserts a memory threshold. It fails only if the app
 * cannot be driven (see `verifyRendered`).
 *
 * Usage:
 *   npm run bench:web                      # build + run
 *   BENCH_SKIP_BUILD=1 npm run bench:web   # reuse an existing dist/
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir, totalmem, release, platform, arch } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { deltaPct, formatDelta, verdict, type Verdict } from './compare.js'
import { summarizeFrames, type FrameStats } from './frames.js'
import { resolvePerformanceSettings } from './settings.js'
import {
  buildTurnFrames,
  checkpointTurnIndices,
  defaultWorkload,
  percentile,
  slope,
  tokensAfterTurn,
  totalTokens,
  type WorkloadConfig,
} from './workload.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'bench', 'baseline.json')
const CHAT_SCROLL_SELECTOR = '[data-testid="chat-scroll-container"]'
const CHAT_INPUT_SELECTOR = '[data-testid="chat-input-textarea"]'
/**
 * Top-level mounted feed items. `data-item-index` is set by ChatFeedItems on
 * each rendered display item; the `.feed-item` class is reused inside nested
 * components (ChatMessage, SubAgentContainer, ThinkingBlock, ...) so counting it
 * overstates the mounted window. Placeholders carry `data-placeholder`.
 */
const FEED_ITEM_SELECTOR = '[data-item-index]:not([data-placeholder])'

/**
 * The display settings the UI groups under "Performance" live in `settings.ts`,
 * where `BENCH_PERF_SETTINGS` resolves them (all, or a comma-separated subset
 * for an ablation). `display.maxVisibleItems` stays at its app default unless
 * `BENCH_MAX_VISIBLE_ITEMS` overrides it.
 */
interface BenchmarkOptions {
  targetTokens: number
  batchSize: number
  settleMs: number
  skipBuild: boolean
  keepArtifacts: boolean
  perfSettings: Record<string, string>
  maxVisibleItems: number | null
  outputPath: string
  comparePath: string | null
}

interface Checkpoint {
  label: string
  turn: number
  tokens: number
  heapUsedBytes: number
  heapTotalBytes: number
  /** CDP DOM counter: every live node object, including detached-but-retained ones. */
  domNodes: number
  /** Elements actually mounted in the document — the render cost. */
  domElements: number
  /** Top-level mounted feed items (excluding virtualization placeholders). */
  feedItems: number
  /** Unmounted placeholder slots — non-zero only when feed virtualization engaged. */
  feedPlaceholders: number
  /** Live OverlayScrollbars instances (each owns a MutationObserver + 2 ResizeObservers). */
  overlayScrollbars: number
  jsEventListeners: number
  documents: number
  browserRssBytes: number | null
  /** Frame timing over the streaming phase since the previous checkpoint. */
  frames: FrameStats
  elapsedMs: number
}

interface BaselineReport {
  generatedAt: string
  browser: { name: string; version: string }
  platform: {
    node: string
    os: string
    release: string
    arch: string
    cpu: string
    cpuCount: number
    totalMemBytes: number
  }
  workload: WorkloadConfig & { totalTokens: number; totalFrames: number }
  /** Display settings applied for this run (empty = app defaults). */
  settings: Record<string, string>
  checkpoints: Checkpoint[]
  idleFrames: FrameStats
  streamingFrames: FrameStats
  domContributors: { selector: string; nodes: number }[]
  feedItems: number
  summary: {
    coldLoadHeapUsedBytes: number
    peakHeapUsedBytes: number
    retainedHeapUsedBytes: number
    heapGrowthBytes: number
    leakSlopeBytesPer10kTokens: number
    domNodesAtTarget: number
    domNodesCold: number
    domElementsAtTarget: number
    domElementsCold: number
    feedItemsAtTarget: number
    feedPlaceholdersAtTarget: number
    overlayScrollbarsAtTarget: number
    browserRssColdBytes: number | null
    browserRssPeakBytes: number | null
    idleFps: number
    streamingFps: number
    worstFrameMs: number
    longFrames: number
    totalDurationMs: number
  }
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseOptions(): BenchmarkOptions {
  const output = process.env['BENCH_OUTPUT']
  const compare = process.env['BENCH_COMPARE']
  const maxVisible = process.env['BENCH_MAX_VISIBLE_ITEMS']
  const parsedMaxVisible = maxVisible === undefined ? null : Number(maxVisible)
  return {
    targetTokens: readNumberEnv('BENCH_TARGET_TOKENS', 200_000),
    batchSize: readNumberEnv('BENCH_BATCH_SIZE', 120),
    settleMs: readNumberEnv('BENCH_SETTLE_MS', 3_000),
    skipBuild: process.env['BENCH_SKIP_BUILD'] === '1',
    keepArtifacts: process.env['BENCH_KEEP_ARTIFACTS'] === '1',
    perfSettings: resolvePerformanceSettings(process.env['BENCH_PERF_SETTINGS']),
    maxVisibleItems: parsedMaxVisible !== null && Number.isFinite(parsedMaxVisible) ? parsedMaxVisible : null,
    outputPath: output ? resolve(REPO_ROOT, output) : BASELINE_PATH,
    comparePath: compare ? resolve(REPO_ROOT, compare) : null,
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        const port = address.port
        server.close(() => resolvePort(port))
      } else {
        server.close(() => reject(new Error('Could not allocate a port')))
      }
    })
  })
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(200)
  }
  throw new Error(`Server did not become healthy at ${url}: ${lastError}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function apiFetch<T>(url: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: HTTP ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}

/** Two animation frames: enough for the store's rAF-batched streaming flush to paint. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))),
  )
}

interface FrameSamplerWindow {
  __benchFrames: number[]
}

/**
 * Page-side source, kept as a string: the bundler injects `__name(...)` helpers
 * into transpiled function bodies, which do not exist in the page. A string is
 * evaluated verbatim.
 */
const FRAME_SAMPLER_SOURCE = `(() => {
  const frames = []
  window.__benchFrames = frames
  const tick = (timestamp) => { frames.push(timestamp); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
})()`

/** Start recording every animation frame timestamp — one callback per painted frame. */
async function installFrameSampler(page: Page): Promise<void> {
  await page.evaluate(FRAME_SAMPLER_SOURCE)
}

async function readFrameTimestamps(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as FrameSamplerWindow).__benchFrames)
}

async function readFrameCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as FrameSamplerWindow).__benchFrames.length)
}

function metricValue(metrics: { name: string; value: number }[], name: string): number {
  return metrics.find((metric) => metric.name === name)?.value ?? 0
}

/** RSS of every Chrome process, resolved from the browser's own process table. */
async function chromeRssBytes(browser: Browser): Promise<number | null> {
  try {
    const session = await browser.newBrowserCDPSession()
    try {
      const { processInfo } = (await session.send('SystemInfo.getProcessInfo')) as {
        processInfo: { id: number }[]
      }
      const pids = processInfo.map((process) => process.id).filter((pid) => Number.isInteger(pid) && pid > 0)
      if (pids.length === 0) return null
      const output = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf-8' })
      const totalKb = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .reduce((sum, line) => {
          const rss = Number(line.split(/\s+/)[1])
          return Number.isFinite(rss) ? sum + rss : sum
        }, 0)
      return totalKb > 0 ? totalKb * 1024 : null
    } finally {
      await session.detach()
    }
  } catch {
    return null
  }
}

async function sampleCheckpoint(
  page: Page,
  cdp: CDPSession,
  browser: Browser,
  label: string,
  turn: number,
  tokens: number,
  startedAt: number,
  frames: FrameStats,
): Promise<Checkpoint> {
  await settle(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await settle(page)

  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }
  const dom = (await cdp.send('Memory.getDOMCounters')) as {
    documents: number
    nodes: number
    jsEventListeners: number
  }
  const mounted = (await page.evaluate(
    (selector: string) => ({
      elements: document.getElementsByTagName('*').length,
      feedItems: document.querySelectorAll(selector).length,
      feedPlaceholders: document.querySelectorAll('[data-item-index][data-placeholder]').length,
      overlayScrollbars: document.querySelectorAll('[data-overlayscrollbars-viewport]').length,
    }),
    FEED_ITEM_SELECTOR,
  )) as {
    elements: number
    feedItems: number
    feedPlaceholders: number
    overlayScrollbars: number
  }

  return {
    label,
    turn,
    tokens,
    heapUsedBytes: metricValue(metrics, 'JSHeapUsedSize'),
    heapTotalBytes: metricValue(metrics, 'JSHeapTotalSize'),
    domNodes: dom.nodes,
    domElements: mounted.elements,
    feedItems: mounted.feedItems,
    feedPlaceholders: mounted.feedPlaceholders,
    overlayScrollbars: mounted.overlayScrollbars,
    jsEventListeners: dom.jsEventListeners,
    documents: dom.documents,
    browserRssBytes: await chromeRssBytes(browser),
    frames,
    elapsedMs: Math.round(performance.now() - startedAt),
  }
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function formatMb(bytes: number | null): string {
  return bytes === null ? 'n/a' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function printReport(report: BaselineReport): void {
  const { workload, checkpoints, summary } = report
  const rows = checkpoints.map((checkpoint) => [
    checkpoint.label,
    checkpoint.tokens.toLocaleString('en-US'),
    formatMb(checkpoint.heapUsedBytes),
    checkpoint.domNodes.toLocaleString('en-US'),
    checkpoint.domElements.toLocaleString('en-US'),
    checkpoint.feedItems.toLocaleString('en-US'),
    checkpoint.jsEventListeners.toLocaleString('en-US'),
    formatMb(checkpoint.browserRssBytes),
    `${checkpoint.frames.fps.toFixed(0)}`,
    `${checkpoint.frames.worstFrameMs.toFixed(0)}`,
    `${checkpoint.frames.longFrames}`,
    `${(checkpoint.elapsedMs / 1000).toFixed(1)}s`,
  ])

  const headers = [
    'checkpoint',
    'tokens',
    'js heap',
    'dom nodes',
    'dom els',
    'items',
    'listeners',
    'chrome rss',
    'fps',
    'worst',
    'jank',
    'elapsed',
  ]
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  )
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')

  console.log('')
  console.log('Web memory benchmark')
  console.log(`  workload    ${workload.turns} turns, ${workload.totalTokens.toLocaleString('en-US')} tokens`)
  console.log(
    `  frames      ${workload.totalFrames.toLocaleString('en-US')} (${workload.toolCallsPerTurn} tool calls/turn)`,
  )
  console.log(`  browser     ${report.browser.name} ${report.browser.version} on ${report.platform.cpu}`)
  console.log('')
  console.log(line(headers))
  console.log(line(widths.map((width) => '-'.repeat(width))))
  for (const row of rows) console.log(line(row))
  console.log('')
  console.log(`  cold-load heap       ${formatMb(summary.coldLoadHeapUsedBytes)}`)
  console.log(`  peak heap            ${formatMb(summary.peakHeapUsedBytes)}`)
  console.log(`  retained heap (GC)   ${formatMb(summary.retainedHeapUsedBytes)}`)
  console.log(`  heap growth          ${formatMb(summary.heapGrowthBytes)}`)
  console.log(
    `  leak slope           ${(summary.leakSlopeBytesPer10kTokens / (1024 * 1024)).toFixed(2)} MB per 10K tokens`,
  )
  console.log(
    `  dom elements         ${summary.domElementsCold.toLocaleString('en-US')} cold → ${summary.domElementsAtTarget.toLocaleString('en-US')} at ${workload.totalTokens.toLocaleString('en-US')} tokens`,
  )
  console.log(
    `  dom nodes (CDP)      ${summary.domNodesCold.toLocaleString('en-US')} cold → ${summary.domNodesAtTarget.toLocaleString('en-US')}`,
  )
  console.log(`  feed items mounted   ${summary.feedItemsAtTarget.toLocaleString('en-US')}`)
  console.log(`  feed placeholders    ${summary.feedPlaceholdersAtTarget.toLocaleString('en-US')}`)
  console.log(`  overlay scrollbars   ${summary.overlayScrollbarsAtTarget.toLocaleString('en-US')}`)
  console.log(
    `  fps                  ${summary.idleFps.toFixed(0)} idle → ${summary.streamingFps.toFixed(1)} streaming (worst frame ${summary.worstFrameMs.toFixed(0)} ms, ${summary.longFrames} janky frames)`,
  )
  console.log(
    `  chrome rss           ${formatMb(summary.browserRssColdBytes)} cold → ${formatMb(summary.browserRssPeakBytes)} peak`,
  )
  console.log(`  total duration       ${(summary.totalDurationMs / 1000).toFixed(1)}s`)
  console.log('')
  console.log('  DOM nodes by selector')
  for (const contributor of report.domContributors) {
    console.log(`    ${contributor.selector.padEnd(34)} ${contributor.nodes.toLocaleString('en-US')}`)
  }
  console.log('')
}

interface ComparisonRow {
  label: string
  before: number
  after: number
  delta: number | null
  verdict: Verdict
}

interface ComparableMetric {
  label: string
  before: number | null
  after: number | null
  higherIsBetter: boolean
}

function lastCheckpoint(report: BaselineReport): Checkpoint | undefined {
  return report.checkpoints[report.checkpoints.length - 1]
}

function comparableMetrics(previous: BaselineReport, current: BaselineReport): ComparableMetric[] {
  const rows: [string, number | null, number | null, boolean][] = [
    ['js heap (cold)', previous.summary.coldLoadHeapUsedBytes, current.summary.coldLoadHeapUsedBytes, false],
    ['js heap (peak)', previous.summary.peakHeapUsedBytes, current.summary.peakHeapUsedBytes, false],
    ['js heap (retained)', previous.summary.retainedHeapUsedBytes, current.summary.retainedHeapUsedBytes, false],
    ['heap growth', previous.summary.heapGrowthBytes, current.summary.heapGrowthBytes, false],
    [
      'leak slope (MB/10K)',
      previous.summary.leakSlopeBytesPer10kTokens,
      current.summary.leakSlopeBytesPer10kTokens,
      false,
    ],
    ['dom elements', previous.summary.domElementsAtTarget, current.summary.domElementsAtTarget, false],
    ['dom nodes (CDP)', previous.summary.domNodesAtTarget, current.summary.domNodesAtTarget, false],
    [
      'listeners',
      lastCheckpoint(previous)?.jsEventListeners ?? null,
      lastCheckpoint(current)?.jsEventListeners ?? null,
      false,
    ],
    ['feed items', previous.summary.feedItemsAtTarget, current.summary.feedItemsAtTarget, false],
    ['chrome rss (cold)', previous.summary.browserRssColdBytes, current.summary.browserRssColdBytes, false],
    ['chrome rss (peak)', previous.summary.browserRssPeakBytes, current.summary.browserRssPeakBytes, false],
    ['fps (idle)', previous.summary.idleFps, current.summary.idleFps, true],
    ['fps (streaming)', previous.summary.streamingFps, current.summary.streamingFps, true],
    ['worst frame (ms)', previous.summary.worstFrameMs, current.summary.worstFrameMs, false],
    ['janky frames', previous.summary.longFrames, current.summary.longFrames, false],
    ['duration (s)', previous.summary.totalDurationMs, current.summary.totalDurationMs, false],
  ]
  return rows.map(([label, before, after, higherIsBetter]) => ({ label, before, after, higherIsBetter }))
}

function buildComparison(previous: BaselineReport, current: BaselineReport): ComparisonRow[] {
  return comparableMetrics(previous, current)
    .filter((metric): metric is ComparableMetric & { before: number; after: number } => {
      return metric.before !== null && metric.after !== null
    })
    .map((metric) => ({
      label: metric.label,
      before: metric.before,
      after: metric.after,
      delta: deltaPct(metric.before, metric.after),
      verdict: verdict(metric.before, metric.after, metric.higherIsBetter),
    }))
}

function formatMetricValue(label: string, value: number): string {
  if (label.startsWith('js heap') || label.startsWith('heap growth') || label.startsWith('chrome rss')) {
    return formatMb(value)
  }
  if (label.startsWith('leak slope')) return `${(value / (1024 * 1024)).toFixed(2)} MB`
  if (label.startsWith('duration')) return `${(value / 1000).toFixed(1)}s`
  if (label.startsWith('fps')) return value.toFixed(1)
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function printComparison(previous: BaselineReport, current: BaselineReport, previousLabel: string): void {
  const rows = buildComparison(previous, current)
  const headers = ['metric', 'before', 'after', 'delta', 'verdict']
  const cells = rows.map((row) => [
    row.label,
    formatMetricValue(row.label, row.before),
    formatMetricValue(row.label, row.after),
    formatDelta(row.delta),
    row.verdict,
  ])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => (row[index] ?? '').length)),
  )
  const line = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')

  const better = rows.filter((row) => row.verdict === 'better').length
  const worse = rows.filter((row) => row.verdict === 'worse').length

  console.log(`  vs ${previousLabel}`)
  console.log('')
  console.log(line(headers))
  console.log(line(widths.map((width) => '-'.repeat(width))))
  for (const row of cells) console.log(line(row))
  console.log('')
  console.log(`  ${better} better, ${worse} worse, ${rows.length - better - worse} unchanged`)
  console.log('')
}

async function run(): Promise<void> {
  const options = parseOptions()
  const config = defaultWorkload(options.targetTokens)
  const startedAt = performance.now()

  if (!options.skipBuild) {
    console.log('[bench] building (set BENCH_SKIP_BUILD=1 to reuse dist/)...')
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
  }

  const port = await findFreePort()
  const serverUrl = `http://127.0.0.1:${port}`
  const benchRoot = await mkdtemp(join(tmpdir(), 'openfox-bench-'))
  const workdir = join(benchRoot, 'project')
  const homeDir = join(benchRoot, 'home')
  const configDir = join(homeDir, 'openfox')
  await mkdir(workdir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  // A pre-existing config file keeps the CLI out of its interactive first-run
  // setup wizard; the temp HOME means nothing touches the real user config.
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ workspace: { workdir }, server: { openBrowser: false } }, null, 2),
    'utf-8',
  )

  let serverProcess: ChildProcess | null = null
  let browser: Browser | null = null

  try {
    serverProcess = spawn('node', ['dist/cli/index.js', '--port', String(port), '--no-browser'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: homeDir,
        XDG_DATA_HOME: homeDir,
        OPENFOX_PORT: String(port),
        OPENFOX_DB_PATH: ':memory:',
        OPENFOX_MOCK_LLM: 'true',
        OPENFOX_WORKDIR: workdir,
        OPENFOX_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProcess.stdout?.on('data', () => {})
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.toLowerCase().includes('error')) process.stderr.write(`[server] ${text}`)
    })

    await waitForHealth(serverUrl, 60_000)

    await apiFetch(serverUrl, '/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Benchmark',
        url: 'http://127.0.0.1:9/v1',
        backend: 'vllm',
        model: 'bench-model',
      }),
    })
    const { project } = await apiFetch<{ project: { id: string } }>(serverUrl, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Benchmark', workdir }),
    })
    const { session } = await apiFetch<{ session: { id: string } }>(serverUrl, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, title: 'Memory benchmark' }),
    })

    const appliedSettings: Record<string, string> = { ...options.perfSettings }
    if (options.maxVisibleItems !== null) {
      appliedSettings['display.maxVisibleItems'] = String(options.maxVisibleItems)
    }
    for (const [key, value] of Object.entries(appliedSettings)) {
      await apiFetch(serverUrl, `/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
    }
    if (Object.keys(options.perfSettings).length > 0) {
      console.log(`[bench] performance settings enabled: ${Object.keys(options.perfSettings).join(', ')}`)
    }

    const launchedBrowser = await chromium.launch({ headless: true })
    browser = launchedBrowser
    const context: BrowserContext = await launchedBrowser.newContext({ viewport: { width: 1450, height: 920 } })
    const page = await context.newPage()

    let socket: { send: (data: string) => void } | null = null
    let resolveSocket: (value: { send: (data: string) => void }) => void = () => {}
    const socketReady = new Promise<{ send: (data: string) => void }>((resolveSocketPromise) => {
      resolveSocket = resolveSocketPromise
    })

    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      ws.connectToServer()
      socket = ws as unknown as { send: (data: string) => void }
      resolveSocket(socket)
    })

    await page.goto(`${serverUrl}/p/${project.id}/s/${session.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: 30_000 })
    socket = await socketReady
    if (!socket) throw new Error('The app never opened its WebSocket connection')

    const send = (payload: unknown): void => {
      socket?.send(JSON.stringify(payload))
    }

    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')

    await settle(page)
    await delay(500)

    // Control sample: headless Chrome drives frames off its own BeginFrame
    // source, so an idle baseline is required before reading anything into a
    // low fps during streaming.
    await installFrameSampler(page)
    await delay(1_500)
    const idleTimestamps = await readFrameTimestamps(page)
    const idleFrames = summarizeFrames(idleTimestamps)
    // The cursor stays at 0 so the cold-load row reports the at-rest cadence
    // rather than an empty window.
    let frameCursor = 0

    // Each checkpoint's window ends where the previous one's measurement
    // started, so the forced GC pause lands in no window.
    const checkpoint = async (label: string, turn: number, tokens: number): Promise<Checkpoint> => {
      const timestamps = await readFrameTimestamps(page)
      const frames = summarizeFrames(timestamps.slice(frameCursor))
      const result = await sampleCheckpoint(page, cdp, launchedBrowser, label, turn, tokens, startedAt, frames)
      frameCursor = await readFrameCount(page)
      return result
    }

    const checkpoints: Checkpoint[] = []
    checkpoints.push(await checkpoint('cold load', -1, 0))

    const checkpointTurns = new Set(checkpointTurnIndices(config))
    let totalFrames = 0

    for (let turn = 0; turn < config.turns; turn++) {
      const frames = buildTurnFrames(session.id, turn, config)
      totalFrames += frames.length
      for (const batch of batches(frames, options.batchSize)) {
        for (const frame of batch) send(frame)
        await settle(page)
      }
      if (checkpointTurns.has(turn)) {
        checkpoints.push(await checkpoint(`turn ${turn + 1}`, turn, tokensAfterTurn(config, turn)))
      }
    }

    // Settle: let the app finish flushing, then measure what it actually retains.
    await delay(options.settleMs)
    checkpoints.push(await checkpoint('settled', config.turns - 1, totalTokens(config)))

    const streamingFrames = summarizeFrames((await readFrameTimestamps(page)).slice(idleFrames.frames))

    await verifyRendered(page, config.turns)

    const dom = await collectDomInfo(page)
    console.log(
      '[debug] feed flags',
      JSON.stringify(
        await page.evaluate(() => {
          const debug = document.querySelector('[data-testid="feed-debug"]')
          return debug
            ? {
                virtualization: debug.getAttribute('data-virtualization'),
                startIndex: debug.getAttribute('data-start-index'),
                totalItems: debug.getAttribute('data-total-items'),
                pinLog: debug.getAttribute('data-pin-log'),
              }
            : 'no feed-debug element'
        }),
      ),
    )

    const cold = checkpoints[0]
    const retained = checkpoints[checkpoints.length - 1]
    if (!cold || !retained) throw new Error('No checkpoints were sampled')

    const streamed = checkpoints.slice(1)
    const peak = streamed.reduce((max, checkpoint) => Math.max(max, checkpoint.heapUsedBytes), 0)
    const rssValues = checkpoints
      .map((checkpoint) => checkpoint.browserRssBytes)
      .filter((value): value is number => value !== null)

    const report: BaselineReport = {
      generatedAt: new Date().toISOString(),
      browser: { name: 'chromium', version: browser.version() },
      platform: {
        node: process.version,
        os: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        totalMemBytes: totalmem(),
      },
      workload: { ...config, totalTokens: totalTokens(config), totalFrames },
      settings: appliedSettings,
      checkpoints,
      idleFrames,
      streamingFrames,
      domContributors: dom.contributors,
      feedItems: dom.feedItems,
      summary: {
        coldLoadHeapUsedBytes: cold.heapUsedBytes,
        peakHeapUsedBytes: peak,
        retainedHeapUsedBytes: retained.heapUsedBytes,
        heapGrowthBytes: retained.heapUsedBytes - cold.heapUsedBytes,
        leakSlopeBytesPer10kTokens:
          slope(
            streamed.map((checkpoint) => checkpoint.tokens / 10_000),
            streamed.map((checkpoint) => checkpoint.heapUsedBytes),
          ) || 0,
        domNodesAtTarget: retained.domNodes,
        domNodesCold: cold.domNodes,
        domElementsAtTarget: retained.domElements,
        domElementsCold: cold.domElements,
        feedItemsAtTarget: retained.feedItems,
        feedPlaceholdersAtTarget: retained.feedPlaceholders,
        overlayScrollbarsAtTarget: retained.overlayScrollbars,
        browserRssColdBytes: cold.browserRssBytes,
        browserRssPeakBytes: rssValues.length > 0 ? Math.max(...rssValues) : null,
        idleFps: idleFrames.fps,
        streamingFps: streamingFrames.fps,
        worstFrameMs: streamingFrames.worstFrameMs,
        longFrames: streamingFrames.longFrames,
        totalDurationMs: Math.round(performance.now() - startedAt),
      },
    }

    printReport(report)
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    console.log(`[bench] baseline written to ${options.outputPath}`)

    if (options.comparePath) {
      const previous = JSON.parse(await readFile(options.comparePath, 'utf-8')) as BaselineReport
      printComparison(previous, report, relative(REPO_ROOT, options.comparePath))
    }

    console.log(
      `[bench] heap samples p50=${formatMb(
        percentile(
          streamed.map((c) => c.heapUsedBytes),
          0.5,
        ),
      )}`,
    )
  } finally {
    await browser?.close().catch(() => {})
    serverProcess?.kill('SIGTERM')
    if (!options.keepArtifacts) {
      await rm(benchRoot, { recursive: true, force: true }).catch(() => {})
    } else {
      console.log(`[bench] artifacts kept at ${benchRoot}`)
    }
  }
}

/** Fail loudly if the streamed conversation never actually rendered. */
async function verifyRendered(page: Page, turns: number): Promise<void> {
  const scroller = page.locator(CHAT_SCROLL_SELECTOR)
  await scroller.waitFor({ state: 'attached', timeout: 10_000 })
  const items = await page.locator(FEED_ITEM_SELECTOR).count()
  const lastPrompt = await page.getByText(`Benchmark turn ${turns - 1}:`, { exact: false }).count()
  if (items === 0 || lastPrompt === 0) {
    throw new Error(
      `The streamed conversation did not render (mounted feed items: ${items}, last prompt found: ${lastPrompt}). ` +
        'The benchmark would have measured an empty page.',
    )
  }
}

interface DomContributor {
  selector: string
  nodes: number
}

interface DomInfo {
  feedItems: number
  contributors: DomContributor[]
}

/** Where the DOM nodes actually live, and how many feed items are mounted. */
async function collectDomInfo(page: Page, top = 8): Promise<DomInfo> {
  const [feedItems, contributors] = await Promise.all([
    page.locator(FEED_ITEM_SELECTOR).count(),
    page.evaluate((limit: number) => {
      const counts = new Map<string, number>()
      const all = document.getElementsByTagName('*')
      for (let index = 0; index < all.length; index++) {
        const element = all[index]
        if (!element) continue
        const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2) : []
        const key = `${element.tagName.toLowerCase()}${classes.length > 0 ? `.${classes.join('.')}` : ''}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([selector, nodes]) => ({ selector, nodes }))
        .sort((a, b) => b.nodes - a.nodes)
        .slice(0, limit)
    }, top),
  ])
  return { feedItems, contributors }
}

run().catch((error: unknown) => {
  console.error('[bench] failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
