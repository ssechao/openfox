/**
 * Project Tasks Service
 *
 * Domain logic for the project-scoped task board. Owns the state machine
 * (To Do → In Progress {running|queued} → Done, with reverts), gate checks,
 * slot allocation / FIFO auto-launch, session seeding, and system reminders.
 *
 * Transitions are enforced here — never by clients. All mutations run inside
 * a per-project lock so concurrent actors (two agents, or an agent and the
 * human) serialize instead of corrupting state. Callers may pass
 * `expectedUpdatedAt` for optimistic concurrency: if the task changed since
 * their view, the operation fails with a structured CONFLICT error.
 *
 * Dependencies (session manager, config, broadcast) are injected so the
 * service stays testable and free of singletons.
 */

import type {
  Config,
  ProjectTask,
  ProjectTaskCounts,
  ProjectTaskSettings,
  TaskStatus,
  TaskQueuedInfo,
  Session,
} from '../../shared/types.js'
import type { SessionManager } from '../session/manager.js'
import type { TasksUpdatePayload } from '../../shared/protocol.js'
import type { Attachment, WorkflowLaunchScope } from '../../shared/types.js'
import { parseDefaultModelSelection } from '../provider-manager.js'
import type { AdmissionResult } from '../session/worker/scheduler.js'
import { logger } from '../utils/logger.js'

export class WorkerAdmissionRefusal extends Error {
  readonly code = 'WORKER_ADMISSION_REFUSED'
  constructor(
    readonly admission: Exclude<AdmissionResult, 'started' | 'waiting'>,
    readonly sessionId: string,
    readonly freshSession = false,
  ) {
    super(`Session worker admission ${admission}`)
    this.name = 'WorkerAdmissionRefusal'
  }
}

export function isWorkerAdmissionRefusal(error: unknown): error is WorkerAdmissionRefusal {
  return error instanceof WorkerAdmissionRefusal
}

function refusedAdmission(
  admission: AdmissionResult | void,
): admission is Exclude<AdmissionResult, 'started' | 'waiting'> {
  return admission === 'full' || admission === 'closed' || admission === 'start_failed'
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
}

function runBusy<T>(operation: () => T, budgetMs = 200): T | Promise<T> {
  const deadline = Date.now() + budgetMs
  let delay = 5
  const attempt = (): T | Promise<T> => {
    try {
      return operation()
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error
      const wait = delay
      delay = Math.min(delay * 2, 40)
      return new Promise((resolve) => setTimeout(resolve, wait)).then(attempt)
    }
  }
  return attempt()
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}
import { getProject, listProjects } from '../db/projects.js'
import { resolveSlashLaunch, type SlashLaunch } from './slash.js'
import {
  createTask as dbCreateTask,
  updateTask as dbUpdateTask,
  getTask as dbGetTask,
  listTasks as dbListTasks,
  deleteTask as dbDeleteTask,
  cloneTask as dbCloneTask,
  reorderTask as dbReorderTask,
  setTaskStatus as dbSetTaskStatus,
  setTaskRunState as dbSetTaskRunState,
  addTaskLink as dbAddTaskLink,
  listTaskLinks as dbListTaskLinks,
  removeTaskLinks as dbRemoveTaskLinks,
  clearActiveTaskLink as dbClearActiveTaskLink,
  appendToBottom as dbAppendToBottom,
  getGateConfig as dbGetGateConfig,
  replaceGateConfig as dbReplaceGateConfig,
  setGateValue as dbSetGateValue,
  addAuditEntry as dbAddAuditEntry,
  getTaskSettings as dbGetTaskSettings,
  setTaskSettings as dbSetTaskSettings,
  listDueScheduledTasks as dbListDueScheduledTasks,
  setTaskSchedule as dbSetTaskSchedule,
  clearTaskSchedule as dbClearTaskSchedule,
} from '../db/tasks.js'
import type { TaskGateConfig, TaskActor, TaskSchedule } from '../../shared/types.js'
import { serverT } from '../i18n.js'
import { nextOccurrence } from './recurrence.js'

export type TaskDestination = 'todo' | 'in_progress' | 'done'

export interface TaskActorInfo {
  actor: TaskActor
  actorName?: string
}

export interface MoveOptions extends TaskActorInfo {
  /** For agent moves: bind to this session (current-session rule). */
  sessionId?: string
  /** Optional short reason recorded in the audit trail (e.g. revert rationale). */
  reason?: string
  /** Optimistic concurrency guard: fail with CONFLICT if the task version differs. */
  expectedVersion?: number
}

export interface TaskConflictError extends Error {
  code: 'CONFLICT'
  task: ProjectTask
}

export interface TaskGateError extends Error {
  code: 'GATE_BLOCKED'
  missing: { gateId: string; name: string; description: string }[]
  task: ProjectTask
}

export function isTaskConflictError(err: unknown): err is TaskConflictError {
  return err instanceof Error && (err as { code?: string }).code === 'CONFLICT'
}

export function isTaskGateError(err: unknown): err is TaskGateError {
  return err instanceof Error && (err as { code?: string }).code === 'GATE_BLOCKED'
}

