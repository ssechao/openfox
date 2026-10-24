import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GatewayToSupervisorMessage, SupervisorToGatewayMessage } from './protocol.js'

export interface SupervisorWorkerHandle {
  readonly workerKey: string
  pid: number | undefined
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stderr: EventEmitter
  send(message: unknown): boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

interface SupervisorEntry {
  path: string
  execArgv: string[]
}

interface SessionProcessSupervisorOptions {
  forkProcess?: typeof fork
  entry?: SupervisorEntry
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
}

interface PendingGit {
  resolve: (result: { code: number | null; stdout: string }) => void
  reject: (error: Error) => void
}

interface GitProcessIntrospection {
  pid: number
  parentPid: number
  cwd: string
  args: string[]
}

export interface ProcessSupervisorIntrospection {
  pid: number
  lastGitProcess: GitProcessIntrospection | null
}

function resolveSupervisorEntry(): SupervisorEntry {
  const here = dirname(fileURLToPath(import.meta.url))
  const sourceEntry = join(here, 'child.ts')
  if (existsSync(sourceEntry)) return { path: sourceEntry, execArgv: ['--import', 'tsx/esm'] }
  const bundledEntry = join(here, 'session', 'process-supervisor', 'child.js')
  if (existsSync(bundledEntry)) return { path: bundledEntry, execArgv: [] }
  throw new Error(`Session process supervisor entry not found (looked for ${sourceEntry} and ${bundledEntry})`)
}

class RemoteWorkerHandle extends EventEmitter implements SupervisorWorkerHandle {
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stderr = new EventEmitter()

  constructor(
    readonly workerKey: string,
    private readonly dispatch: (message: GatewayToSupervisorMessage) => boolean,
  ) {
    super()
  }

  send(message: unknown): boolean {
    return this.dispatch({ type: 'worker.send', workerKey: this.workerKey, message })
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    return this.dispatch({ type: 'worker.kill', workerKey: this.workerKey, signal })
  }

  markExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

export class SessionProcessSupervisor {
  private child: ChildProcess | null = null
  private ready = false
  private startPromise: Promise<void> | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private startTimer: NodeJS.Timeout | null = null
  private shutdownResolve: (() => void) | null = null
  private shutdownTimer: NodeJS.Timeout | null = null
  private readonly workers = new Map<string, RemoteWorkerHandle>()
  private readonly pendingGit = new Map<string, PendingGit>()
  private supervisorPid: number | null = null
  private lastGitProcess: GitProcessIntrospection | null = null
  private readonly forkProcess: typeof fork
  private readonly entry: SupervisorEntry

  constructor(private readonly options: SessionProcessSupervisorOptions = {}) {
    this.forkProcess = options.forkProcess ?? fork
    this.entry = options.entry ?? resolveSupervisorEntry()
  }

  isReady(): boolean {
    return this.ready
  }

  introspection(): ProcessSupervisorIntrospection | null {
    if (this.supervisorPid === null) return null
    return { pid: this.supervisorPid, lastGitProcess: this.lastGitProcess }
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.startPromise) return this.startPromise

    const started = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })
    this.startPromise = started

    let child: ChildProcess
    try {
      child = this.forkProcess(this.entry.path, [], {
        execArgv: this.entry.execArgv,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        detached: false,
      })
    } catch (error) {
      this.failStart(new Error('Session process supervisor failed to spawn', { cause: error }))
      return started
    }

    this.child = child
    child.on('message', (message) => this.handleMessage(message as SupervisorToGatewayMessage))
    child.on('error', (error) => {
      if (!this.ready) this.failStart(new Error(`Session process supervisor startup failed: ${error.message}`))
    })
    child.on('exit', (code, signal) => this.handleExit(code, signal))

    this.startTimer = setTimeout(() => {
      this.failStart(new Error('Session process supervisor readiness timed out'))
      try {
        child.kill('SIGKILL')
      } catch {
        return
      }
    }, this.options.startupTimeoutMs ?? 10_000)

