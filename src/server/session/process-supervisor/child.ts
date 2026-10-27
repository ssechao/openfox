import { fork, type ChildProcess } from 'node:child_process'
import { spawnGitProcess } from '../../git/spawn.js'
import { GIT_QUERY_TIMEOUT_MS } from '../../utils/bounded-exec.js'
import { installParentExitGuard } from '../../utils/parent-exit-guard.js'
import { terminateProcessTree } from '../../utils/process-tree.js'
import {
  captureExclusiveProcessInventoryAsync,
  killTrackedChildren,
  readProcessInventory,
  verifyExclusiveProcessInventoryAfter,
} from '../worker/children.js'
import type { GatewayToSupervisorMessage, SupervisorToGatewayMessage } from './protocol.js'

installParentExitGuard()

const workers = new Map<string, ChildProcess>()
const gitProcesses = new Map<string, ChildProcess>()
let shuttingDown = false

function send(message: SupervisorToGatewayMessage): void {
  if (process.connected) process.send?.(message)
}

function runGit(requestId: string, cwd: string, args: string[]): void {
  let proc: ChildProcess
  try {
    proc = spawnGitProcess(cwd, args)
  } catch {
    send({ type: 'git.result', requestId, code: null, stdout: '' })
    return
  }

  gitProcesses.set(requestId, proc)
  send({
    type: 'git.spawned',
    requestId,
    pid: proc.pid ?? -1,
    parentPid: process.pid,
    cwd,
    args,
  })
  let stdout = ''
  let settled = false
  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    gitProcesses.delete(requestId)
    send({ type: 'git.result', requestId, code, stdout })
  }
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    gitProcesses.delete(requestId)
    void terminateProcessTree(proc)
      .catch(() => undefined)
      .then(() => send({ type: 'git.result', requestId, code: null, stdout: '' }))
  }, GIT_QUERY_TIMEOUT_MS)

  proc.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  proc.on('close', (code) => finish(code))
  proc.on('error', () => finish(null))
}

function spawnWorker(message: Extract<GatewayToSupervisorMessage, { type: 'worker.spawn' }>): void {
  if (shuttingDown || workers.has(message.workerKey)) {
    send({
      type: 'worker.spawn_error',
      requestId: message.requestId,
      workerKey: message.workerKey,
      error: shuttingDown ? 'Supervisor is shutting down' : 'Worker already exists',
    })
    return
  }

  let worker: ChildProcess
  try {
    worker = fork(message.path, [], {
      execArgv: message.execArgv,
      env: message.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: false,
    })
  } catch (error) {
    send({
      type: 'worker.spawn_error',
      requestId: message.requestId,
      workerKey: message.workerKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  workers.set(message.workerKey, worker)
  const pid = worker.pid ?? -1
  const inventory = pid > 0 ? readProcessInventory(pid) : { status: 'absent' as const }
  send({
    type: 'worker.spawned',
    requestId: message.requestId,
    workerKey: message.workerKey,
    pid,
    ...(inventory.status === 'found' ? { inventory: inventory.process } : {}),
  })
  worker.on('message', (payload) => {
    send({ type: 'worker.message', workerKey: message.workerKey, message: payload })
  })
  worker.stdout?.on('data', (chunk: Buffer) => {
    send({ type: 'worker.stdout', workerKey: message.workerKey, chunk: chunk.toString('utf8') })
  })
  worker.stderr?.on('data', (chunk: Buffer) => {
    send({ type: 'worker.stderr', workerKey: message.workerKey, chunk: chunk.toString('utf8') })
  })
  worker.on('error', (error) => {
    send({ type: 'worker.error', workerKey: message.workerKey, error: error.message })
  })
  worker.on('exit', (code, signal) => {
    if (workers.get(message.workerKey) !== worker) return
    send({ type: 'worker.exit', workerKey: message.workerKey, code, signal })
  })
  worker.on('close', (code, signal) => {
    if (workers.get(message.workerKey) !== worker) return
    workers.delete(message.workerKey)
    send({ type: 'worker.close', workerKey: message.workerKey, code, signal })
  })
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const active = [...workers.values()]
  const activeGit = [...gitProcesses.values()]
  gitProcesses.clear()
  await Promise.all(activeGit.map((proc) => terminateProcessTree(proc).catch(() => undefined)))
  await Promise.all(
    active.map(
      (worker) =>
        new Promise<void>((resolve) => {
          if (worker.exitCode !== null || worker.signalCode !== null) {
            resolve()
            return
          }
          worker.once('exit', () => resolve())
          try {
            worker.kill('SIGTERM')
          } catch {
            resolve()
          }
        }),
    ),
  )
  send({ type: 'shutdown.complete' })
  process.exit(0)
}

process.on('message', (raw) => {
  const message = raw as GatewayToSupervisorMessage
  if (message.type === 'worker.spawn') {
    spawnWorker(message)
    return
  }
  if (message.type === 'worker.send') {
    const worker = workers.get(message.workerKey)
    if (worker?.connected) worker.send(message.message as object)
    return
  }
  if (message.type === 'worker.kill') {
    try {
      workers.get(message.workerKey)?.kill(message.signal)
    } catch {
      return
    }
    return
  }
  if (message.type === 'git.run') {
    runGit(message.requestId, message.cwd, message.args)
    return
  }
  if (message.type === 'children.cleanup') {
    void killTrackedChildren(message.path)
      .then((killedChildren) => send({ type: 'children.cleanup.result', requestId: message.requestId, killedChildren }))
      .catch((error) =>
        send({
          type: 'children.cleanup.result',
          requestId: message.requestId,
          killedChildren: [],
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    return
  }
  if (message.type === 'children.capture') {
    void captureExclusiveProcessInventoryAsync(message.workerPid, message.path, {
      capturedAt: message.capturedAt,
      ...(message.recordedWorker ? { recordedWorker: message.recordedWorker } : {}),
    })
      .then((inventory) => send({ type: 'children.capture.result', requestId: message.requestId, inventory }))
      .catch((error) =>
        send({
          type: 'children.capture.result',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    return
  }
  if (message.type === 'children.verify') {
    void verifyExclusiveProcessInventoryAfter(message.inventory)
      .then((orphanCheck) => send({ type: 'children.verify.result', requestId: message.requestId, orphanCheck }))
      .catch((error) =>
        send({
          type: 'children.verify.result',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    return
  }
  if (message.type === 'shutdown') void shutdown()
})

send({ type: 'ready', pid: process.pid })