export interface TasksService {
  snapshot(projectId: string): { tasks: ProjectTask[]; settings: ProjectTaskSettings; counts: ProjectTaskCounts }
  list(projectId: string): ProjectTask[]
  get(projectId: string, taskId: string): ProjectTask | null
  create(projectId: string, input: CreateTaskServiceInput, actor: TaskActorInfo): ProjectTask
  update(
    projectId: string,
    taskId: string,
    patch: UpdateTaskServiceInput,
    actor: TaskActorInfo,
    expectedVersion?: number,
  ): Promise<{ task: ProjectTask; conflict: boolean }>
  duplicate(projectId: string, taskId: string, actor: TaskActorInfo): ProjectTask
  remove(projectId: string, taskId: string, actor: TaskActorInfo): Promise<void>
  move(
    projectId: string,
    taskId: string,
    to: TaskDestination,
    opts: MoveOptions,
  ): Promise<{
    task: ProjectTask
    sessionId?: string
    queued?: TaskQueuedInfo
    autoLaunched?: { taskId: string; taskTitle: string; sessionId: string; projectId: string }
  }>
  reconcileSessionDeleted(projectId: string, sessionId: string): Promise<void>
  setGateValue(
    projectId: string,
    taskId: string,
    gateId: string,
    value: string,
    actor: TaskActorInfo,
    sessionId?: string,
    expectedVersion?: number,
  ): Promise<{ task: ProjectTask; conflict: boolean }>
  setGateConfig(projectId: string, gates: TaskGateConfig[], actor: TaskActorInfo): TaskGateConfig[]
  setSettings(projectId: string, settings: Partial<ProjectTaskSettings>): Promise<ProjectTaskSettings>
  reorder(projectId: string, taskId: string, status: TaskDestination, toIndex: number): ProjectTask
  counts(projectId: string): ProjectTaskCounts
  /** Trigger every due scheduled task (boot catch-up + periodic tick). */
  runScheduled(now?: Date): Promise<void>
  /** Launch the next queued task in each project once a worker slot is free. */
  retryQueuedLaunches(): Promise<void>
  pendingFreshSessionDeletes(): number
}

export interface CreateTaskServiceInput {
  prompt: string
  attachments?: Attachment[]
  agentId?: string
  providerId?: string
  model?: string
  schedule?: TaskSchedule
}

export interface UpdateTaskServiceInput {
  prompt?: string
  attachments?: Attachment[]
  agentId?: string | null
  providerId?: string | null
  model?: string | null
  /** `undefined` = leave unchanged, `null` = clear, otherwise replace (counter resets). */
  schedule?: TaskSchedule | null
}

export interface TasksServiceDeps {
  sessionManager: SessionManager
  config: Config
  broadcast: (projectId: string, payload: TasksUpdatePayload) => void
  /** Global config dir — slash commands/workflows are resolved from here (plus the project dir). */
  configDir: string
  /** Starts a workflow run in a seeded session (wired to the runner in server/index.ts). */
  launchWorkflow?: (
    sessionId: string,
    launch: {
      workflowId: string
      params?: Record<string, string>
      scope?: WorkflowLaunchScope
      attachments?: Attachment[]
    },
  ) => AdmissionResult | void | Promise<AdmissionResult | void>
  canStartSession?: (sessionId: string) => boolean
}

const REMINDER_COLOR = '#3b82f6'

// ============================================================================
// Locking (per-project serialization)
// ============================================================================

const locks = new Map<string, Promise<unknown>>()

