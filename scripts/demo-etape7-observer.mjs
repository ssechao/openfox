import WebSocket from 'ws'
import { performance } from 'node:perf_hooks'

const [base, witnessId, perturbatorId] = process.argv.slice(2)
const PROBE_INTERVAL_MS = 50
const IDENTITY_INTERVAL_MS = 100
const CLIENT_TIMEOUT_MS = 500
const now = () => performance.timeOrigin + performance.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!base || !witnessId || !perturbatorId || typeof process.send !== 'function') {
  throw new Error('Observer requires base URL, witness session, perturbator session, and IPC')
}

const send = (message, callback) => process.send?.(message, callback)
const stop = { value: false }
const probes = {
  session: { latencies: [], failures: 0, deadlines: 0, missedDeadlines: 0 },
  health: { latencies: [], failures: 0, deadlines: 0, missedDeadlines: 0 },
}
const deltaTimes = []
let deltaChars = 0
let firstDeltaAt = 0
let streamDoneAt = 0
let expectedWitness = null
const identityObservations = []
const toolCalls = new Map()
let stopping = false
let readySent = false
const loadedSessions = new Set()

async function probeLoop(name, url) {
  const stats = probes[name]
  let next = now()
  while (!stop.value) {
    const beforeWait = now()
    if (beforeWait < next) await sleep(next - beforeWait)
    if (stop.value) break
    const started = now()
    const missed = Math.max(0, Math.floor((started - next) / PROBE_INTERVAL_MS))
    stats.missedDeadlines += missed
    stats.deadlines += missed + 1
    next += (missed + 1) * PROBE_INTERVAL_MS
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) })
      await response.arrayBuffer()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      stats.latencies.push(now() - started)
    } catch {
      stats.failures += 1
    }
  }
}

async function identityLoop() {
  let next = now()
  while (!stop.value) {
    if (!expectedWitness) {
      await sleep(10)
      next = now()
      continue
    }
    const beforeWait = now()
    if (beforeWait < next) await sleep(next - beforeWait)
    if (stop.value) break
    const at = now()
    next += IDENTITY_INTERVAL_MS
    try {
      const response = await fetch(`${base}/api/test/worker`, {
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const identity = body.activeWorkers?.find((worker) => worker.sessionId === witnessId)
      identityObservations.push({
        at,
        ok: Boolean(identity),
        match:
          identity?.pid === expectedWitness.pid &&
          identity?.token?.workerId === expectedWitness.token.workerId &&
          identity?.token?.generation === expectedWitness.token.generation,
        pid: identity?.pid ?? null,
        workerId: identity?.token?.workerId ?? null,
        generation: identity?.token?.generation ?? null,
      })
    } catch {
      identityObservations.push({
        at,
        ok: false,
        match: false,
        pid: null,
        workerId: null,
        generation: null,
      })
    }
  }
}

const probePromises = [
  probeLoop('session', `${base}/api/sessions/${witnessId}`),
  probeLoop('health', `${base}/api/health`),
  identityLoop(),
]

const wsUrl = `ws://127.0.0.1:${new URL(base).port}/ws`
const witnessSocket = new WebSocket(wsUrl)
const perturbatorSocket = new WebSocket(wsUrl)
const sockets = [witnessSocket, perturbatorSocket]

function loadSession(socket, id, sessionId) {
  socket.on('open', () => {
    socket.send(JSON.stringify({ id, type: 'session.load', payload: { sessionId } }))
  })
}

loadSession(witnessSocket, 'observer-load-witness', witnessId)
loadSession(perturbatorSocket, 'observer-load-perturbator', perturbatorId)

function handleSocketMessage(raw) {
  const at = now()
  const message = JSON.parse(String(raw))
  if (message.type === 'ack' && message.id?.startsWith('observer-load-')) {
    loadedSessions.add(message.id)
    if (!readySent && loadedSessions.size === 2) {
      readySent = true
      send({ type: 'ready', pid: process.pid, at })
    }
    return
  }
  if (message.sessionId === witnessId && message.type === 'chat.delta') {
    const content = typeof message.payload?.content === 'string' ? message.payload.content : ''
    deltaTimes.push(at)
    deltaChars += content.length
    if (firstDeltaAt === 0) {
      firstDeltaAt = at
      send({ type: 'firstDelta', at })
    }
    return
  }
  if (
    message.sessionId === witnessId &&
    message.type === 'chat.message_updated' &&
    firstDeltaAt > 0 &&
    message.payload?.updates?.isStreaming === false
  ) {
    streamDoneAt = at
    send({ type: 'streamDone', at })
    return
  }
  if (message.sessionId === perturbatorId && message.type === 'chat.tool_call') {
    toolCalls.set(message.payload.callId, {
      callId: message.payload.callId,
      tool: message.payload.tool,
      args: message.payload.args,
      startAt: at,
      endAt: 0,
      result: null,
    })
    send({ type: 'toolCall', callId: message.payload.callId, tool: message.payload.tool, at })
    return
  }
  if (message.sessionId === perturbatorId && message.type === 'chat.tool_result') {
    const observed = toolCalls.get(message.payload.callId)
    if (observed) {
      observed.endAt = at
      observed.result = message.payload.result
    }
  }
}

for (const socket of sockets) {
  socket.on('message', handleSocketMessage)
  socket.on('error', (error) => {
    send({ type: 'error', error: error.message })
  })
}

async function finish() {
  if (stopping) return
  stopping = true
  stop.value = true
  for (const socket of sockets) socket.close()
  await Promise.allSettled(probePromises)
  send(
    {
      type: 'result',
      pid: process.pid,
      deltaTimes,
      deltaChars,
      firstDeltaAt,
      streamDoneAt,
      probes,
      identityObservations,
      toolCalls: [...toolCalls.values()],
    },
    () => process.exit(0),
  )
}

process.on('message', (message) => {
  if (message?.type === 'expectedWitness') expectedWitness = message.identity
  if (message?.type === 'stop') void finish()
})

process.on('disconnect', () => {
  void finish()
})
