import type { PauseState } from '../../shared/types.js'
import type { RuntimeLastCommand, RuntimeSnapshot, RuntimeState } from '../../shared/diagnostics.js'

export type RuntimeKind = 'chat' | 'workflow' | 'compact'

export class SessionAlreadyRunningError extends Error {
  readonly code = 'SESSION_ALREADY_RUNNING'
  readonly status = 409

  constructor(message = 'Session is already running') {
    super(message)
    this.name = 'SessionAlreadyRunningError'
  }
}

export function isSessionAlreadyRunningError(error: unknown): error is SessionAlreadyRunningError {
  return error instanceof SessionAlreadyRunningError
}

export interface ExecutionHandle {
  readonly sessionId: string
  readonly generation: number
  readonly kind: RuntimeKind
  readonly controller: AbortController
  readonly signal: AbortSignal
}

interface Execution {
  generation: number
  kind: RuntimeKind
  controller: AbortController
}

export interface SessionRuntimeOptions {
  getPauseState?: (sessionId: string) => PauseState
}

const LAST_COMMAND_FOR_KIND: Record<RuntimeKind, RuntimeLastCommand> = {
  chat: 'launch',
  workflow: 'workflow',
  compact: 'compact',
}

/**
 * Single owner of a session's in-process execution. Acquire is synchronous and
 * happens before any side effect; the root AbortController is renewed per turn
 * and kept until the aborted work has settled.
 */
export class SessionRuntime {
  private generation = 0
  private execution: Execution | null = null
  private stopRequested = false
  private lastCommand: RuntimeLastCommand | null = null
  private destroyed = false
  private settleWaiters: Array<() => void> = []

  constructor(
    readonly sessionId: string,
    private readonly options: SessionRuntimeOptions = {},
  ) {}

  get state(): RuntimeState {
    if (this.execution && this.stopRequested) return 'stopping'
    if (this.execution?.kind === 'compact') return 'compacting'
    if (this.execution?.kind === 'workflow') return 'workflow'
    if (this.execution && this.options.getPauseState?.(this.sessionId) === 'paused') return 'paused'
    if (this.execution) return 'running'
    return 'idle'
  }

  snapshot(): RuntimeSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.state,
      lastCommand: this.lastCommand,
    }
  }

  currentHandle(): ExecutionHandle | null {
    const execution = this.execution
    if (!execution) return null
    return {
      sessionId: this.sessionId,
      generation: execution.generation,
      kind: execution.kind,
      controller: execution.controller,
      signal: execution.controller.signal,
    }
  }

  isCurrent(handle: ExecutionHandle): boolean {
    return this.execution?.generation === handle.generation && this.execution.controller === handle.controller
  }

  recordCommand(command: RuntimeLastCommand): void {
    this.lastCommand = command
  }

  /**
   * Atomically take ownership of this session. Throws if a turn is running or
   * still settling after Stop. No caller may perform side effects before this
   * returns.
   */
  acquire(kind: RuntimeKind): ExecutionHandle {
    if (this.destroyed) {
      throw new SessionAlreadyRunningError('Session is stopping')
    }
    if (this.execution) {
      throw new SessionAlreadyRunningError(this.stopRequested ? 'Session is stopping' : 'Session is already running')
    }
    const generation = ++this.generation
    const controller = new AbortController()
    this.execution = { generation, kind, controller }
    this.stopRequested = false
    this.lastCommand = LAST_COMMAND_FOR_KIND[kind]
    return {
      sessionId: this.sessionId,
      generation,
      kind,
      controller,
      signal: controller.signal,
    }
  }

  /**
   * Release a finished execution. Returns false when this handle is no longer
   * current (late `finally` of a previous turn) so the caller must not abort,
   * `setRunning(false)`, or drop the new controller.
   */
  release(handle: ExecutionHandle): boolean {
    if (!this.isCurrent(handle)) return false
    this.execution = null
    this.stopRequested = false
    this.flushSettleWaiters()
    return true
  }

  /**
   * Abort the current root controller and hold the session in `stopping` until
   * the aborted work releases. Idle sessions stay idle.
   */
  stop(): boolean {
    this.lastCommand = 'stop'
    if (!this.execution) return false
    this.stopRequested = true
    if (!this.execution.controller.signal.aborted) {
      this.execution.controller.abort()
    }
    return true
  }

  /** Abort only when the live execution is a workflow (MCP stopWorkflow). */
  abortWorkflow(): boolean {
    if (this.execution?.kind !== 'workflow') return false
    return this.stop()
  }

  wasStopped(handle?: ExecutionHandle): boolean {
    if (handle && !this.isCurrent(handle) && this.execution) return false
    return this.stopRequested || (handle?.controller.signal.aborted ?? false)
  }

  awaitSettled(): Promise<void> {
    if (!this.execution) return Promise.resolve()
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve)
    })
  }

  destroy(): void {
    this.stop()
    this.destroyed = true
    this.execution = null
    this.stopRequested = false
    this.flushSettleWaiters()
  }

  private flushSettleWaiters(): void {
    const waiters = this.settleWaiters
    this.settleWaiters = []
    for (const waiter of waiters) waiter()
  }
}

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>()

  constructor(private readonly options: SessionRuntimeOptions = {}) {}

  get(sessionId: string): SessionRuntime {
    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      runtime = new SessionRuntime(sessionId, this.options)
      this.runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  peek(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId)
  }

  remove(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    runtime.destroy()
    this.runtimes.delete(sessionId)
  }

  list(): RuntimeSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => runtime.snapshot())
  }

  abortAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop()
  }
}

let defaultRegistry: SessionRuntimeRegistry | null = null

export function getSessionRuntimeRegistry(): SessionRuntimeRegistry {
  if (!defaultRegistry) defaultRegistry = new SessionRuntimeRegistry()
  return defaultRegistry
}

export function setSessionRuntimeRegistry(registry: SessionRuntimeRegistry | null): void {
  defaultRegistry = registry
}

export function resetSessionRuntimeRegistry(): void {
  defaultRegistry?.abortAll()
  defaultRegistry = null
}