function withLock<T>(projectId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(projectId) ?? Promise.resolve()
  const next = prev.then(() => fn())
  locks.set(
    projectId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

// ============================================================================
// Service factory
// ============================================================================

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const { sessionManager, config, broadcast, configDir, launchWorkflow, canStartSession } = deps

  function snapshot(projectId: string) {
    const tasks = dbListTasks(projectId)
    const settings = dbGetTaskSettings(projectId)
    const counts = computeCounts(tasks)
    const gates = dbGetGateConfig(projectId)
    return { tasks, settings, counts, gates }
  }

  function publish(projectId: string, changedTaskId?: string, autoLaunched?: TasksUpdatePayload['autoLaunched']) {
    const { tasks, settings, counts, gates } = snapshot(projectId)
    broadcast(projectId, {
      projectId,
      tasks,
      settings,
      counts,
      gates,
      ...(changedTaskId ? { changedTaskId } : {}),
      ...(autoLaunched ? { autoLaunched } : {}),
    })
  }

  /**
   * A target session is reusable only when it belongs to this project AND is
   * still fresh (no messages) — reusing a session mid-conversation would
   * inject task content into unrelated context. An interrupted session is
   * never reused either: it must go through the explicit resume (POST /resume-interruption).
   */
  function reusableTarget(projectId: string, sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined
    const session = sessionManager.getSession(sessionId)
    if (!session || session.projectId !== projectId || session.messages.length > 0 || session.interruptedAt)
      return undefined
    return sessionId
  }

  function list(projectId: string) {
    return dbListTasks(projectId)
  }

  function get(projectId: string, taskId: string) {
    const task = dbGetTask(taskId)
    return task && task.projectId === projectId ? task : null
  }

  function assertOwned(projectId: string, taskId: string): ProjectTask {
    const task = dbGetTask(taskId)
    if (!task || task.projectId !== projectId) {
      throw new Error(serverT({ en: 'Task not found: {{id}}', fr: 'Tâche introuvable : {{id}}' }, { id: taskId }))
    }
    return task
  }

  function assertNotStale(task: ProjectTask, expectedVersion?: number): void {
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      const err = new Error(
        serverT({ en: 'Task changed, refresh and retry', fr: 'Tâche modifiée, actualisez et réessayez' }),
      ) as TaskConflictError
      err.code = 'CONFLICT'
      err.task = task
      throw err
    }
  }

  function create(projectId: string, input: CreateTaskServiceInput, actor: TaskActorInfo) {
    const hasContent = input.prompt.trim().length > 0
    const hasAttachments = (input.attachments?.length ?? 0) > 0
    if (!hasContent && !hasAttachments) {
      throw new Error(
        serverT({
          en: 'Task requires at least a prompt or an attachment',
          fr: 'La tâche requiert au moins un prompt ou une pièce jointe',
        }),
      )
    }
    const task = dbCreateTask(projectId, {
      prompt: input.prompt,
      attachments: input.attachments ?? [],
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.schedule ? { schedule: normalizeSchedule(input.schedule) } : {}),
    })
    dbAddAuditEntry(task.id, actor.actor, 'create', `Task created in To Do`, actor.actorName)
    const fresh = dbGetTask(task.id)!
    publish(projectId, fresh.id)
    return fresh
  }

  function update(
    projectId: string,
    taskId: string,
    patch: UpdateTaskServiceInput,
    actor: TaskActorInfo,
    expectedVersion?: number,
  ) {
    return withLock(projectId, () => {
      const task = assertOwned(projectId, taskId)
      assertNotStale(task, expectedVersion)

      const next =
        dbUpdateTask(taskId, {
          ...patch,
          ...(patch.schedule !== undefined
            ? { schedule: patch.schedule === null ? null : normalizeSchedule(patch.schedule) }
            : {}),
        }) ?? dbGetTask(taskId)!
      const changed = summarizeChanges(task, next)
      dbAddAuditEntry(taskId, actor.actor, 'edit', changed || 'Task updated', actor.actorName)
      const fresh = dbGetTask(taskId)!
      publish(projectId, fresh.id)
      return { task: fresh, conflict: false }
    })
  }

  function duplicate(projectId: string, taskId: string, actor: TaskActorInfo) {
    const source = assertOwned(projectId, taskId)
    const copy = dbCloneTask(taskId)
    if (!copy)
      throw new Error(serverT({ en: 'Task not found: {{id}}', fr: 'Tâche introuvable : {{id}}' }, { id: taskId }))
    dbAddAuditEntry(
      copy.id,
      actor.actor,
      'duplicate',
      `Duplicated from "${promptLabel(source.prompt)}"`,
      actor.actorName,
    )
    const fresh = dbGetTask(copy.id)!
    publish(projectId, fresh.id)
    return fresh
  }

  function remove(projectId: string, taskId: string, actor: TaskActorInfo) {
    return withLock(projectId, async () => {
      const task = assertOwned(projectId, taskId)
      const freedSlot = task.status === 'in_progress' && task.runState === 'running'
      dbAddAuditEntry(taskId, actor.actor, 'delete', `Task deleted`, actor.actorName)
      dbDeleteTask(taskId)
      publish(projectId)
      // Deleting a running task frees its slot — let the next queued task launch.
      const autoLaunched = freedSlot ? await maybeAutoLaunch(projectId) : undefined
      if (autoLaunched) publish(projectId, undefined, autoLaunched)
    })
  }

  function move(projectId: string, taskId: string, to: TaskDestination, opts: MoveOptions) {
    // Locked here so the scheduler can reuse moveLocked inside its own lock
    // without deadlocking on a nested withLock.
    return withLock(projectId, () => moveLocked(projectId, taskId, to, opts))
  }

  async function moveLocked(projectId: string, taskId: string, to: TaskDestination, opts: MoveOptions) {
    const task = assertOwned(projectId, taskId)
    assertNotStale(task, opts.expectedVersion)

    const from = task.status
    if (from === to) {
      // No-op transition (e.g. already done) — still return the task.
      return { task }
    }

    let sessionId: string | undefined
    let queued: TaskQueuedInfo | undefined
    const wasRunning = task.status === 'in_progress' && task.runState === 'running'

    if (to === 'in_progress') {
      const readyGates = requiredGates(projectId, 'ready')
      const missing = missingGateFields(task, readyGates)
      if (missing.length > 0) {
        throw gateBlockedError(task, 'In Progress', missing)
      }

      const settings = dbGetTaskSettings(projectId)
      const active = activeCount(projectId)
      const humanEligible = opts.actor !== 'agent' && active < settings.slotLimit && !settings.queuePaused
      const admissionSessionId = humanEligible
        ? (reusableTarget(projectId, opts.sessionId) ?? `task:${task.id}`)
        : undefined
      const poolBlocked = Boolean(admissionSessionId && canStartSession && !canStartSession(admissionSessionId))
      const humanLaunch = humanEligible && !poolBlocked
      if (opts.actor === 'agent') {
        if (!opts.sessionId) {
          throw new Error(
            serverT({
              en: 'Agent moves must bind to the current session (sessionId is required)',
              fr: 'Les déplacements d’agent doivent être liés à la session courante (sessionId requis)',
            }),
          )
        }
        // Current-session rule: the agent is working in its own session NOW.
        dbSetTaskStatus(taskId, 'in_progress')
        dbSetTaskRunState(taskId, 'running')
        dbAddTaskLink(taskId, opts.sessionId, true)
        dbAddAuditEntry(taskId, 'agent', 'move', `Moved to In Progress (running)`, opts.actorName)
        emitReminder(opts.sessionId, reminderForInProgress(task, opts.sessionId, from))
        sessionId = opts.sessionId
      } else if (humanLaunch) {
        // Admit the worker before any status, schedule, mode, or reminder write.
        try {
          const seeded = await seedSession(projectId, task, from, reusableTarget(projectId, opts.sessionId))
          dbSetTaskStatus(taskId, 'in_progress')
          dbSetTaskRunState(taskId, 'running')
          if (task.schedule) dbClearTaskSchedule(taskId)
          dbAddTaskLink(taskId, seeded.session.id, true)
          dbAddAuditEntry(taskId, opts.actor, 'move', `Moved to In Progress (running)`, opts.actorName)
          sessionId = seeded.session.id
        } catch (error) {
          if (!isWorkerAdmissionRefusal(error)) throw error
          if (error.admission !== 'start_failed') {
            dbSetTaskStatus(taskId, 'in_progress')
            dbSetTaskRunState(taskId, 'queued')
            dbAppendToBottom(taskId, 'in_progress')
            if (task.schedule) dbClearTaskSchedule(taskId)
            if (!error.freshSession) dbAddTaskLink(taskId, error.sessionId, false)
            dbAddAuditEntry(
              taskId,
              opts.actor,
              'move',
              'Moved to In Progress (queued): waiting for a worker',
              opts.actorName,
            )
            queued = {
              reason: 'admission_refused',
              active,
              slotLimit: settings.slotLimit,
              position: dbGetTask(taskId)?.queuePosition ?? 1,
            }
          } else {
            throw error
          }
        }
      } else {
        // Queued: append at the bottom of In Progress so FIFO order (oldest
        // first) matches the visible stacking and the per-task queue rank.
        dbSetTaskStatus(taskId, 'in_progress')
        dbSetTaskRunState(taskId, 'queued')
        if (task.schedule) dbClearTaskSchedule(taskId)
        dbAppendToBottom(taskId, 'in_progress')
        const earmarked = reusableTarget(projectId, opts.sessionId)
        if (earmarked && !poolBlocked) dbAddTaskLink(taskId, earmarked, false)
        dbAddAuditEntry(
          taskId,
          opts.actor,
          'move',
          poolBlocked ? 'Moved to In Progress (queued): waiting for a worker' : 'Moved to In Progress (queued)',
          opts.actorName,
        )
        queued = {
          reason: poolBlocked ? 'admission_refused' : settings.queuePaused ? 'queue_paused' : 'slot_limit',
          active,
          slotLimit: settings.slotLimit,
          position: dbGetTask(taskId)?.queuePosition ?? 1,
        }
      }
    } else if (to === 'done') {
      const doneGates = requiredGates(projectId, 'done')
      const missing = missingGateFields(task, doneGates)
      if (missing.length > 0) {
        throw gateBlockedError(task, 'Done', missing)
      }
      dbSetTaskStatus(taskId, 'done')
      dbClearActiveTaskLink(taskId)
      if (task.schedule) dbClearTaskSchedule(taskId)
      dbAddAuditEntry(taskId, opts.actor, 'move', `Moved to Done`, opts.actorName)
      if (task.activeSessionId) {
        emitReminder(task.activeSessionId, reminderForDone(task))
      }
    } else {
      // → todo (revert / unbind) from in_progress or done
      dbSetTaskStatus(taskId, 'todo')
      dbRemoveTaskLinks(taskId)
      const detailParts = [`Moved back to To Do`]
      if (opts.reason) detailParts.push(`Reason: ${opts.reason}`)
      dbAddAuditEntry(taskId, opts.actor, 'move', detailParts.join('. '), opts.actorName)
      if (task.activeSessionId) {
        emitReminder(task.activeSessionId, reminderForTodo(task))
      }
    }

    const fresh = dbGetTask(taskId)!
    let autoLaunched: TasksUpdatePayload['autoLaunched'] | undefined
    if (wasRunning || (to === 'todo' && from === 'in_progress')) {
      autoLaunched = await maybeAutoLaunch(projectId)
    }
    publish(projectId, fresh.id, autoLaunched)
    return {
      task: fresh,
      ...(sessionId ? { sessionId } : {}),
      ...(queued ? { queued } : {}),
      ...(autoLaunched ? { autoLaunched } : {}),
    }
  }

  function reconcileSessionDeleted(projectId: string, sessionId: string) {
    return withLock(projectId, async () => {
      const { changed, freedSlot } = reconcileSessions(projectId, sessionId)
      const autoLaunched = freedSlot ? await maybeAutoLaunch(projectId) : undefined
      if (changed || autoLaunched) publish(projectId, undefined, autoLaunched)
    })
  }

  /**
   * Trigger every due scheduled task. Runs once at boot (catch-up) and then on
   * the scheduler tick. One-off tasks launch themselves; recurring templates
   * spawn a schedule-free run and advance to the next occurrence (single
   * catch-up — several missed intervals collapse into one run).
   */
  async function retryQueuedLaunches() {
    for (const project of listProjects()) {
      try {
        await withLock(project.id, async () => {
          const autoLaunched = await maybeAutoLaunch(project.id)
          if (autoLaunched) publish(project.id, undefined, autoLaunched)
        })
      } catch (error) {
        logger.warn('Queued task retry failed', {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async function runScheduled(now = new Date()) {
    const due = dbListDueScheduledTasks(now.toISOString())
    for (const task of due) {
      try {
        await withLock(task.projectId, async () => {
          const fresh = dbGetTask(task.id)
          if (!fresh || fresh.status !== 'todo' || !fresh.schedule) return
          const schedule = fresh.schedule

          if (schedule.type === 'once') {
            // The task itself runs; moveLocked clears the schedule for it.
            await moveLocked(fresh.projectId, fresh.id, 'in_progress', { actor: 'system' })
            return
          }

          // Recurring: spawn one run (a plain clone), then advance the template.
          // Skip when ready gates would block the run — a clone carries no gate
          // values, so spawning would fail and orphan a duplicate every tick.
          const readyGates = requiredGates(fresh.projectId, 'ready')
          if (missingGateFields(fresh, readyGates).length > 0) {
            logger.warn('Scheduled recurring spawn skipped: missing ready gates', {
              taskId: fresh.id,
              gates: readyGates.map((g) => g.name).join(', '),
            })
            return
          }
          const run = dbCloneTask(fresh.id, false)
          if (run) {
            try {
              await moveLocked(run.projectId, run.id, 'in_progress', { actor: 'system' })
            } catch (error) {
              // Never leave an orphaned clone behind when the launch fails.
              dbDeleteTask(run.id)
              throw error
            }
            dbAddAuditEntry(
              run.id,
              'system',
              'scheduled_run',
              `Spawned from recurring task "${promptLabel(fresh.prompt)}"`,
              'system',
            )
          }
          const rule = {
            freq: schedule.freq,
            interval: schedule.interval,
            ...(schedule.weekdays ? { weekdays: schedule.weekdays } : {}),
            ...(schedule.monthDay ? { monthDay: schedule.monthDay } : {}),
            ...(schedule.yearMonth ? { yearMonth: schedule.yearMonth } : {}),
            startAt: schedule.startAt,
            end: schedule.end,
            occurrencesDone: schedule.occurrencesDone + 1,
          }
          const next = nextOccurrence(now, rule)
          if (next) {
            const advanced: TaskSchedule = {
              ...schedule,
              occurrencesDone: schedule.occurrencesDone + 1,
              nextRunAt: next.toISOString(),
            }
            dbSetTaskSchedule(fresh.id, advanced, next.toISOString())
            dbAddAuditEntry(
              fresh.id,
              'system',
              'scheduled_run',
              `Triggered occurrence ${schedule.occurrencesDone + 1}, next run ${next.toISOString()}`,
              'system',
            )
          } else {
            // Recurrence ended (count reached or past until) — the template
            // becomes a plain To Do task, nothing is auto-deleted.
            dbClearTaskSchedule(fresh.id)
            dbAddAuditEntry(fresh.id, 'system', 'schedule_ended', 'Recurrence ended — schedule cleared', 'system')
          }
          publish(fresh.projectId, fresh.id)
        })
      } catch (error) {
        // A blocked trigger (e.g. unfilled ready gates) must not abort the
        // whole tick — the task stays due and retries on the next one.
        logger.warn('Scheduled task trigger failed', { taskId: task.id, error: String(error) })
      }
    }
  }

  function setGateValue(
    projectId: string,
    taskId: string,
    gateId: string,
    value: string,
    actor: TaskActorInfo,
    sessionId?: string,
    expectedVersion?: number,
  ) {
    return withLock(projectId, () => {
      const task = assertOwned(projectId, taskId)
      assertNotStale(task, expectedVersion)
      const gates = dbGetGateConfig(projectId)
      const gate = gates.find((g) => g.id === gateId)
      if (!gate) {
        throw new Error(serverT({ en: 'Unknown gate: {{id}}', fr: 'Porte inconnue : {{id}}' }, { id: gateId }))
      }
      dbSetGateValue(taskId, gateId, value, actor.actor, actor.actorName, sessionId)
      dbAddAuditEntry(taskId, actor.actor, 'gate_value', `Set gate "${gate.name}" = "${value}"`, actor.actorName)
      const fresh = dbGetTask(taskId)!
      publish(projectId, fresh.id)
      return { task: fresh, conflict: false }
    })
  }

  function setGateConfig(projectId: string, gates: TaskGateConfig[], actor: TaskActorInfo) {
    const normalized = gates.map((g) => ({
      ...g,
      name: g.name.trim(),
      description: g.description.trim(),
    }))
    dbReplaceGateConfig(projectId, normalized)
    void actor
    publish(projectId)
    return dbGetGateConfig(projectId)
  }

  async function setSettings(projectId: string, settings: Partial<ProjectTaskSettings>) {
    const saved = dbSetTaskSettings(projectId, settings)
    publish(projectId)
    // Changing the limit upward (or unpausing) may free room for queued tasks.
    const autoLaunched = await maybeAutoLaunch(projectId)
    if (autoLaunched) publish(projectId, undefined, autoLaunched)
    return saved
  }

  function reorder(projectId: string, taskId: string, status: TaskDestination, toIndex: number) {
    const task = assertOwned(projectId, taskId)
    if (task.status !== status) {
      throw new Error(
        serverT(
          {
            en: 'Cannot reorder task: status mismatch ({{current}} != {{target}})',
            fr: 'Impossible de réordonner la tâche : statut incohérent ({{current}} != {{target}})',
          },
          { current: task.status, target: status },
        ),
      )
    }
    dbReorderTask(taskId, status, toIndex)
    const fresh = dbGetTask(taskId)!
    publish(projectId, fresh.id)
    return fresh
  }

  function counts(projectId: string) {
    return computeCounts(dbListTasks(projectId))
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  function computeCounts(tasks: ProjectTask[]): ProjectTaskCounts {
    const todo = tasks.filter((t) => t.status === 'todo').length
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length
    const running = tasks.filter((t) => t.status === 'in_progress' && t.runState === 'running').length
    const queued = tasks.filter((t) => t.status === 'in_progress' && t.runState === 'queued').length
    const done = tasks.filter((t) => t.status === 'done').length
    return { open: todo + inProgress, todo, inProgress, running, queued, done }
  }

  function requiredGates(projectId: string, variant: 'done' | 'ready'): TaskGateConfig[] {
    return dbGetGateConfig(projectId).filter((g) => g.variant === variant && g.required)
  }

  function missingGateFields(task: ProjectTask, gates: TaskGateConfig[]) {
    const filled = new Set(task.gateValues.filter((v) => v.value.trim().length > 0).map((v) => v.gateId))
    return gates
      .filter((g) => !filled.has(g.id))
      .map((g) => ({ gateId: g.id, name: g.name, description: g.description }))
  }

  function gateBlockedError(
    task: ProjectTask,
    destination: 'In Progress' | 'Done',
    missing: { gateId: string; name: string; description: string }[],
  ) {
    const err = new Error(
      serverT(
        {
          en: 'Cannot move to {{destination}}: missing required gate fields: {{missing}}',
          fr: 'Impossible de déplacer vers {{destination}} : champs de porte requis manquants : {{missing}}',
        },
        { destination, missing: missing.map((m) => m.name).join(', ') },
      ),
    ) as TaskGateError
    err.code = 'GATE_BLOCKED'
    err.missing = missing
    err.task = task
    return err
  }

  function reconcileSessions(projectId: string, deletedSessionId?: string) {
    let changed = false
    let freedSlot = false

    for (const task of dbListTasks(projectId)) {
      if (deletedSessionId) {
        if (!task.sessionIds.includes(deletedSessionId)) continue
        dbRemoveTaskLinks(task.id, deletedSessionId)
        changed = true
        if (task.status !== 'in_progress' || task.runState !== 'running' || task.activeSessionId !== deletedSessionId) {
          continue
        }
      } else {
        if (task.status !== 'in_progress' || task.runState !== 'running') continue
        if (task.activeSessionId && sessionManager.getSession(task.activeSessionId)) continue
        if (!task.activeSessionId) {
          dbSetTaskRunState(task.id, 'queued')
          changed = true
          freedSlot = true
          continue
        }
        dbRemoveTaskLinks(task.id, task.activeSessionId)
        changed = true
      }

      dbSetTaskRunState(task.id, 'idle')
      dbAddAuditEntry(task.id, 'system', 'session_deleted', 'Task set idle: active session deleted', 'system')
      freedSlot = true
    }

    return { changed, freedSlot }
  }

  function activeCount(projectId: string): number {
    reconcileSessions(projectId)
    return dbListTasks(projectId).filter((t) => t.status === 'in_progress' && t.runState === 'running').length
  }

  const FRESH_DELETE_BUDGET_MS = 2000
  const MAX_FRESH_DELETE_BACKLOG = 8
  const freshDeleteSlots: Array<{ id?: string; pending: boolean }> = []

  function reserveFreshDelete(): { id?: string; pending: boolean } | undefined {
    if (freshDeleteSlots.length >= MAX_FRESH_DELETE_BACKLOG) return undefined
    const slot: { id?: string; pending: boolean } = { pending: false }
    freshDeleteSlots.push(slot)
    return slot
  }

  function releaseFreshDelete(slot: { id?: string; pending: boolean }): void {
    const index = freshDeleteSlots.indexOf(slot)
    if (index >= 0) freshDeleteSlots.splice(index, 1)
  }

  function freshDeleteSlot(sessionId: string): { id?: string; pending: boolean } | undefined {
    return freshDeleteSlots.find((slot) => slot.id === sessionId)
  }

  function compensateFreshSessions(): void | Promise<void> {
    if (!freshDeleteSlots.some((slot) => slot.pending)) return
    return drainFreshDeletes()
  }

  async function drainFreshDeletes(): Promise<void> {
    for (const slot of [...freshDeleteSlots]) {
      const sessionId = slot.id
      if (!slot.pending || !sessionId) continue
      try {
        const deleted = runBusy(() => {
          if (!sessionManager.getSession(sessionId)) return
          sessionManager.deleteSession(sessionId)
        }, FRESH_DELETE_BUDGET_MS)
        if (isThenable(deleted)) await deleted
        releaseFreshDelete(slot)
      } catch (error) {
        if (!isSqliteBusy(error)) releaseFreshDelete(slot)
      }
    }
  }

  async function deleteFreshSession(sessionId: string): Promise<void> {
    const slot = freshDeleteSlot(sessionId)
    if (slot) slot.pending = true
    try {
      const deleted = runBusy(() => sessionManager.deleteSession(sessionId), FRESH_DELETE_BUDGET_MS)
      if (isThenable(deleted)) await deleted
      if (slot) releaseFreshDelete(slot)
    } catch (error) {
      if (!isSqliteBusy(error) && slot) releaseFreshDelete(slot)
      throw error
    }
  }

  function keepFreshSession(sessionId: string): void {
    const slot = freshDeleteSlot(sessionId)
    if (slot && !slot.pending) releaseFreshDelete(slot)
  }

  function pendingFreshSessionDeletes(): number {
    return freshDeleteSlots.filter((slot) => slot.pending).length
  }

  /**
   * Seed a session for a claimed task: reminder first (opening context), then
   * the task's work — the plain prompt queued, a slash command expanded into
   * its command prompt, or a slash workflow launched directly. When a target
   * session is supplied it is reused (bind-in-place, no orphan session);
   * otherwise a brand-new session is created.
   */
  async function seedSession(
    projectId: string,
    task: ProjectTask,
    from: TaskStatus | 'queued',
    targetSessionId?: string,
  ) {
    const pendingDeletes = compensateFreshSessions()
    if (isThenable(pendingDeletes)) await pendingDeletes
    let session: Session
    let created = false
    if (targetSessionId) {
      const existing = sessionManager.getSession(targetSessionId)
      if (!existing) {
        // Target vanished concurrently — fall back to seeding a fresh one.
        return seedSession(projectId, task, from)
      }
      session = existing
    } else {
      const slot = reserveFreshDelete()
      if (!slot) throw new WorkerAdmissionRefusal('full', `task:${task.id}`, true)
      const defaults = parseDefaultModelSelection(config.defaultModelSelection)
      const providerId = task.providerId ?? defaults.providerId ?? null
      const model = task.model ?? defaults.model ?? null
      try {
        session = sessionManager.createSession(projectId, undefined, providerId, model)
      } catch (error) {
        releaseFreshDelete(slot)
        throw error
      }
      slot.id = session.id
      created = true
    }
    const attachments = task.attachments.length > 0 ? task.attachments : undefined
    const commitSession = () => {
      if (task.agentId) {
        try {
          sessionManager.setMode(session.id, task.agentId)
        } catch {
          // Unknown agent id — fall back to the session default.
        }
      }
      emitReminder(session.id, reminderForInProgress(task, session.id, from))
    }

    const projectDir = getProject(projectId)?.workdir
    let slash: SlashLaunch
    try {
      slash = await resolveSlashLaunch(configDir, projectDir, task.prompt)
    } catch {
      // Corrupt/missing slash config must not block a task from launching —
      // degrade to seeding the raw prompt.
      slash = null
    }
    if (slash?.kind === 'workflow') {
      if (launchWorkflow) {
        let admission: AdmissionResult | void
        try {
          admission = await launchWorkflow(session.id, {
            workflowId: slash.workflowId,
            params: slash.params,
            scope: 'auto',
            ...(attachments ? { attachments } : {}),
          })
        } catch (error) {
          if (created) await deleteFreshSession(session.id)
          throw error
        }
        if (refusedAdmission(admission)) {
          if (created) await deleteFreshSession(session.id)
          throw new WorkerAdmissionRefusal(admission, session.id, created)
        }
        commitSession()
        if (created) keepFreshSession(session.id)
        return { session }
      } else {
        commitSession()
        // No launcher wired (shouldn't happen in production) — degrade to a
        // plain message so the session still starts with the task's content.
        sessionManager.queueMessage(session.id, 'asap', task.prompt, attachments)
      }
    } else if (slash?.kind === 'command') {
      commitSession()
      if (slash.agentMode) {
        try {
          sessionManager.setMode(session.id, slash.agentMode)
        } catch {
          // Unknown agent — keep the task's configured agent.
        }
      }
      sessionManager.queueMessage(session.id, 'asap', slash.prompt, attachments, 'command')
    } else {
      commitSession()
      sessionManager.queueMessage(session.id, 'asap', task.prompt, attachments)
    }
    if (created) keepFreshSession(session.id)
    return { session }
  }

  async function maybeAutoLaunch(projectId: string): Promise<TasksUpdatePayload['autoLaunched'] | undefined> {
    const pendingDeletes = compensateFreshSessions()
    if (isThenable(pendingDeletes)) await pendingDeletes
    const settings = dbGetTaskSettings(projectId)
    if (settings.queuePaused) return undefined
    if (activeCount(projectId) >= settings.slotLimit) return undefined
    const queued = dbListTasks(projectId)
      .filter((t) => t.status === 'in_progress' && t.runState === 'queued')
      .sort((a, b) => a.position - b.position)
    const next = queued[0]
    if (!next) return undefined

    const earmarks = dbListTaskLinks(next.id)
    const target = reusableTarget(projectId, earmarks[0]?.session_id)
    const admissionSessionId = target ?? `task:${next.id}`
    if (canStartSession && !canStartSession(admissionSessionId)) return undefined
    const marked = runBusy(() => dbSetTaskRunState(next.id, 'running'))
    if (isThenable(marked)) await marked
    let seeded: Awaited<ReturnType<typeof seedSession>>
    try {
      seeded = await seedSession(projectId, next, 'queued', target)
    } catch (error) {
      const rolled = runBusy(() => dbSetTaskRunState(next.id, 'queued'), 2000)
      if (isThenable(rolled)) await rolled
      const compensated = compensateFreshSessions()
      if (isThenable(compensated)) await compensated
      if (isWorkerAdmissionRefusal(error) && !error.freshSession) {
        dbAddTaskLink(next.id, error.sessionId, false)
      }
      logger.warn(
        isWorkerAdmissionRefusal(error) ? 'Task auto-launch worker admission refused' : 'Task auto-launch failed',
        {
          taskId: next.id,
          ...(isWorkerAdmissionRefusal(error)
            ? { sessionId: error.sessionId, admission: error.admission }
            : { error: error instanceof Error ? error.message : String(error) }),
        },
      )
      return undefined
    }
    dbAddTaskLink(next.id, seeded.session.id, true)
    dbAddAuditEntry(next.id, 'system', 'auto_launch', `Auto-launched into session ${seeded.session.id}`, 'system')
    return {
      taskId: next.id,
      taskTitle: promptLabel(next.prompt),
      sessionId: seeded.session.id,
      projectId,
    }
  }

  // ------------------------------------------------------------------
  // System reminders (mirror the workspace-switch reminder pattern)
  // ------------------------------------------------------------------

  function emitReminder(sessionId: string, content: string) {
    try {
      sessionManager.addMessage(sessionId, {
        role: 'user',
        content: `<system-reminder>\n${content}\n</system-reminder>`,
        isSystemGenerated: true,
        messageKind: 'auto-prompt',
        metadata: { type: 'task', name: 'Task', color: REMINDER_COLOR, kind: 'definition' },
      })
    } catch {
      // Session may have been deleted concurrently — the task state stands on its own.
    }
  }

  function reminderForInProgress(task: ProjectTask, sessionId: string, from: TaskStatus | 'queued'): string {
    const gates = requiredGates(task.projectId, 'done')
    const gateLine =
      gates.length > 0 ? `Outstanding gates: ${gates.map((g) => g.name).join(', ')}.` : 'No gates configured.'
    return [
      `This session is now working on task "${promptLabel(task.prompt)}" from the project task board.`,
      `Previous state: ${prettyStatus(from)} → In Progress. Session: ${sessionId.slice(0, 8)}.`,
      gateLine,
      'Do not move the task, fill gate values, or commit changes without explicit user approval or a system instruction.',
    ].join('\n')
  }

  function reminderForDone(task: ProjectTask): string {
    const evidence = task.gateValues
      .filter((v) => v.value.trim().length > 0)
      .map((v) => `  - ${v.gateId}: ${v.value} (set by ${v.actor})`)
    const evidenceLine = evidence.length > 0 ? evidence.join('\n') : '  - (no gate values recorded)'
    return [
      `Task "${promptLabel(task.prompt)}" was marked Done.`,
      `Gate evidence that satisfied it:\n${evidenceLine}`,
      `Wind down cleanly — this task is no longer active.`,
    ].join('\n')
  }

  function reminderForTodo(task: ProjectTask): string {
    return `Task "${promptLabel(task.prompt)}" is no longer active in this session (reverted to To Do). Do not continue working on it.`
  }

  function prettyStatus(s: string): string {
    switch (s) {
      case 'todo':
        return 'To Do'
      case 'in_progress':
        return 'In Progress'
      case 'done':
        return 'Done'
      case 'queued':
        return 'Queued'
      default:
        return s
    }
  }

  function summarizeChanges(before: ProjectTask, after: ProjectTask): string {
    const parts: string[] = []
    if (before.prompt !== after.prompt) parts.push('prompt updated')
    if (before.agentId !== after.agentId || before.model !== after.model) parts.push('agent/model updated')
    if (before.attachments.length !== after.attachments.length) parts.push('attachments updated')
    return parts.length > 0 ? `Edited: ${parts.join(', ')}` : ''
  }

  return {
    snapshot,
    list,
    get,
    create,
    update,
    duplicate,
    remove,
    move,
    reconcileSessionDeleted,
    setGateValue,
    setGateConfig,
    setSettings,
    reorder,
    counts,
    runScheduled,
    retryQueuedLaunches,
    pendingFreshSessionDeletes,
  }
}

/**
 * Validate + normalize an incoming schedule. The server is authoritative: the
 * first trigger of a recurring task is always its `startAt`, and an edited
 * schedule restarts the occurrence counter.
 */
function normalizeSchedule(input: TaskSchedule): TaskSchedule {
  if (input.type === 'once') {
    if (!Number.isFinite(new Date(input.runAt).getTime())) {
      throw new Error(
        serverT(
          { en: 'Invalid schedule time: {{time}}', fr: 'Heure de planification invalide : {{time}}' },
          {
            time: input.runAt,
          },
        ),
      )
    }
    return { type: 'once', runAt: input.runAt }
  }

  const { freq, interval, startAt, end } = input
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error(
      serverT({
        en: 'Recurring interval must be a positive integer',
        fr: 'L’intervalle de récurrence doit être un entier positif',
      }),
    )
  }
  if (freq === 'week') {
    const days = input.weekdays ?? []
    if (days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new Error(
        serverT({
          en: 'Weekly recurrence requires at least one selected weekday',
          fr: 'La récurrence hebdomadaire requiert au moins un jour de la semaine sélectionné',
        }),
      )
    }
  }
  if ((freq === 'month' || freq === 'year') && input.monthDay !== undefined) {
    if (!Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31) {
      throw new Error(
        serverT({
          en: 'Day of month must be between 1 and 31',
          fr: 'Le jour du mois doit être compris entre 1 et 31',
        }),
      )
    }
  }
  if (freq === 'year' && input.yearMonth !== undefined) {
    if (!Number.isInteger(input.yearMonth) || input.yearMonth < 1 || input.yearMonth > 12) {
      throw new Error(
        serverT({
          en: 'Month must be between 1 and 12',
          fr: 'Le mois doit être compris entre 1 et 12',
        }),
      )
    }
  }
  if (!Number.isFinite(new Date(startAt).getTime())) {
    throw new Error(
      serverT(
        {
          en: 'Invalid schedule start time: {{time}}',
          fr: 'Heure de départ de planification invalide : {{time}}',
        },
        { time: startAt },
      ),
    )
  }
  if (end.kind === 'until' && !Number.isFinite(new Date(end.until).getTime())) {
    throw new Error(
      serverT(
        {
          en: 'Invalid recurrence end date: {{time}}',
          fr: 'Date de fin de récurrence invalide : {{time}}',
        },
        { time: end.until },
      ),
    )
  }
  if (end.kind === 'count' && (!Number.isInteger(end.count) || end.count < 1)) {
    throw new Error(
      serverT({
        en: 'Occurrence count must be a positive integer',
        fr: 'Le nombre d’occurrences doit être un entier positif',
      }),
    )
  }

  return {
    type: 'recurring',
    freq,
    interval,
    ...(input.weekdays ? { weekdays: input.weekdays } : {}),
    ...(input.monthDay !== undefined ? { monthDay: input.monthDay } : {}),
    ...(input.yearMonth !== undefined ? { yearMonth: input.yearMonth } : {}),
    startAt,
    end,
    occurrencesDone: 0,
    nextRunAt: startAt,
  }
}

/** Short human-readable label for a prompt (first line, truncated) — used for session names and notices. */
function promptLabel(prompt: string): string {
  const firstLine =
    prompt
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, '')
  if (cleaned.length <= 52) return cleaned
  return `${cleaned.slice(0, 49).trimEnd()}…`
}
