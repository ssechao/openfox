/**
 * Gateway-side supervisor for session workers.
 *
 * Launches a bounded pool of session workers. The gateway keeps the interface,
 * the API and the WebSockets; each worker executes one session turn and writes
 * its own events through
 * the (workerId, generation) fence.
 *
 * Crash handling: the child `exit` handler is the detection point — no
 * timeout. The gateway then (1) marks the session interrupted in the
 * database (API-visible, « interrompue — reprendre »), (2) finalizes any
 * partial assistant message, (3) appends a system message proposing the
 * explicit resume, and (4) kills the worker's exclusive children recorded in
 * the sidecar file (proof in lastCrashReport). Shared MCP/LSP servers live in
 * the gateway process and are never touched. Nothing is replayed
 * automatically — a tool call with an unknown outcome is never redone
 * blindly; the continuation turn only runs on POST /resume-interruption.
 */

import { fork, type ChildProcess } from 'node:child_process'
import type { SessionProcessSupervisor, SupervisorWorkerHandle } from '../process-supervisor/client.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { Config, ToolResult } from '../../../shared/types.js'
import type { ServerMessage } from '../../../shared/protocol.js'
import { logger } from '../../utils/logger.js'
import {
  createSessionRunningMessage,
  createSessionInterruptedMessage,
  createChatMessageMessage,
} from '../../ws/protocol.js'
import { createMessageDoneEvent } from '../../chat/stream-pure.js'
import { serverT } from '../../i18n.js'
import { getEventStore } from '../../events/index.js'
import { emitRunningChanged } from '../../events/session.js'
import type { SessionManager } from '../manager.js'
import { assignWorkerToken, clearWorkerToken, isWorkerMessageCurrent, type WorkerToken } from './token.js'
import {
  captureExclusiveProcessInventory,
  childrenFilePath,
  initChildrenTracking,
  killTrackedChildren,
  readProcessInventory,
  removeChildrenFile,
  type ExclusiveProcessInventory,
  type OrphanInventoryCheck,
  type ProcessInventoryEntry,
} from './children.js'
import { findPendingToolReconciliations, markSessionInterrupted, planWorkerCrashRecovery } from './crash.js'
import type {
  GatewayToWorkerMessage,
  McpRequestMessage,
  WorkerIpcIdentity,
  WorkerMcpTool,
  WorkerToGatewayMessage,
  WorkerTurnCommand,
} from './protocol.js'
import { WorkerMcpBroker } from './mcp-broker.js'
import { WorkerInteractiveBroker, type InteractiveAnswerResult } from './interactive-broker.js'
import { cancelQuestion, registerPendingQuestion, provideAnswer } from '../../tools/ask.js'
import { cancelPathConfirmation, providePathConfirmation, registerPathConfirmation } from '../../tools/path-security.js'
import type { HealthAggregator } from '../../diagnostics/aggregator.js'
import { MAX_WAITING_SESSIONS, SessionTurnScheduler, resolveWorkerPoolSize, type AdmissionResult } from './scheduler.js'

const WORKER_RECOVERY_TIMEOUT_MS = 4_000
const WORKER_PRE_SIGNAL_CAPTURE_TIMEOUT_MS = 500
const WORKER_ORPHAN_PROOF_DELAY_MS = 2_000
const WORKER_ORPHAN_PROOF_TOLERANCE_MS = 500

export interface WorkerSettledOutcome {
  crashed: boolean
  error?: string
}

interface ActiveWorker {
  sessionId: string
  token: WorkerToken
  child: ChildProcess | SupervisorWorkerHandle
  childrenPath: string
  workerInventory?: ProcessInventoryEntry
  inventory?: ExclusiveProcessInventory
  inventoryPromise?: Promise<ExclusiveProcessInventory>
  orphanCheckPromise?: Promise<OrphanInventoryCheck>
  doneReceived: boolean
  doneOk: boolean
  doneError?: string
  stopRequestedAt?: number
  stopEscalatedAt?: number
  recoveryDeadlineAt?: number
  settledNotified: boolean
  stderrTail: string[]
  command: WorkerTurnCommand
  onSettled: (outcome: WorkerSettledOutcome) => void
}

export interface WorkerCrashReport {
  sessionId: string
  workerId: string
  generation: number
  pid: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  interruptedAt: string
  killedChildren: number[]
  inventory: ExclusiveProcessInventory
  orphanCheck?: OrphanInventoryCheck
  cleanupError?: string
  finalizedMessageId?: string
}

