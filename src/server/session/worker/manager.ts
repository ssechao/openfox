/**
 * Gateway-side supervisor for session workers (étape 6a).
 *
 * Launches at most ONE session worker at a time (explicit opt-in setting,
 * off by default). The gateway keeps the interface, the API and the
 * WebSockets; the worker executes the turn and writes its own events through
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
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { Config } from '../../../shared/types.js'
import type { ServerMessage } from '../../../shared/protocol.js'
import { logger } from '../../utils/logger.js'
import { createSessionRunningMessage, createChatMessageMessage } from '../../ws/protocol.js'
import { createMessageDoneEvent } from '../../chat/stream-pure.js'
import { serverT } from '../../i18n.js'
import { getEventStore } from '../../events/index.js'
import { emitRunningChanged } from '../../events/session.js'
import type { SessionManager } from '../manager.js'
import { assignWorkerToken, clearWorkerToken, isWorkerMessageCurrent, type WorkerToken } from './token.js'
import { childrenFilePath, killTrackedChildren, removeChildrenFile } from './children.js'
import { markSessionInterrupted, planWorkerCrashRecovery } from './crash.js'
import type { GatewayToWorkerMessage, WorkerToGatewayMessage } from './protocol.js'

export interface WorkerSettledOutcome {
  crashed: boolean
  error?: string
}

interface ActiveWorker {
  sessionId: string
  token: WorkerToken
  child: ChildProcess
  childrenPath: string
  doneReceived: boolean
  doneOk: boolean
  doneError?: string
  stderrTail: string[]
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
  finalizedMessageId?: string
}

export interface SessionWorkerManagerDeps {
  db: () => Database.Database
  config: Config
  sessionManager: SessionManager
  isEnabled: () => boolean
  broadcastForSession: (sessionId: string, msg: ServerMessage) => void
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
  private active: ActiveWorker | null = null
  private lastCrash: WorkerCrashReport | null = null

  constructor(private readonly deps: SessionWorkerManagerDeps) {}

  /**
   * True when this session's turn should run in a worker. One worker at a
   * time: while a worker runs, other sessions fall back to in-process turns.
   * Interrupted sessions stay in-process (their resume turn runs on the
   * gateway).
   */
  shouldUseWorker(sessionId: string): boolean {
    if (!this.deps.isEnabled()) return false
    if (this.active) return this.active.sessionId === sessionId
    return true
  }

  activeWorker(): { sessionId: string; token: WorkerToken; pid: number | undefined } | null {
    if (!this.active) return null
    return { sessionId: this.active.sessionId, token: this.active.token, pid: this.active.child.pid }
  }

  lastCrashReport(): WorkerCrashReport | null {
    return this.lastCrash
  }

  /** Cooperative stop: ask the worker to abort its turn (Stop button path). */
  requestStop(sessionId: string): boolean {
    if (this.active?.sessionId !== sessionId) return false
    this.sendTo(this.active, { ...this.active.token, type: 'abort' })
    return true
  }

  launch(sessionId: string, onSettled: (outcome: WorkerSettledOutcome) => void): void {
    if (this.active) throw new Error('A session worker is already running')

    const db = this.deps.db()
    const token = assignWorkerToken(db, sessionId)
    const childrenPath = childrenFilePath(db.name, token.workerId)
    const entry = resolveWorkerEntry()

    const child = fork(entry.path, [], {
      execArgv: entry.execArgv,
      env: {
        ...process.env,
        OPENFOX_WORKER_ID: token.workerId,
        OPENFOX_WORKER_GENERATION: String(token.generation),
        OPENFOX_WORKER_DB_PATH: db.name,
        OPENFOX_WORKER_CHILDREN: childrenPath,
      },
      // stdin stays a pipe held open by the gateway: the worker's
      // parent-exit guard uses its closure as the orphan-kill signal.
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: false,
    })

    const worker: ActiveWorker = {
      sessionId,
      token,
      child,
      childrenPath,
      doneReceived: false,
      doneOk: false,
      stderrTail: [],
      onSettled,
    }
    this.active = worker

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (!line.trim()) continue
        worker.stderrTail.push(line)
        if (worker.stderrTail.length > 20) worker.stderrTail.shift()
      }
    })

    child.on('message', (raw) => {
      if (this.active !== worker) return
      const msg = raw as WorkerToGatewayMessage
      if (!isWorkerMessageCurrent(worker.token, msg)) {
        logger.warn('Dropping worker message with stale identity', { sessionId })
        return
      }
      if (msg.type === 'ready') {
        logger.info('Session worker ready', {
          sessionId,
          workerId: token.workerId,
          generation: token.generation,
          pid: msg.pid,
        })
        this.sendTo(worker, { ...token, type: 'start', sessionId, config: this.deps.config })
      } else if (msg.type === 'ws') {
        this.deps.broadcastForSession(sessionId, msg.msg)
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
      if (this.active !== worker) return
      this.active = null
      void this.settle(worker, code, signal)
    })

    logger.info('Session worker launched', { sessionId, workerId: token.workerId, generation: token.generation })
  }

  /** Kill the active worker (gateway shutdown). */
  shutdown(): void {
    const worker = this.active
    if (!worker) return
    this.active = null
    try {
      worker.child.kill('SIGTERM')
    } catch {
      // Already gone
    }
    removeChildrenFile(worker.childrenPath)
    clearWorkerToken(this.deps.db(), worker.sessionId, worker.token)
    worker.onSettled({ crashed: false })
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

  private async settle(worker: ActiveWorker, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const { sessionId, token } = worker
    const db = this.deps.db()
    const clean = worker.doneReceived && worker.doneOk && exitCode === 0 && signal === null

    clearWorkerToken(db, sessionId, token)

    if (clean) {
      removeChildrenFile(worker.childrenPath)
      getEventStore().invalidateExternalSession(sessionId)
      logger.info('Session worker exited cleanly', { sessionId, workerId: token.workerId })
      worker.onSettled({ crashed: false })
      return
    }

    // Crash path — detected right here by the exit handler, no timeout.
    const interruptedAt = new Date().toISOString()
    logger.error('Session worker died', {
      sessionId,
      workerId: token.workerId,
      generation: token.generation,
      exitCode,
      signal,
      doneError: worker.doneError,
      stderr: worker.stderrTail.slice(-5),
    })

    // Reap the worker's exclusive children (recorded synchronously in the
    // sidecar, so kill -9 cannot hide them). Shared MCP/LSP servers belong to
    // the gateway process and are not in that file — never touched.
    const killedChildren = await killTrackedChildren(worker.childrenPath)

    // Persist the interruption marker FIRST so the running-state reset below
    // (and any queued-message drain it could trigger) sees the session as
    // interrupted and never auto-starts a turn behind the resume gate.
    markSessionInterrupted(db, sessionId, interruptedAt)
    try {
      this.deps.sessionManager.setRunning(sessionId, false)
    } catch {
      // Session may have been deleted while the worker ran
    }
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
      killedChildren,
    }
    try {
      const eventStore = getEventStore()
      eventStore.invalidateExternalSession(sessionId)
      const hasActiveWorkflow = this.deps.sessionManager.getActiveWorkflowExecution(sessionId) != null
      const plan = planWorkerCrashRecovery(eventStore.getEvents(sessionId), hasActiveWorkflow)
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
    this.deps.broadcastForSession(sessionId, createSessionRunningMessage(false))
    worker.onSettled({ crashed: true, ...(worker.doneError ? { error: worker.doneError } : {}) })
  }
}