    return started
  }

  spawnWorker(options: {
    workerKey: string
    path: string
    execArgv: string[]
    env: NodeJS.ProcessEnv
  }): SupervisorWorkerHandle {
    if (!this.ready) throw new Error('Session process supervisor is not ready')
    if (this.workers.has(options.workerKey)) throw new Error(`Worker already exists: ${options.workerKey}`)
    const handle = new RemoteWorkerHandle(options.workerKey, (message) => this.dispatch(message))
    this.workers.set(options.workerKey, handle)
    this.dispatch({
      type: 'worker.spawn',
      requestId: crypto.randomUUID(),
      workerKey: options.workerKey,
      path: options.path,
      execArgv: options.execArgv,
      env: options.env,
    })
    return handle
  }

  runGit(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
    if (!this.ready) return Promise.reject(new Error('Session process supervisor is not ready'))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.pendingGit.set(requestId, { resolve, reject })
      if (!this.dispatch({ type: 'git.run', requestId, cwd, args })) {
        this.pendingGit.delete(requestId)
        reject(new Error('Session process supervisor is unavailable'))
      }
    })
  }

  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) {
      this.handleExit(child.exitCode, child.signalCode)
      return
    }

    const completed = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve
    })
    this.dispatch({ type: 'shutdown' })
    this.shutdownTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        this.finishShutdown()
      }
    }, this.options.shutdownTimeoutMs ?? 5_000)
    await completed
  }

  private dispatch(message: GatewayToSupervisorMessage): boolean {
    const child = this.child
    if (!child?.connected) return false
    try {
      child.send(message)
      return true
    } catch {
      return false
    }
  }

  private handleMessage(message: SupervisorToGatewayMessage): void {
    if (message.type === 'ready') {
      if (this.ready) return
      this.ready = true
      this.supervisorPid = message.pid
      if (this.startTimer) clearTimeout(this.startTimer)
      this.startTimer = null
      this.startResolve?.()
      this.startResolve = null
      this.startReject = null
      return
    }

    if (message.type === 'worker.spawned') {
      const handle = this.workers.get(message.workerKey)
      if (handle) handle.pid = message.pid
      return
    }
    if (message.type === 'worker.spawn_error') {
      const handle = this.workers.get(message.workerKey)
      if (!handle) return
      handle.emit('error', new Error(message.error))
      handle.markExit(1, null)
      this.workers.delete(message.workerKey)
      return
    }
    if (message.type === 'worker.message') {
      this.workers.get(message.workerKey)?.emit('message', message.message)
      return
    }
    if (message.type === 'worker.stderr') {
      this.workers.get(message.workerKey)?.stderr.emit('data', Buffer.from(message.chunk))
      return
    }
    if (message.type === 'worker.error') {
      this.workers.get(message.workerKey)?.emit('error', new Error(message.error))
      return
    }
    if (message.type === 'worker.exit') {
      const handle = this.workers.get(message.workerKey)
      if (!handle) return
      this.workers.delete(message.workerKey)
      handle.markExit(message.code, message.signal)
      return
    }
    if (message.type === 'git.spawned') {
      this.lastGitProcess = {
        pid: message.pid,
        parentPid: message.parentPid,
        cwd: message.cwd,
        args: message.args,
      }
      return
    }
    if (message.type === 'git.result') {
      const pending = this.pendingGit.get(message.requestId)
      if (!pending) return
      this.pendingGit.delete(message.requestId)
      pending.resolve({ code: message.code, stdout: message.stdout })
      return
    }
    if (message.type === 'shutdown.complete') this.finishShutdown()
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasReady = this.ready
    this.ready = false
    this.child = null
    this.supervisorPid = null
    if (!wasReady) {
      this.failStart(
        new Error(
          `Session process supervisor exited before readiness (code=${String(code)}, signal=${String(signal)})`,
        ),
      )
    }
    for (const handle of this.workers.values()) handle.markExit(code, signal)
    this.workers.clear()
    for (const pending of this.pendingGit.values()) pending.reject(new Error('Session process supervisor exited'))
    this.pendingGit.clear()
    this.finishShutdown()
  }

  private failStart(error: Error): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    this.startReject?.(error)
    this.startResolve = null
    this.startReject = null
    this.startPromise = null
  }

  private finishShutdown(): void {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
    this.shutdownTimer = null
    this.ready = false
    this.child = null
    this.supervisorPid = null
    this.shutdownResolve?.()
    this.shutdownResolve = null
  }
}