export interface SessionWorkerManagerDeps {
  db: () => Database.Database
  config: Config
  sessionManager: SessionManager
  isEnabled: () => boolean
  broadcastForSession: (sessionId: string, msg: ServerMessage) => void
  cleanupChildren?: (path: string) => Promise<number[]>
  captureInventory?: (workerPid: number, path: string, worker?: ProcessInventoryEntry) => ExclusiveProcessInventory
  verifyInventory?: (inventory: ExclusiveProcessInventory) => Promise<OrphanInventoryCheck>
  shutdownTimeoutMs?: number
  maxProcesses?: number
  processSupervisor?: SessionProcessSupervisor
  healthAggregator?: HealthAggregator
  eventStore?: () => ReturnType<typeof getEventStore>
  getMcpTools?: () => WorkerMcpTool[]
  executeMcp?: (request: McpRequestMessage, signal: AbortSignal) => Promise<ToolResult>
}

function resolveWorkerEntry(): { path: string; execArgv: string[] } {
  const here = dirname(fileURLToPath(import.meta.url))
  const tsEntry = join(here, 'child.ts')
  if (existsSync(tsEntry)) {
    return { path: tsEntry, execArgv: ['--import', 'tsx/esm'] }
  }
  // Bundled layout: this file is inlined into dist/server/index.js and the
  // worker entry is emitted at dist/server/session/worker/child.js.
  const jsEntry = join(here, 'session', 'worker', 'child.js')
  if (existsSync(jsEntry)) {
    return { path: jsEntry, execArgv: [] }
  }
  throw new Error(`Session worker entry not found (looked for ${tsEntry} and ${jsEntry})`)
}

export class SessionWorkerManager {
  private readonly active = new Map<string, ActiveWorker>()
  private readonly exitPromises = new WeakMap<object, Promise<void>>()
  private readonly scheduler: SessionTurnScheduler
  private readonly mcpBroker: WorkerMcpBroker | null
  private readonly interactiveBroker: WorkerInteractiveBroker
  private lastCrash: WorkerCrashReport | null = null
  private admissionsClosed = false

  constructor(private readonly deps: SessionWorkerManagerDeps) {
    this.scheduler = new SessionTurnScheduler({
      maxConcurrent: deps.maxProcesses ?? resolveWorkerPoolSize(process.env['OPENFOX_SESSION_WORKER_MAX_PROCESSES']),
      maxWaitingSessions: MAX_WAITING_SESSIONS,
    })
    this.mcpBroker = deps.executeMcp
      ? new WorkerMcpBroker({
          execute: deps.executeMcp,
          isCurrent: (identity) => this.isCurrentIdentity(identity),
          send: (message) => {
            const worker = this.active.get(message.sessionId)
            if (worker) this.sendTo(worker, message)
          },
          reconcile: (request) => this.appendMcpReconciliation(request),
        })
      : null
    this.interactiveBroker = new WorkerInteractiveBroker({
      isCurrent: (identity) => this.isCurrentIdentity(identity),
      send: (message) => {
        const worker = this.active.get(message.sessionId)
        if (worker) this.sendTo(worker, message)
      },
      registerQuestion: registerPendingQuestion,
      registerPath: registerPathConfirmation,
      answerQuestion: provideAnswer,
      answerPath: (callId, approved, alwaysAllow) => providePathConfirmation(callId, approved, alwaysAllow).found,
      cancelQuestion,
      cancelPath: cancelPathConfirmation,
    })
  }

  isEnabled(): boolean {
    return this.deps.isEnabled()
  }

  shouldUseWorker(_sessionId: string): boolean {
    return !this.admissionsClosed && this.isEnabled()
  }

  requestTurn(sessionId: string, start: () => void): AdmissionResult {
    if (!this.shouldUseWorker(sessionId)) return this.admissionsClosed ? 'closed' : 'full'
    return this.scheduler.admit(sessionId, start)
  }

  canAcceptTurn(sessionId: string): boolean {
    return this.shouldUseWorker(sessionId) && this.scheduler.canAccept(sessionId)
  }

  activeWorker(sessionId?: string): { sessionId: string; token: WorkerToken; pid: number | undefined } | null {
    const worker = sessionId ? this.active.get(sessionId) : this.active.values().next().value
    if (!worker || worker.child.pid === undefined) return null
    return { sessionId: worker.sessionId, token: worker.token, pid: worker.child.pid }
  }

  activeWorkers(): Array<{ sessionId: string; token: WorkerToken; pid: number | undefined }> {
    return [...this.active.values()]
      .filter((worker) => worker.child.pid !== undefined)
      .map((worker) => ({
        sessionId: worker.sessionId,
        token: worker.token,
        pid: worker.child.pid,
      }))
  }

  lastCrashReport(): WorkerCrashReport | null {
    return this.lastCrash
  }

  closeAdmissions(): void {
    this.admissionsClosed = true
    this.scheduler.closeAdmissions()
  }

  requestStop(sessionId: string): boolean {
    const worker = this.active.get(sessionId)
    if (!worker) return this.scheduler.cancel(sessionId) === 'waiting'
    this.mcpBroker?.cancelWorker({ sessionId, ...worker.token })
    this.interactiveBroker.cancelWorker({ sessionId, ...worker.token }, 'Session stopped by user')
    if (worker.stopRequestedAt === undefined) {
      worker.stopRequestedAt = Date.now()
      worker.recoveryDeadlineAt = worker.stopRequestedAt + WORKER_RECOVERY_TIMEOUT_MS
      this.sendTo(worker, { ...worker.token, type: 'abort' })
      void this.beginWorkerInventoryCapture(
        worker,
        worker.stopRequestedAt,
        worker.stopRequestedAt + WORKER_PRE_SIGNAL_CAPTURE_TIMEOUT_MS,
      )
      void this.escalateStop(worker)
    }
    return true
  }

  answerQuestion(callId: string, answer: string, skip: boolean): InteractiveAnswerResult {
    return this.interactiveBroker.answerQuestion(callId, answer, skip)
  }

  answerPath(callId: string, approved: boolean, alwaysAllow: boolean): boolean {
    return this.interactiveBroker.answerPath(callId, approved, alwaysAllow)
  }

  relayResolvedPath(callId: string, approved: boolean, alwaysAllow: boolean): boolean {
    return this.interactiveBroker.relayResolvedPath(callId, approved, alwaysAllow)
  }

  releaseTurn(sessionId: string): boolean {
    return this.scheduler.release(sessionId)
  }

  launch(
    sessionId: string,
    onSettled: (outcome: WorkerSettledOutcome) => void,
    command: WorkerTurnCommand = { kind: 'chat' },
  ): void {
    if (this.admissionsClosed) throw new Error('Session worker admissions are closed during shutdown')
    if (this.active.has(sessionId)) throw new Error('This session already has a worker')

    const db = this.deps.db()
    const token = assignWorkerToken(db, sessionId)
    const childrenPath = childrenFilePath(db.name, token.workerId)
    const entry = resolveWorkerEntry()

    try {
      initChildrenTracking(childrenPath)
    } catch (error) {
      clearWorkerToken(db, sessionId, token)
      throw new Error(`Cannot launch session worker: child sidecar initialization failed at ${childrenPath}`, {
        cause: error,
      })
    }

    const env = {
      ...process.env,
      OPENFOX_WORKER_ID: token.workerId,
      OPENFOX_WORKER_GENERATION: String(token.generation),
      OPENFOX_WORKER_DB_PATH: db.name,
      OPENFOX_WORKER_CHILDREN: childrenPath,
    }
    let child: ChildProcess | SupervisorWorkerHandle
    try {
      child = this.deps.processSupervisor
        ? this.deps.processSupervisor.spawnWorker({
            workerKey: token.workerId,
            path: entry.path,
            execArgv: entry.execArgv,
            env,
          })
        : fork(entry.path, [], {
            execArgv: entry.execArgv,
            env,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            detached: false,
          })
    } catch (error) {
      removeChildrenFile(childrenPath)
      clearWorkerToken(db, sessionId, token)
      throw new Error('Cannot launch session worker: process spawn failed', { cause: error })
    }

    const workerInventoryRead =
      child.pid === undefined ? { status: 'absent' as const } : readProcessInventory(child.pid)
    const worker: ActiveWorker = {
      sessionId,
      token,
      child,
      childrenPath,
      ...(workerInventoryRead.status === 'found' ? { workerInventory: workerInventoryRead.process } : {}),
      doneReceived: false,
      doneOk: false,
      settledNotified: false,
      stderrTail: [],
      command,
      onSettled,
    }
    this.active.set(sessionId, worker)

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (!line.trim()) continue
        worker.stderrTail.push(line)
        if (worker.stderrTail.length > 20) worker.stderrTail.shift()
      }
    })

    child.on('message', (raw) => {
      if (this.active.get(sessionId) !== worker) return
      const msg = raw as WorkerToGatewayMessage
      if (!isWorkerMessageCurrent(worker.token, msg)) {
        logger.warn('Dropping worker message with stale identity', { sessionId })
        return
      }
      if (msg.type === 'ready') {
        if ('inventory' in worker.child && worker.child.inventory) {
          worker.workerInventory = worker.child.inventory
        } else if (!worker.workerInventory) {
          const inventory = readProcessInventory(msg.pid)
          if (inventory.status === 'found') worker.workerInventory = inventory.process
        }
        logger.info('Session worker ready', {
          sessionId,
          workerId: token.workerId,
          generation: token.generation,
          pid: msg.pid,
        })
        this.sendTo(worker, {
          ...token,
          type: 'start',
          sessionId,
          config: this.deps.config,
          mcpTools: this.deps.getMcpTools?.() ?? [],
          command: worker.command,
        })
      } else if (msg.type === 'ws') {
        this.deps.broadcastForSession(sessionId, msg.msg)
      } else if (msg.type === 'health') {
        const pid = worker.child.pid
        this.deps.healthAggregator?.recordSnapshot(token, msg.data, pid === undefined ? undefined : { sessionId, pid })
      } else if (msg.type === 'mcp.request') {
        this.mcpBroker?.handleRequest(msg)
      } else if (msg.type === 'mcp.cancel') {
        this.mcpBroker?.handleCancel(msg)
      } else if (msg.type === 'interactive.question.open' || msg.type === 'interactive.path.open') {
        this.interactiveBroker.handleOpen(msg)
      } else if (msg.type === 'done') {
        worker.doneReceived = true
        worker.doneOk = msg.ok
        if (msg.error) worker.doneError = msg.error
      }
    })

    child.on('error', (error) => {
      logger.error('Session worker spawn error', { sessionId, error: error.message })
    })

    child.on('exit', (code, signal) => {
      if (this.active.get(sessionId) !== worker) return
      this.mcpBroker?.cancelWorker({ sessionId, ...worker.token })
      this.interactiveBroker.cancelWorker({ sessionId, ...worker.token }, 'Session worker exited')
      const capturedAt = worker.stopRequestedAt ?? Date.now()
      worker.recoveryDeadlineAt ??= capturedAt + WORKER_RECOVERY_TIMEOUT_MS
      void this.beginWorkerInventoryCapture(worker, capturedAt, worker.recoveryDeadlineAt)
      void this.settle(worker, code, signal).finally(() => {
        if (this.active.get(sessionId) === worker) this.active.delete(sessionId)
      })
    })

    logger.info('Session worker launched', { sessionId, workerId: token.workerId, generation: token.generation })
  }

  private exitPromise(worker: ActiveWorker): Promise<void> {
    const existing = this.exitPromises.get(worker.child)
    if (existing) return existing
    const promise = new Promise<void>((resolve) => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) resolve()
      else worker.child.once('exit', () => resolve())
    })
    this.exitPromises.set(worker.child, promise)
    return promise
  }

  private async waitForExit(worker: ActiveWorker, timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs)
    })
    const exited = this.exitPromise(worker).then(() => true as const)
    const result = await Promise.race([exited, timedOut])
    if (timeout) clearTimeout(timeout)
    return result
  }

  private notifyWorkerSettled(worker: ActiveWorker, outcome: WorkerSettledOutcome): void {
    if (worker.settledNotified) return
    worker.settledNotified = true
    worker.onSettled(outcome)
  }

  private async waitForExitUntil(worker: ActiveWorker, deadlineAt: number): Promise<boolean> {
    return this.waitForExit(worker, Math.max(0, deadlineAt - Date.now()))
  }

  private async escalateStop(worker: ActiveWorker): Promise<void> {
    const stopRequestedAt = worker.stopRequestedAt ?? Date.now()
    const termAt = stopRequestedAt + WORKER_PRE_SIGNAL_CAPTURE_TIMEOUT_MS
    if (await this.waitForExitUntil(worker, termAt)) return
    await this.beginWorkerInventoryCapture(worker, stopRequestedAt, termAt)
    worker.stopEscalatedAt = Date.now()
    try {
      worker.child.kill('SIGTERM')
    } catch {
      void 0
    }
    const killAt = stopRequestedAt + 1_000
    if (await this.waitForExitUntil(worker, killAt)) return
    try {
      worker.child.kill('SIGKILL')
    } catch {
      void 0
    }
    const stopDeadlineAt = stopRequestedAt + 2_000
    if (!(await this.waitForExitUntil(worker, stopDeadlineAt))) {
      const error = 'Session worker did not exit within the bounded Stop deadline'
      logger.error(error, {
        sessionId: worker.sessionId,
        workerId: worker.token.workerId,
      })
      this.notifyWorkerSettled(worker, { crashed: true, error })
    }
  }

  async shutdown(): Promise<void> {
    this.closeAdmissions()
    const workers = [...this.active.values()]
    const deadlineAt = Date.now() + (this.deps.shutdownTimeoutMs ?? 3_900)
    for (const worker of workers) {
      const interruptedAt = new Date().toISOString()
      markSessionInterrupted(this.deps.db(), worker.sessionId, interruptedAt)
      this.prepareInterruptedEvents(worker.sessionId)
      try {
        this.deps.sessionManager.setRunning(worker.sessionId, false)
        emitRunningChanged(worker.sessionId, false)
      } catch (error) {
        logger.debug('Session disappeared during worker shutdown', {
          sessionId: worker.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      this.mcpBroker?.cancelWorker({ sessionId: worker.sessionId, ...worker.token })
      this.interactiveBroker.cancelWorker(
        { sessionId: worker.sessionId, ...worker.token },
        'Gateway shutdown interrupted the worker turn',
      )
      this.sendTo(worker, { ...worker.token, type: 'abort' })
      const capturedAt = Date.parse(interruptedAt)
      void this.beginWorkerInventoryCapture(
        worker,
        capturedAt,
        Math.min(deadlineAt, capturedAt + WORKER_PRE_SIGNAL_CAPTURE_TIMEOUT_MS),
      )
    }
    this.active.clear()
    const errors = (await Promise.all(workers.map((worker) => this.shutdownWorker(worker, deadlineAt)))).filter(
      (error): error is string => error !== undefined,
    )
    if (errors.length > 0) throw new Error(`Gateway worker shutdown failed: ${errors.join('; ')}`)
  }

  private async shutdownWorker(worker: ActiveWorker, deadlineAt: number): Promise<string | undefined> {
    let cleanupError: string | undefined
    try {
      const remaining = () => Math.max(0, deadlineAt - Date.now())
      let exited = await this.waitForExit(worker, Math.min(1_000, remaining()))
      if (!exited) {
        const capturedAt = Date.now()
        await this.beginWorkerInventoryCapture(
          worker,
          capturedAt,
          Math.min(deadlineAt, capturedAt + WORKER_PRE_SIGNAL_CAPTURE_TIMEOUT_MS),
        )
        try {
          worker.child.kill('SIGTERM')
        } catch {
          void 0
        }
        exited = await this.waitForExit(worker, Math.min(1_000, remaining()))
      }
      if (!exited) {
        try {
          worker.child.kill('SIGKILL')
        } catch {
          void 0
        }
      }

      const cleanupPromise = this.cleanupWorkerChildren(
        worker.sessionId,
        worker.childrenPath,
        deadlineAt,
        'child cleanup exceeded shutdown deadline',
      )
      const remainingMs = remaining()
      const [exitResult, cleanupResult] = await Promise.all([
        exited ? Promise.resolve(true) : this.waitForExit(worker, remainingMs),
        this.waitForCleanup(cleanupPromise, remainingMs),
      ])
      if (!exitResult) cleanupError = 'worker did not exit before the shutdown deadline'
      if (cleanupResult.cleanupError) cleanupError = cleanupResult.cleanupError

      this.notifyWorkerSettled(worker, {
        crashed: true,
        error: cleanupError
          ? `Gateway shutdown interrupted the worker turn; cleanup failed: ${cleanupError}`
          : 'Gateway shutdown interrupted the worker turn',
      })
      return cleanupError
    } finally {
      clearWorkerToken(this.deps.db(), worker.sessionId, worker.token)
      this.deps.healthAggregator?.expireWorker(worker.token)
    }
  }

  private async waitForCleanup(
    cleanup: Promise<{ killedChildren: number[]; cleanupError?: string }>,
    timeoutMs: number,
    timeoutError = 'child cleanup exceeded shutdown deadline',
  ): Promise<{ killedChildren: number[]; cleanupError?: string }> {
    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<{ killedChildren: number[]; cleanupError: string }>((resolve) => {
      timeout = setTimeout(() => resolve({ killedChildren: [], cleanupError: timeoutError }), timeoutMs)
    })
    const result = await Promise.race([cleanup, timedOut])
    if (timeout) clearTimeout(timeout)
    return result
  }

  private async waitUntil<T>(operation: Promise<T>, deadlineAt: number, deadlineError: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(deadlineError)), Math.max(0, deadlineAt - Date.now()))
    })
    try {
      return await Promise.race([operation, timedOut])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private beginWorkerInventoryCapture(
    worker: ActiveWorker,
    capturedAt: number,
    deadlineAt: number,
  ): Promise<ExclusiveProcessInventory> {
    if (worker.inventory) return Promise.resolve(worker.inventory)
    if (worker.inventoryPromise) return worker.inventoryPromise
    const workerPid = worker.child.pid ?? worker.workerInventory?.pid ?? -1
    const capture = Promise.resolve().then(() => {
      if (this.deps.captureInventory) {
        return {
          ...this.deps.captureInventory(workerPid, worker.childrenPath, worker.workerInventory),
          capturedAt,
        }
      }
      if (this.deps.processSupervisor) {
        return this.deps.processSupervisor.captureWorkerInventory(
          workerPid,
          worker.childrenPath,
          worker.workerInventory,
          capturedAt,
          deadlineAt,
        )
      }
      return captureExclusiveProcessInventory(workerPid, worker.childrenPath, {
        ...(worker.workerInventory ? { recordedWorker: worker.workerInventory } : {}),
        now: () => capturedAt,
      })
    })
    worker.inventoryPromise = this.waitUntil(capture, deadlineAt, 'Worker inventory capture exceeded recovery deadline')
      .then((inventory) => {
        worker.inventory = inventory
        return inventory
      })
      .catch((error) => {
        const inventory: ExclusiveProcessInventory = {
          capturedAt,
          ...(worker.workerInventory ? { worker: worker.workerInventory } : {}),
          children: [],
          reservations: [],
          errors: [`inventory capture failed: ${error instanceof Error ? error.message : String(error)}`],
        }
        worker.inventory = inventory
        return inventory
      })
    return worker.inventoryPromise
  }

  private missedOrphanProof(inventory: ExclusiveProcessInventory, error: string): OrphanInventoryCheck {
    return {
      checkedAt: Date.now(),
      clean: false,
      survivingIdentities: [],
      survivingGroups: [],
      liveReservations: [],
      errors: [...inventory.errors, `T+2 zero-orphan proof missed: ${error}`],
    }
  }

  private beginWorkerInventoryVerification(
    worker: ActiveWorker,
    inventory: ExclusiveProcessInventory,
    recoveryDeadlineAt: number,
  ): Promise<OrphanInventoryCheck> {
    if (worker.orphanCheckPromise) return worker.orphanCheckPromise
    const proofAt = inventory.capturedAt + WORKER_ORPHAN_PROOF_DELAY_MS
    if (inventory.errors.length > 0) {
      worker.orphanCheckPromise = new Promise((resolve) => {
        setTimeout(
          () => resolve(this.missedOrphanProof(inventory, 'inventory capture was incomplete')),
          Math.max(0, proofAt - Date.now()),
        )
      })
      return worker.orphanCheckPromise
    }
    const deadlineAt = Math.min(recoveryDeadlineAt, proofAt + WORKER_ORPHAN_PROOF_TOLERANCE_MS)
    const verification = this.deps.verifyInventory
      ? this.deps.verifyInventory(inventory)
      : this.deps.processSupervisor
        ? this.deps.processSupervisor.verifyWorkerInventory(inventory, deadlineAt)
        : Promise.reject(new Error('Session process supervisor unavailable for inventory verification'))
    worker.orphanCheckPromise = this.waitUntil(
      verification,
      deadlineAt,
      'inventory verification missed the T+2 observation window',
    )
      .then((orphanCheck) => {
        if (orphanCheck.checkedAt < proofAt || orphanCheck.checkedAt > deadlineAt) {
          return this.missedOrphanProof(
            inventory,
            `observation timestamp ${orphanCheck.checkedAt} is outside ${proofAt}-${deadlineAt}`,
          )
        }
        return orphanCheck
      })
      .catch((error) => this.missedOrphanProof(inventory, error instanceof Error ? error.message : String(error)))
    return worker.orphanCheckPromise
  }

  private verifyWorkerInventory(report: WorkerCrashReport, verification: Promise<OrphanInventoryCheck>): void {
    void verification.then((orphanCheck) => {
      report.orphanCheck = orphanCheck
      if (!orphanCheck.clean) {
        logger.error('Worker zero-orphan proof failed', {
          sessionId: report.sessionId,
          workerId: report.workerId,
          orphanCheck,
        })
      }
    })
  }

  private async cleanupWorkerChildren(
    sessionId: string,
    childrenPath: string,
    deadlineAt: number,
    deadlineError = 'child cleanup exceeded recovery deadline',
  ): Promise<{ killedChildren: number[]; cleanupError?: string }> {
    const cleanup =
      this.deps.cleanupChildren ??
      (this.deps.processSupervisor
        ? (path: string) => this.deps.processSupervisor!.cleanupWorkerChildren(path, deadlineAt)
        : killTrackedChildren)
    const result = Promise.resolve()
      .then(() => cleanup(childrenPath))
      .then((killedChildren) => ({ killedChildren }))
      .catch((error) => ({
        killedChildren: [],
        cleanupError: error instanceof Error ? error.message : String(error),
      }))
    const bounded = await this.waitForCleanup(result, Math.max(0, deadlineAt - Date.now()), deadlineError)
    if (bounded.cleanupError) {
      logger.error('Worker child cleanup failed; sidecar retained', {
        sessionId,
        childrenPath,
        error: bounded.cleanupError,
      })
    }
    return bounded
  }

  private retire(worker: ActiveWorker): void {
    if (this.active.get(worker.sessionId) === worker) this.active.delete(worker.sessionId)
  }

  private isCurrentIdentity(identity: WorkerIpcIdentity): boolean {
    const worker = this.active.get(identity.sessionId)
    return (
      worker !== undefined &&
      worker.token.workerId === identity.workerId &&
      worker.token.generation === identity.generation
    )
  }

  private appendMcpReconciliation(request: McpRequestMessage): void {
    const eventStore = this.deps.eventStore?.() ?? getEventStore()
    eventStore.append(request.sessionId, {
      type: 'tool.reconciliation_required',
      data: {
        messageId: request.messageId,
        toolCallId: request.toolCallId,
        name: request.name,
        arguments: request.args,
      },
    })
  }

  private sendTo(worker: ActiveWorker, msg: GatewayToWorkerMessage): void {
    try {
      worker.child.send(msg)
    } catch (error) {
      logger.warn('Failed to reach session worker', {
        sessionId: worker.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private prepareInterruptedEvents(sessionId: string) {
    const eventStore = this.deps.eventStore?.() ?? getEventStore()
    eventStore.invalidateExternalSession(sessionId)
    const events = eventStore.getEvents(sessionId)
    for (const pending of findPendingToolReconciliations(events)) {
      eventStore.append(sessionId, { type: 'tool.reconciliation_required', data: pending })
    }
    return { eventStore, events }
  }

  private async settle(worker: ActiveWorker, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const { sessionId, token } = worker
    const db = this.deps.db()
    const clean = worker.doneReceived && worker.doneOk && exitCode === 0 && signal === null
    const recoveryStartedAt = worker.stopRequestedAt ?? Date.now()
    const recoveryDeadlineAt = worker.recoveryDeadlineAt ?? recoveryStartedAt + WORKER_RECOVERY_TIMEOUT_MS

    clearWorkerToken(db, sessionId, token)
    this.deps.healthAggregator?.expireWorker(token)

    if (worker.stopRequestedAt !== undefined && worker.stopEscalatedAt === undefined && clean) {
      const inventory = await this.beginWorkerInventoryCapture(worker, worker.stopRequestedAt, recoveryDeadlineAt)
      const cleanup = await this.cleanupWorkerChildren(sessionId, worker.childrenPath, recoveryDeadlineAt)
      const recoveryErrors = [...inventory.errors, ...(cleanup.cleanupError ? [cleanup.cleanupError] : [])]
      const eventStore = this.deps.eventStore?.() ?? getEventStore()
      eventStore.invalidateExternalSession(sessionId)
      this.retire(worker)
      this.scheduler.release(sessionId)
      this.notifyWorkerSettled(worker, {
        crashed: false,
        ...(recoveryErrors.length > 0
          ? { error: `Session stopped; cleanup proof failed: ${recoveryErrors.join('; ')}` }
          : {}),
      })
      return
    }

    if (clean) {
      removeChildrenFile(worker.childrenPath)
      getEventStore().invalidateExternalSession(sessionId)
      logger.info('Session worker exited cleanly', { sessionId, workerId: token.workerId })
      this.retire(worker)
      this.scheduler.release(sessionId)
      this.notifyWorkerSettled(worker, { crashed: false })
      return
    }

    // Crash path — detected right here by the exit handler, no timeout.
    const interruptedAtMs = recoveryStartedAt
    const interruptedAt = new Date(interruptedAtMs).toISOString()
    logger.error('Session worker died', {
      sessionId,
      workerId: token.workerId,
      generation: token.generation,
      exitCode,
      signal,
      doneError: worker.doneError,
      stderr: worker.stderrTail.slice(-5),
    })

    const inventory = await this.beginWorkerInventoryCapture(worker, interruptedAtMs, recoveryDeadlineAt)
    const verification = this.beginWorkerInventoryVerification(worker, inventory, recoveryDeadlineAt)

    // Reap the worker's exclusive children (recorded synchronously in the
    // sidecar, so kill -9 cannot hide them). Shared MCP/LSP servers belong to
    // the gateway process and are not in that file — never touched.
    const cleanup = await this.cleanupWorkerChildren(sessionId, worker.childrenPath, recoveryDeadlineAt)

    // Persist the interruption marker FIRST so the running-state reset below
    // (and any queued-message drain it could trigger) sees the session as
    // interrupted and never auto-starts a turn behind the resume gate.
    markSessionInterrupted(db, sessionId, interruptedAt)
    try {
      this.deps.sessionManager.setRunning(sessionId, false)
    } catch {
      // Session may have been deleted while the worker ran
    }
    // Sync the UI: the session is now « interrompue — reprendre ». The client
    // shows the resume affordance as soon as it receives this, without a reload.
    this.deps.broadcastForSession(sessionId, createSessionInterruptedMessage(interruptedAt))
    // Keep the event-sourced running state consistent: the worker died before
    // appending its own running.changed(false). Without this the next gateway
    // boot would treat the session as stale-running and the opt-in boot
    // auto-continuation would bypass the explicit-resume gate.
    try {
      emitRunningChanged(sessionId, false)
    } catch {
      // Session may have been deleted while the worker ran
    }

    // Finalize a partial assistant message exactly like a dropped LLM stream,
    // then leave an explicit resume proposal. No automatic continuation: the
    // last tool call's external effects are unknown and must never be
    // replayed blindly.
    const report: WorkerCrashReport = {
      sessionId,
      workerId: token.workerId,
      generation: token.generation,
      pid: worker.child.pid ?? -1,
      exitCode,
      signal,
      interruptedAt,
      killedChildren: cleanup.killedChildren,
      inventory,
      ...(cleanup.cleanupError ? { cleanupError: cleanup.cleanupError } : {}),
    }
    try {
      const { eventStore, events } = this.prepareInterruptedEvents(sessionId)
      const hasActiveWorkflow = this.deps.sessionManager.getActiveWorkflowExecution(sessionId) != null
      const plan = planWorkerCrashRecovery(events, hasActiveWorkflow)
      if (plan?.finalizeMessageId) {
        eventStore.append(sessionId, createMessageDoneEvent(plan.finalizeMessageId, { partial: true }))
        report.finalizedMessageId = plan.finalizeMessageId
      }
      const notice = this.deps.sessionManager.addMessage(sessionId, {
        role: 'user',
        content: serverT({
          en: 'Session interrupted: the worker process died. Nothing was replayed automatically. Resume explicitly when ready (POST /api/sessions/:id/resume-interruption).',
          fr: 'Session interrompue : le processus worker est mort. Rien n’a été rejoué automatiquement. Reprenez explicitement quand vous êtes prêt (POST /api/sessions/:id/resume-interruption).',
        }),
        isSystemGenerated: true,
        messageKind: 'auto-prompt',
      })
      this.deps.broadcastForSession(sessionId, createChatMessageMessage(notice))
    } catch (error) {
      logger.warn('Worker crash finalization failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    this.lastCrash = report
    this.verifyWorkerInventory(report, verification)
    this.deps.broadcastForSession(sessionId, createSessionRunningMessage(false))
    this.retire(worker)
    this.scheduler.release(sessionId)
    const recoveryErrors = [...inventory.errors, ...(cleanup.cleanupError ? [cleanup.cleanupError] : [])]
    this.notifyWorkerSettled(worker, {
      crashed: true,
      ...(worker.doneError || recoveryErrors.length > 0
        ? { error: worker.doneError ?? `Worker interruption recovery failed: ${recoveryErrors.join('; ')}` }
        : {}),
    })
  }
}
