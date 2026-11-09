import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import { SessionTurnScheduler } from '../session/worker/scheduler.js'
import { SessionManager } from '../session/manager.js'
import { initEventStore } from '../events/index.js'
import { getDatabase } from '../db/index.js'
import { registerTaskRoutes } from '../routes/tasks.js'
import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { createTasksService, isTaskGateError, isTaskConflictError } from './service.js'
import type { TasksService } from './service.js'
import type { TasksUpdatePayload } from '../../shared/protocol.js'
import type { Attachment } from '../../shared/types.js'

interface FakeSession {
  id: string
  projectId: string
  title?: string
  messages?: unknown[]
}

interface FakeSessionManager {
  createdSessions: FakeSession[]
  reminders: { sessionId: string; content: string; metadata?: unknown }[]
  queued: { sessionId: string; content: string; attachments?: Attachment[] }[]
  sessions: Map<string, FakeSession>
  modes: Map<string, string>
}

function makeSessionManager(): FakeSessionManager & {
  createSession: (projectId: string, ...rest: unknown[]) => FakeSession
  addMessage: (sessionId: string, message: unknown) => void
  queueMessage: (sessionId: string, mode: string, content?: string, attachments?: Attachment[]) => void
  setMode: (sessionId: string, mode: string) => void
  getSession: (id: string) => FakeSession | null
  deleteSession: (id: string) => void
} {
  const mgr = {
    createdSessions: [] as FakeSession[],
    reminders: [] as { sessionId: string; content: string; metadata?: unknown }[],
    queued: [] as { sessionId: string; content: string; attachments?: Attachment[] }[],
    sessions: new Map<string, FakeSession>(),
    modes: new Map<string, string>(),
  }

  const counter = { n: 0 }

  return {
    ...mgr,
    createSession: (_pid: string, title?: unknown) => {
      counter.n += 1
      const session: FakeSession = { id: `sess-${counter.n}`, projectId: _pid }
      if (typeof title === 'string' && title.length > 0) session.title = title
      mgr.createdSessions.push(session)
      mgr.sessions.set(session.id, session)
      return session
    },
    addMessage: (sessionId: string, message: unknown) => {
      mgr.reminders.push({
        sessionId,
        content: (message as { content: string }).content,
        metadata: (message as { metadata?: unknown }).metadata,
      })
    },
    queueMessage: (sessionId: string, _mode: string, content?: string, attachments?: Attachment[]) => {
      mgr.queued.push({ sessionId, content: content ?? '', ...(attachments ? { attachments } : {}) })
    },
    setMode: (sessionId: string, mode: string) => {
      mgr.modes.set(sessionId, mode)
    },
    getSession: (id: string) => mgr.sessions.get(id) ?? null,
    deleteSession: (id: string) => {
      mgr.sessions.delete(id)
      mgr.reminders.splice(0, mgr.reminders.length, ...mgr.reminders.filter((reminder) => reminder.sessionId !== id))
      mgr.queued.splice(0, mgr.queued.length, ...mgr.queued.filter((item) => item.sessionId !== id))
    },
  }
}

describe('project tasks service', () => {
  let root: string
  let projectId: string
  let service: TasksService
  let broadcasts: TasksUpdatePayload[]
  let sm: ReturnType<typeof makeSessionManager>
  let launchSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)

    root = await mkdtemp(join(tmpdir(), 'openfox-tasks-'))
    await mkdir(join(root, 'nested'), { recursive: true })
    projectId = createProject('Tasks Test', root).id

    // Fixture slash config: a command and a workflow the service resolves at seed time.
    const configDir = join(root, 'config')
    await mkdir(join(configDir, 'commands'), { recursive: true })
    await mkdir(join(configDir, 'workflows'), { recursive: true })
    await writeFile(
      join(configDir, 'commands', 'fixme.command.md'),
      '---\nid: fixme\nname: Fix me\nagentMode: builder\n---\n\nFix the {{issue}} bug in {{file}}.',
    )
    await writeFile(
      join(configDir, 'workflows', 'fixit.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'fixit',
          name: 'Fix it',
          description: 'fixture',
          version: '1.0.0',
          parameters: [
            { id: 'issue', label: 'Issue', position: 0 },
            { id: 'file', label: 'File', position: 1 },
          ],
        },
        entryStep: 'do_it',
        settings: { maxIterations: 5 },
        steps: [
          {
            id: 'do_it',
            name: 'Do it',
            type: 'agent',
            phase: 'build',
            prompt: 'Fix {{issue}} in {{file}}',
            transitions: [{ when: { type: 'always' }, goto: '$done' }],
          },
        ],
        startCondition: { type: 'always' },
      }),
    )
    await writeFile(
      join(configDir, 'workflows', 'reqwf.workflow.json'),
      JSON.stringify({
        metadata: {
          id: 'reqwf',
          name: 'Req WF',
          description: 'fixture',
          version: '1.0.0',
          parameters: [{ id: 'issue', label: 'Issue', position: 0, required: true }],
        },
        entryStep: 'do_it',
        settings: { maxIterations: 5 },
        steps: [
          {
            id: 'do_it',
            name: 'Do it',
            type: 'agent',
            phase: 'build',
            prompt: 'Fix {{issue}}',
            transitions: [{ when: { type: 'always' }, goto: '$done' }],
          },
        ],
        startCondition: { type: 'always' },
      }),
    )

    broadcasts = []
    sm = makeSessionManager()
    launchSpy = vi.fn()
    const configWithDefault = loadConfig()
    service = createTasksService({
      sessionManager: sm as unknown as import('../session/manager.js').SessionManager,
      config: configWithDefault,
      broadcast: (_pid, payload) => broadcasts.push(payload),
      configDir,
      launchWorkflow: launchSpy as never,
    })
  })

  afterEach(async () => {
    closeDatabase()
    await rm(root, { recursive: true, force: true })
  })

  const create = (prompt: string, extra: Record<string, unknown> = {}) =>
    service.create(projectId, { prompt, ...extra }, { actor: 'human' })

  it('creates a task in To Do and broadcasts', () => {
    const task = create('Fix the login flow\nIt is broken')
    expect(task.status).toBe('todo')
    expect(task.prompt).toBe('Fix the login flow\nIt is broken')
    expect(task.auditTrail[0]?.action).toBe('create')
    expect(broadcasts.at(-1)?.tasks).toHaveLength(1)
  })

  it('assigns compact hexadecimal ids', () => {
    const task = create('Compact id task')
    expect(task.id).toMatch(/^[0-9a-f]{16}$/)
    expect(task.id.length).toBeLessThan(36)
  })

  it('rejects a task with neither text nor attachments', () => {
    expect(() => service.create(projectId, { prompt: '   ' }, { actor: 'human' })).toThrow(/prompt or an attachment/)
  })

  it('accepts an attachment-only task', () => {
    const att: Attachment = {
      id: 'a1',
      filename: 'pic.png',
      mimeType: 'image/png',
      size: 10,
      data: 'data:image/png;base64,x',
    }
    const task = create('', { attachments: [att] })
    expect(task.attachments).toHaveLength(1)
  })

  it('duplicates a task into To Do', () => {
    const task = create('Original prompt')
    const copy = service.duplicate(projectId, task.id, { actor: 'human' })
    expect(copy.id).not.toBe(task.id)
    expect(copy.status).toBe('todo')
    expect(copy.prompt).toBe('Original prompt')
  })

  describe('launch & slots', () => {
    it('breaks In Progress counts into running and queued', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' }) // queued

      const snapshot = service.snapshot(projectId)
      expect(snapshot.counts).toMatchObject({ todo: 0, inProgress: 2, running: 1, queued: 1, done: 0 })
    })

    it('human move to In Progress creates + seeds a session, runs when a slot is free', async () => {
      const task = create('Do the thing')
      const result = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })

      expect(sm.createdSessions).toHaveLength(1)
      const session = sm.createdSessions[0]!
      expect(result.sessionId).toBe(session.id)
      expect(result.task.status).toBe('in_progress')
      expect(result.task.runState).toBe('running')
      expect(result.task.activeSessionId).toBe(session.id)
      // Reminder precedes the prompt, wrapped in <system-reminder>
      expect(sm.reminders[0]?.sessionId).toBe(session.id)
      expect(sm.reminders[0]?.content).toContain('<system-reminder>')
      expect(sm.reminders[0]?.metadata).toMatchObject({ type: 'task' })
      // Prompt queued so the agent turn starts
      expect(sm.queued[0]?.content).toBe('Do the thing')
    })

    it('parks a card without a session when the worker admission queue is full', async () => {
      const blocked = createTasksService({
        sessionManager: sm as unknown as import('../session/manager.js').SessionManager,
        config: loadConfig(),
        broadcast: (_pid, payload) => broadcasts.push(payload),
        configDir: join(root, 'config'),
        launchWorkflow: launchSpy as never,
        canStartSession: () => false,
      })
      const task = blocked.create(projectId, { prompt: 'Blocked by worker queue' }, { actor: 'human' })

      const parked = await blocked.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(parked.queued).toMatchObject({ reason: 'admission_refused' })
      expect(parked.task).toMatchObject({ status: 'in_progress', runState: 'queued' })
      expect(parked.task.activeSessionId).toBeUndefined()
      expect(sm.createdSessions).toHaveLength(0)
      expect(sm.reminders).toHaveLength(0)
      expect(sm.queued).toHaveLength(0)
      expect(launchSpy).not.toHaveBeenCalled()
    })

    it('seeds the session without a prompt-derived title so auto-naming applies', async () => {
      const task = create('Investigate and fix the flaky test in CI')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })

      expect(sm.createdSessions).toHaveLength(1)
      expect(sm.createdSessions[0]!.title).toBeUndefined()
    })

    it('second task queues when the single slot is busy', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      const result = await service.move(projectId, second.id, 'in_progress', { actor: 'human' })

      expect(result.task.runState).toBe('queued')
      expect(sm.createdSessions).toHaveLength(1) // no new session for queued
    })

    it('a running task whose session was deleted frees its slot', async () => {
      const first = create('First')
      const second = create('Second')
      const running = await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      sm.sessions.delete(running.sessionId!)

      const result = await service.move(projectId, second.id, 'in_progress', { actor: 'human' })

      expect(service.get(projectId, first.id)).toMatchObject({ runState: 'idle' })
      expect(service.get(projectId, first.id)?.activeSessionId).toBeUndefined()
      expect(result.task.runState).toBe('running')
      expect(result.sessionId).toBeTruthy()
    })

    it('deleting a session reconciles its running task and auto-launches the next', async () => {
      const first = create('First')
      const second = create('Second')
      const running = await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })
      sm.sessions.delete(running.sessionId!)

      await (
        service as TasksService & {
          reconcileSessionDeleted: (projectId: string, sessionId: string) => Promise<void>
        }
      ).reconcileSessionDeleted(projectId, running.sessionId!)

      expect(service.get(projectId, first.id)).toMatchObject({ runState: 'idle' })
      expect(service.get(projectId, first.id)?.activeSessionId).toBeUndefined()
      expect(service.get(projectId, first.id)?.auditTrail.at(-1)?.detail).toContain('session deleted')
      expect(service.get(projectId, second.id)).toMatchObject({ runState: 'running' })
      expect(sm.createdSessions).toHaveLength(2)
    })

    it('move to in_progress over the slot limit returns an explicit queued reason', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })

      const result = await service.move(projectId, second.id, 'in_progress', { actor: 'human' })

      expect(
        (
          result as typeof result & {
            queued?: { reason: string; active: number; slotLimit: number; position: number }
          }
        ).queued,
      ).toEqual({
        reason: 'slot_limit',
        active: 1,
        slotLimit: 1,
        position: 1,
      })
    })

    it('surfaces the FIFO queue position server-side (1-based)', async () => {
      const first = create('First')
      const second = create('Second')
      const third = create('Third')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, third.id, 'in_progress', { actor: 'human' })

      expect(service.get(projectId, second.id)!.queuePosition).toBe(1)
      expect(service.get(projectId, third.id)!.queuePosition).toBe(2)
      // Running tasks have no queue position
      expect(service.get(projectId, first.id)!.queuePosition).toBeUndefined()
    })

    it('human move with an explicit project sessionId binds to it instead of seeding a new session', async () => {
      const task = create('Start me here')
      sm.sessions.set('sess-current', { id: 'sess-current', projectId, messages: [] })

      const result = await service.move(projectId, task.id, 'in_progress', {
        actor: 'human',
        sessionId: 'sess-current',
      })

      expect(sm.createdSessions).toHaveLength(0)
      expect(result.sessionId).toBe('sess-current')
      expect(result.task.status).toBe('in_progress')
      expect(result.task.runState).toBe('running')
      expect(result.task.activeSessionId).toBe('sess-current')
      // Reminder + queued prompt land in the bound session, like a seeded one.
      expect(sm.reminders[0]?.sessionId).toBe('sess-current')
      expect(sm.reminders[0]?.content).toContain('<system-reminder>')
      expect(sm.queued[0]?.sessionId).toBe('sess-current')
      expect(sm.queued[0]?.content).toBe('Start me here')
    })

    it('falls back to seeding a new session when the supplied sessionId is foreign', async () => {
      const task = create('Foreign target')
      sm.sessions.set('sess-foreign', { id: 'sess-foreign', projectId: 'another-project', messages: [] })

      const result = await service.move(projectId, task.id, 'in_progress', {
        actor: 'human',
        sessionId: 'sess-foreign',
      })

      expect(sm.createdSessions).toHaveLength(1)
      const seeded = sm.createdSessions[0]!
      expect(result.sessionId).toBe(seeded.id)
      expect(result.task.activeSessionId).toBe(seeded.id)
      expect(sm.reminders[0]?.sessionId).toBe(seeded.id)
    })

    it('does not reuse a target session that already has messages (seeds fresh instead)', async () => {
      const task = create('Busy session')
      sm.sessions.set('sess-busy', { id: 'sess-busy', projectId, messages: [{ id: 'm1' }] })

      const result = await service.move(projectId, task.id, 'in_progress', {
        actor: 'human',
        sessionId: 'sess-busy',
      })

      expect(sm.createdSessions).toHaveLength(1)
      const seeded = sm.createdSessions[0]!
      expect(result.sessionId).toBe(seeded.id)
      expect(result.task.activeSessionId).toBe(seeded.id)
      expect(result.task.sessionIds).toEqual([seeded.id])
    })

    it('does not reuse an interrupted target session (seeds fresh instead)', async () => {
      const task = create('Interrupted session')
      sm.sessions.set('sess-int', {
        id: 'sess-int',
        projectId,
        messages: [],
        interruptedAt: '2026-10-29T14:50:21.285Z',
      } as any)

      const result = await service.move(projectId, task.id, 'in_progress', {
        actor: 'human',
        sessionId: 'sess-int',
      })

      expect(sm.createdSessions).toHaveLength(1)
      const seeded = sm.createdSessions[0]!
      expect(result.sessionId).toBe(seeded.id)
      expect(result.task.sessionIds).toEqual([seeded.id])
    })

    it('honors the earmarked session when a queued task auto-launches later', async () => {
      const first = create('Occupying the slot')
      const second = create('Queued with a home')
      sm.sessions.set('sess-home', { id: 'sess-home', projectId, messages: [] })

      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      const queued = await service.move(projectId, second.id, 'in_progress', {
        actor: 'human',
        sessionId: 'sess-home',
      })
      expect(queued.task.runState).toBe('queued')
      expect(queued.task.sessionIds).toEqual(['sess-home'])
      expect(sm.createdSessions).toHaveLength(1) // nothing seeded at queue time

      // Free the slot — the queued task launches INTO its earmarked session.
      await service.move(projectId, first.id, 'todo', { actor: 'human' })
      const launched = service.get(projectId, second.id)!
      expect(launched.runState).toBe('running')
      expect(launched.activeSessionId).toBe('sess-home')
      expect(sm.createdSessions).toHaveLength(1) // still no orphan session
      expect(sm.reminders.some((r) => r.sessionId === 'sess-home')).toBe(true)
      expect(sm.queued.some((q) => q.sessionId === 'sess-home')).toBe(true)
    })

    it('agent move binds the current session and never creates a new one', async () => {
      const task = create('Agent task')
      const agentSession = { id: 'sess-agent', projectId }
      sm.sessions.set('sess-agent', agentSession)

      const result = await service.move(projectId, task.id, 'in_progress', {
        actor: 'agent',
        sessionId: 'sess-agent',
      })
      expect(sm.createdSessions).toHaveLength(0)
      expect(result.task.activeSessionId).toBe('sess-agent')
      expect(result.task.runState).toBe('running')
      expect(sm.reminders[0]?.sessionId).toBe('sess-agent')
    })

    it('reverting a running task to To Do frees the slot and auto-launches the next queued task', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })

      const result = await service.move(projectId, first.id, 'todo', { actor: 'human' })
      const secondFresh = service.get(projectId, second.id)!

      expect(secondFresh.status).toBe('in_progress')
      expect(secondFresh.runState).toBe('running')
      expect(sm.createdSessions).toHaveLength(2)
      expect(result.autoLaunched?.taskId).toBe(second.id)
      expect(result.autoLaunched?.projectId).toBe(projectId)
      expect(result.autoLaunched?.sessionId).toBeTruthy()
      // The reverted task's link was removed (unbound)
      expect(service.get(projectId, first.id)!.sessionIds).toEqual([])
    })

    it('paused queue suppresses auto-launch', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      service.setSettings(projectId, { queuePaused: true })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })
      expect(service.get(projectId, second.id)!.runState).toBe('queued')

      await service.move(projectId, first.id, 'todo', { actor: 'human' })
      expect(service.get(projectId, second.id)!.runState).toBe('queued')
      expect(sm.createdSessions).toHaveLength(1)

      // Unpausing kicks the queue
      service.setSettings(projectId, { queuePaused: false })
      expect(service.get(projectId, second.id)!.runState).toBe('running')
      expect(sm.createdSessions).toHaveLength(2)
    })
  })

  describe('gates (definition of done)', () => {
    const configureDoneGate = () =>
      service.setGateConfig(
        projectId,
        [
          {
            id: 'commit',
            name: 'Commit',
            description: 'work committed with a commit reference',
            required: true,
            variant: 'done',
          },
        ],
        { actor: 'human' },
      )

    it('blocks Done until required gates carry a value, with an actionable error', async () => {
      configureDoneGate()
      const task = create('Ship it')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })

      const promise = service.move(projectId, task.id, 'done', { actor: 'human' })
      await expect(promise).rejects.toSatisfy(isTaskGateError)
      await promise.catch((err: unknown) => {
        if (isTaskGateError(err)) {
          expect(err.missing.map((m) => m.gateId)).toContain('commit')
          expect(err.task.status).toBe('in_progress')
        } else {
          throw err
        }
      })
      expect(service.get(projectId, task.id)!.status).toBe('in_progress')
    })

    it('records gate value actor + timestamp, then permits Done', async () => {
      configureDoneGate()
      const task = create('Ship it')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      await service.setGateValue(
        projectId,
        task.id,
        'commit',
        'abc123',
        { actor: 'agent', actorName: 'builder' },
        'sess-agent',
      )

      const withValue = service.get(projectId, task.id)!
      expect(withValue.gateValues[0]).toMatchObject({ gateId: 'commit', value: 'abc123', actor: 'agent' })
      expect(withValue.gateValues[0]?.timestamp).toBeTruthy()

      const result = await service.move(projectId, task.id, 'done', { actor: 'agent', sessionId: 'sess-agent' })
      expect(result.task.status).toBe('done')
      // Done reminder landed in the bound session with gate evidence
      const doneReminder = sm.reminders.find((r) => r.content.includes('was marked Done'))
      expect(doneReminder).toBeTruthy()
      expect(doneReminder?.content).toContain('abc123')
    })

    it('reopening a Done task creates a fresh session and keeps history links', async () => {
      configureDoneGate()
      const task = create('Iterate')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      const firstSession = sm.createdSessions[0]!.id
      await service.setGateValue(projectId, task.id, 'commit', 'aaa', { actor: 'human' })
      await service.move(projectId, task.id, 'done', { actor: 'human' })

      const reopened = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(reopened.task.runState).toBe('running')
      expect(reopened.task.activeSessionId).not.toBe(firstSession)
      expect(reopened.task.sessionIds).toContain(firstSession)
      expect(reopened.task.sessionIds).toContain(reopened.task.activeSessionId)
      expect(sm.createdSessions).toHaveLength(2)
    })

    it('reverting Done to To Do records the reason in the audit trail', async () => {
      configureDoneGate()
      const task = create('Ship it')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      await service.setGateValue(projectId, task.id, 'commit', 'abc', { actor: 'human' })
      await service.move(projectId, task.id, 'done', { actor: 'human' })

      await service.move(projectId, task.id, 'todo', { actor: 'human', reason: 'customer rejected the change' })
      const reverted = service.get(projectId, task.id)!
      expect(reverted.status).toBe('todo')
      expect(reverted.auditTrail.at(-1)?.detail).toContain('customer rejected the change')
    })

    it('reconfiguring gates prunes values for removed gates', async () => {
      service.setGateConfig(
        projectId,
        [{ id: 'commit', name: 'Commit', description: 'need a sha', required: true, variant: 'done' }],
        { actor: 'human' },
      )
      const task = create('Prune me')
      await service.setGateValue(projectId, task.id, 'commit', 'abc', { actor: 'human' })
      expect(service.get(projectId, task.id)!.gateValues).toHaveLength(1)

      // Drop the gate — its values must disappear with it.
      service.setGateConfig(
        projectId,
        [{ id: 'green', name: 'All green', description: '', required: true, variant: 'done' }],
        {
          actor: 'human',
        },
      )
      const pruned = service.get(projectId, task.id)!
      expect(pruned.gateValues).toHaveLength(0)
    })

    it('reports the blocked transition when a ready gate blocks In Progress', async () => {
      service.setGateConfig(
        projectId,
        [
          {
            id: 'design',
            name: 'Design approved',
            description: 'sign-off before work',
            required: true,
            variant: 'ready',
          },
        ],
        { actor: 'human' },
      )
      const task = create('Needs approval')
      const promise = service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      await expect(promise).rejects.toSatisfy(isTaskGateError)
      await promise.catch((err: unknown) => {
        if (isTaskGateError(err)) {
          expect(err.message).toContain('In Progress')
          expect(err.missing.map((m) => m.gateId)).toContain('design')
        } else {
          throw err
        }
      })
      expect(service.get(projectId, task.id)!.status).toBe('todo')
    })

    it('a scheduled trigger blocked by ready gates does not abort the tick (other projects still run)', async () => {
      service.setGateConfig(
        projectId,
        [
          {
            id: 'design',
            name: 'Design approved',
            description: 'sign-off before work',
            required: true,
            variant: 'ready',
          },
        ],
        { actor: 'human' },
      )
      const blocked = create('Blocked scheduled', {
        schedule: { type: 'once', runAt: '2020-01-01T09:00:00' },
      })

      // A due task in another project (no gates there) must still trigger.
      const otherRoot = await mkdtemp(join(tmpdir(), 'openfox-tasks-other-'))
      const otherProjectId = createProject('Other', otherRoot).id
      const otherTask = service.create(
        otherProjectId,
        { prompt: 'Plain due', schedule: { type: 'once', runAt: '2020-01-01T09:00:00' } },
        { actor: 'human' },
      )

      await expect(service.runScheduled()).resolves.toBeUndefined()

      // The blocked task remains todo with its schedule (retries next tick)…
      const stillBlocked = service.get(projectId, blocked.id)!
      expect(stillBlocked.status).toBe('todo')
      expect(stillBlocked.schedule?.type).toBe('once')
      // …while the sibling project's due task still triggered.
      expect(service.get(otherProjectId, otherTask.id)!.status).toBe('in_progress')
    })

    it('a recurring template blocked by ready gates never spawns orphan clones', async () => {
      service.setGateConfig(
        projectId,
        [
          {
            id: 'design',
            name: 'Design approved',
            description: 'sign-off before work',
            required: true,
            variant: 'ready',
          },
        ],
        { actor: 'human' },
      )
      const template = create('Recurring blocked', {
        schedule: {
          type: 'recurring',
          freq: 'day',
          interval: 1,
          startAt: '2020-01-01T09:00:00',
          end: { kind: 'never' },
          occurrencesDone: 0,
          nextRunAt: '2020-01-01T09:00:00',
        },
      })

      // Several ticks: no clone may ever be left behind.
      await service.runScheduled()
      await service.runScheduled()
      await service.runScheduled()

      const tasks = service.list(projectId)
      expect(tasks).toHaveLength(1) // only the template
      const fresh = service.get(projectId, template.id)!
      expect(fresh.status).toBe('todo')
      const sched = fresh.schedule as Extract<NonNullable<typeof fresh.schedule>, { type: 'recurring' }>
      expect(sched.occurrencesDone).toBe(0) // not advanced, still due
    })
  })

  describe('concurrency', () => {
    it('rejects a stale write with a CONFLICT error', async () => {
      const task = create('Race me')
      const staleVersion = task.version
      await service.update(projectId, task.id, { prompt: 'Renamed' }, { actor: 'human' })

      const promise = service.update(projectId, task.id, { prompt: 'other' }, { actor: 'human' }, staleVersion)
      await expect(promise).rejects.toSatisfy(isTaskConflictError)
      await promise.catch((err: unknown) => {
        if (!isTaskConflictError(err)) throw err
      })
    })
  })

  describe('lifecycle', () => {
    it('deleting a running task unlinks sessions and frees its slot', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })
      const linkedSession = sm.createdSessions[0]!.id

      await service.remove(projectId, first.id, { actor: 'human' })
      expect(service.get(projectId, first.id)).toBeNull()
      // Next queued task auto-launched
      expect(service.get(projectId, second.id)!.runState).toBe('running')
      expect(sm.createdSessions).toHaveLength(2)
      // The linked session itself is untouched (still tracked by our fake)
      expect(sm.sessions.has(linkedSession)).toBe(true)
    })

    it('reorder moves a task within its column', async () => {
      const a = create('A')
      const b = create('B')
      const c = create('C')
      service.reorder(projectId, c.id, 'todo', 0)
      const ids = service
        .list(projectId)
        .filter((t) => t.status === 'todo')
        .map((t) => t.id)
      expect(ids).toEqual([c.id, a.id, b.id])
    })
  })

  describe('reminders', () => {
    it('emits a system reminder with task metadata for each transition', async () => {
      const task = create('Reminder task')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      const sessionId = sm.createdSessions[0]!.id

      await service.move(projectId, task.id, 'todo', { actor: 'human' })
      const reminders = sm.reminders.filter((r) => r.sessionId === sessionId)
      expect(reminders).toHaveLength(2)
      expect(reminders[1]?.content).toContain('no longer active')
      expect(reminders.every((r) => (r.metadata as { type: string }).type === 'task')).toBe(true)
    })

    it('reports the real previous state in launch reminders (auto-launch from queue)', async () => {
      const first = create('First')
      const second = create('Second')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      // Human launch from To Do
      expect(sm.reminders[0]!.content).toContain('To Do → In Progress')

      // Second queues; freeing the slot auto-launches it into a fresh session.
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })
      const reminderCount = sm.reminders.length
      await service.move(projectId, first.id, 'todo', { actor: 'human' }) // frees the slot

      const autoReminder = sm.reminders.at(-1)!
      expect(sm.reminders.length).toBeGreaterThan(reminderCount)
      // The opening context must reflect the queued → running transition,
      // not a made-up "todo → In Progress".
      expect(autoReminder.content).toContain('Queued → In Progress')
      expect(autoReminder.content).not.toContain('To Do → In Progress')
    })

    it('instructs the agent not to move the task or fill gates without approval', async () => {
      const task = create('Reminder task')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      const sessionId = sm.createdSessions[0]!.id

      const reminder = sm.reminders.find((r) => r.sessionId === sessionId)!
      expect(reminder.content).toContain(
        'Do not move the task, fill gate values, or commit changes without explicit user approval or a system instruction.',
      )
    })

    it('labels a Done re-open reminder with the true previous state', async () => {
      const task = create('Iterate')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, task.id, 'done', { actor: 'human' })
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' }) // re-open → fresh session

      const reopenReminder = sm.reminders.at(-1)!
      expect(reopenReminder.content).toContain('Done → In Progress')
      expect(reopenReminder.content).not.toContain('To Do → In Progress')
    })
  })

  describe('slash-command seeding', () => {
    it('launches a workflow instead of queueing the raw prompt', async () => {
      const task = create('/fixit crash src/a.ts')
      const result = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })

      expect(launchSpy).toHaveBeenCalledTimes(1)
      expect(launchSpy.mock.calls[0]![0]).toBe(result.sessionId)
      expect(launchSpy.mock.calls[0]![1]).toEqual({
        workflowId: 'fixit',
        params: { issue: 'crash', file: 'src/a.ts' },
        scope: 'auto',
      })
      // No plain chat message queued — the workflow IS the task.
      expect(sm.queued).toHaveLength(0)
      // The situational reminder still opens the session.
      expect(sm.reminders[0]?.sessionId).toBe(result.sessionId)
      expect(sm.reminders[0]?.content).toContain('<system-reminder>')
    })

    it('launches a bundled default workflow with no params', async () => {
      const task = create('/default')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(launchSpy).toHaveBeenCalledTimes(1)
      expect(launchSpy.mock.calls[0]![1]).toEqual({ workflowId: 'default', params: {}, scope: 'auto' })
    })

    it('leaves the card and its one-off schedule unchanged when the worker fails to start', async () => {
      launchSpy.mockReturnValue('start_failed')
      const task = create('/default', { schedule: { type: 'once', runAt: '2030-01-01T09:00:00' } })
      const app = express()
      app.use(express.json())
      const router = express.Router()
      registerTaskRoutes(router, service)
      app.use('/api', router)
      const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const listening = app.listen(0, () => resolve(listening))
      })
      try {
        const port = (server.address() as { port: number }).port
        const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/tasks/${task.id}/move`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'in_progress' }),
        })
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({
          code: 'WORKER_ADMISSION_REFUSED',
          admission: 'start_failed',
        })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }

      expect(service.get(projectId, task.id)).toMatchObject({
        status: 'todo',
        schedule: { type: 'once', runAt: '2030-01-01T09:00:00' },
      })
      expect(service.get(projectId, task.id)?.runState).toBeUndefined()
      expect(service.get(projectId, task.id)?.auditTrail.at(-1)?.detail).not.toContain('running')
      expect(service.get(projectId, task.id)?.auditTrail.at(-1)?.detail).not.toContain('queued')
    })

    it('deletes only the fresh session of a refused workflow start', async () => {
      sm.sessions.set('sess-user', { id: 'sess-user', projectId, messages: [] })
      launchSpy.mockReturnValueOnce('start_failed').mockReturnValueOnce('started').mockReturnValueOnce('start_failed')
      const task = create('/default')

      await expect(service.move(projectId, task.id, 'in_progress', { actor: 'human' })).rejects.toMatchObject({
        code: 'WORKER_ADMISSION_REFUSED',
        admission: 'start_failed',
      })
      const abandoned = sm.createdSessions.map((session) => session.id)
      expect(abandoned).toEqual(['sess-1'])
      expect(sm.sessions.has('sess-1')).toBe(false)
      expect(sm.reminders.filter((reminder) => reminder.sessionId === 'sess-1')).toEqual([])
      expect(service.get(projectId, task.id)).toMatchObject({
        status: 'todo',
        sessionIds: [],
      })
      expect(service.get(projectId, task.id)?.runState).toBeUndefined()
      expect(service.get(projectId, task.id)?.activeSessionId).toBeUndefined()

      await service.move(projectId, task.id, 'todo', { actor: 'human' })
      const accepted = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect([...sm.sessions.keys()].filter((id) => id !== 'sess-user')).toEqual([accepted.sessionId])
      expect(service.get(projectId, task.id)).toMatchObject({
        runState: 'running',
        activeSessionId: accepted.sessionId,
        sessionIds: [accepted.sessionId],
      })

      await service.move(projectId, task.id, 'todo', { actor: 'human' })
      const supplied = create('/default')
      const before = sm.createdSessions.length
      sm.modes.set('sess-user', 'plan')
      await expect(
        service.move(projectId, supplied.id, 'in_progress', { actor: 'human', sessionId: 'sess-user' }),
      ).rejects.toMatchObject({ admission: 'start_failed' })
      expect(sm.sessions.has('sess-user')).toBe(true)
      expect(sm.createdSessions).toHaveLength(before)
      expect(sm.reminders.filter((reminder) => reminder.sessionId === 'sess-user')).toEqual([])
      expect(sm.modes.get('sess-user')).toBe('plan')
      expect(service.get(projectId, supplied.id)?.status).toBe('todo')
    })

    it('parks a full worker pool as queued and launches when a slot frees', async () => {
      launchSpy.mockReturnValueOnce('full').mockReturnValueOnce('started')
      const task = create('/default')
      const parked = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(parked.queued).toMatchObject({ reason: 'admission_refused' })
      expect(parked.task).toMatchObject({ status: 'in_progress', runState: 'queued' })
      expect(parked.task.auditTrail.at(-1)?.detail).toContain('waiting for a worker')
      expect(parked.task.auditTrail.at(-1)?.detail).not.toContain('full')

      await service.retryQueuedLaunches()

      expect(service.get(projectId, task.id)).toMatchObject({ status: 'in_progress', runState: 'running' })
      expect(
        sm.reminders.some((reminder) => reminder.sessionId === service.get(projectId, task.id)?.activeSessionId),
      ).toBe(true)
    })

    it('returns the queued move instead of an admission error when the pool is full', async () => {
      launchSpy.mockReturnValue('full')
      const task = create('/default')
      const app = express()
      app.use(express.json())
      const router = express.Router()
      registerTaskRoutes(router, service)
      app.use('/api', router)
      const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const listening = app.listen(0, () => resolve(listening))
      })
      try {
        const port = (server.address() as { port: number }).port
        const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/tasks/${task.id}/move`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'in_progress' }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          queued: { reason: 'admission_refused' },
          task: { status: 'in_progress', runState: 'queued' },
        })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('keeps a busy auto-launch queued and still starts the next project', async () => {
      const otherRoot = join(root, 'nested')
      const otherProjectId = createProject('Other tasks', otherRoot).id
      launchSpy.mockReturnValue('full')
      const blocked = create('/default')
      const next = service.create(otherProjectId, { prompt: '/default' }, { actor: 'human' })
      await service.move(projectId, blocked.id, 'in_progress', { actor: 'human' })
      await service.move(otherProjectId, next.id, 'in_progress', { actor: 'human' })

      const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
      launchSpy.mockImplementation((sessionId: string) => {
        const session = sm.sessions.get(sessionId)
        if (session?.projectId === projectId) throw busy
        return 'started'
      })
      await service.retryQueuedLaunches()

      expect(service.get(projectId, blocked.id)).toMatchObject({ status: 'in_progress', runState: 'queued' })
      expect(service.get(projectId, blocked.id)?.activeSessionId).toBeUndefined()
      expect(launchSpy.mock.calls.length).toBeGreaterThan(2)
      expect(service.get(otherProjectId, next.id)).toMatchObject({ status: 'in_progress', runState: 'running' })
    })

    it('parks a real full or closed worker pool as queued and keeps start_failed as unavailable', async () => {
      const postMove = async (tasks: TasksService, taskId: string) => {
        const app = express()
        app.use(express.json())
        const router = express.Router()
        registerTaskRoutes(router, tasks)
        app.use('/api', router)
        const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
          const listening = app.listen(0, () => resolve(listening))
        })
        try {
          const port = (server.address() as { port: number }).port
          return await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/tasks/${taskId}/move`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to: 'in_progress' }),
          })
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }
      }
      const parked = async (scheduler: SessionTurnScheduler, title: string) => {
        const tasks = createTasksService({
          sessionManager: sm as unknown as import('../session/manager.js').SessionManager,
          config: loadConfig(),
          broadcast: () => {},
          configDir: join(root, 'config'),
          launchWorkflow: () => {
            throw new Error(`${title} must not launch`)
          },
          canStartSession: (sessionId) => scheduler.canAccept(sessionId),
        })
        const task = tasks.create(projectId, { prompt: title }, { actor: 'human' })
        const before = sm.createdSessions.length
        const response = await postMove(tasks, task.id)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          queued: { reason: 'admission_refused' },
          task: { status: 'in_progress', runState: 'queued' },
        })
        expect(sm.createdSessions).toHaveLength(before)
        expect(tasks.get(projectId, task.id)?.runState).not.toBe('running')
        expect(tasks.get(projectId, task.id)?.activeSessionId).toBeUndefined()
      }

      const full = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 0 })
      expect(full.admit('holder', () => {})).toBe('started')
      await parked(full, 'real full pool')

      const closed = new SessionTurnScheduler({ maxConcurrent: 1, maxWaitingSessions: 1 })
      closed.closeAdmissions()
      await parked(closed, 'real closed pool')

      const failed = createTasksService({
        sessionManager: sm as unknown as import('../session/manager.js').SessionManager,
        config: loadConfig(),
        broadcast: () => {},
        configDir: join(root, 'config'),
        launchWorkflow: () => 'start_failed',
        canStartSession: () => true,
      })
      const failedTask = failed.create(projectId, { prompt: '/default' }, { actor: 'human' })
      const response = await postMove(failed, failedTask.id)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        code: 'WORKER_ADMISSION_REFUSED',
        admission: 'start_failed',
      })
      expect(sm.sessions.size).toBe(0)
      expect(failed.get(projectId, failedTask.id)).toMatchObject({ status: 'todo' })
      expect(failed.get(projectId, failedTask.id)?.runState).toBeUndefined()
    })

    it('retries a real database lock without blocking health or stop', async () => {
      closeDatabase()
      const dbPath = join(root, 'locked.db')
      const config = loadConfig()
      config.database.path = dbPath
      initDatabase(config)
      const queuedProjectId = createProject('Queued during lock', join(root, 'queued-project')).id
      const nextProjectId = createProject('Next during lock', join(root, 'next-project')).id
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-02T00:00:00.000Z', queuedProjectId)
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-01T00:00:00.000Z', nextProjectId)
      const tasks = createTasksService({
        sessionManager: sm as unknown as import('../session/manager.js').SessionManager,
        config: loadConfig(),
        broadcast: () => {},
        configDir: join(root, 'config'),
        launchWorkflow: () => 'started',
      })
      await tasks.setSettings(queuedProjectId, { queuePaused: true })
      await tasks.setSettings(nextProjectId, { queuePaused: true })
      const queuedTask = tasks.create(queuedProjectId, { prompt: 'stay queued' }, { actor: 'human' })
      const nextTask = tasks.create(nextProjectId, { prompt: 'start next' }, { actor: 'human' })
      await tasks.move(queuedProjectId, queuedTask.id, 'in_progress', { actor: 'human' })
      await tasks.move(nextProjectId, nextTask.id, 'in_progress', { actor: 'human' })
      getDatabase()
        .prepare(`UPDATE project_task_settings SET queue_paused = 0 WHERE project_id IN (?, ?)`)
        .run(queuedProjectId, nextProjectId)

      const locker = new Database(dbPath)
      locker.pragma('busy_timeout = 0')
      locker.exec('BEGIN IMMEDIATE')
      const started = Date.now()
      let firstTick: number | undefined
      const timer = setInterval(() => {
        firstTick ??= Date.now()
      }, 10)
      setTimeout(() => {
        locker.exec('ROLLBACK')
        locker.close()
      }, 280)
      await tasks.retryQueuedLaunches()
      clearInterval(timer)

      expect(Date.now() - started).toBeGreaterThan(150)
      expect(firstTick).toBeTypeOf('number')
      expect(firstTick! - started).toBeLessThan(200)
      expect(tasks.get(queuedProjectId, queuedTask.id)).toMatchObject({ status: 'in_progress', runState: 'queued' })
      expect(tasks.get(queuedProjectId, queuedTask.id)?.activeSessionId).toBeUndefined()
      expect(tasks.get(nextProjectId, nextTask.id)).toMatchObject({ status: 'in_progress', runState: 'running' })
    })

    it('keeps a card queued when the rollback stays locked after the running write', async () => {
      closeDatabase()
      const dbPath = join(root, 'rollback-lock.db')
      const config = loadConfig()
      config.database.path = dbPath
      initDatabase(config)
      const blockedProjectId = createProject('Rollback locked', join(root, 'rollback-locked')).id
      const nextProjectId = createProject('Rollback next', join(root, 'rollback-next')).id
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-02T00:00:00.000Z', blockedProjectId)
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-01T00:00:00.000Z', nextProjectId)
      let releaseLock = () => {}
      const lockClosed = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      let locked = false
      const tasks = createTasksService({
        sessionManager: sm as unknown as import('../session/manager.js').SessionManager,
        config: loadConfig(),
        broadcast: () => {},
        configDir: join(root, 'config'),
        launchWorkflow: (sessionId) => {
          const session = sm.sessions.get(sessionId)
          if (session?.projectId === blockedProjectId && !locked) {
            locked = true
            const locker = new Database(dbPath)
            locker.pragma('busy_timeout = 0')
            locker.exec('BEGIN IMMEDIATE')
            setTimeout(() => {
              locker.exec('ROLLBACK')
              locker.close()
              releaseLock()
            }, 450)
            throw new Error('seed failed after running write')
          }
          return 'started'
        },
      })
      await tasks.setSettings(blockedProjectId, { queuePaused: true })
      await tasks.setSettings(nextProjectId, { queuePaused: true })
      const blockedTask = tasks.create(blockedProjectId, { prompt: '/default' }, { actor: 'human' })
      const nextTask = tasks.create(nextProjectId, { prompt: '/default' }, { actor: 'human' })
      await tasks.move(blockedProjectId, blockedTask.id, 'in_progress', { actor: 'human' })
      await tasks.move(nextProjectId, nextTask.id, 'in_progress', { actor: 'human' })
      getDatabase()
        .prepare(`UPDATE project_task_settings SET queue_paused = 0 WHERE project_id IN (?, ?)`)
        .run(blockedProjectId, nextProjectId)

      await tasks.retryQueuedLaunches()
      await lockClosed
      const afterFailure = tasks.get(blockedProjectId, blockedTask.id)!
      await tasks.retryQueuedLaunches()
      const afterRetry = tasks.get(blockedProjectId, blockedTask.id)!

      expect([afterFailure.runState, afterRetry.runState]).toEqual(['queued', 'running'])
      expect(afterFailure.activeSessionId).toBeUndefined()
      expect(afterFailure.sessionIds).toEqual([])
      expect(afterRetry.sessionIds).toHaveLength(1)
      expect([...sm.sessions.values()].filter((session) => session.projectId === blockedProjectId)).toHaveLength(1)
      expect(tasks.get(nextProjectId, nextTask.id)).toMatchObject({ status: 'in_progress', runState: 'running' })
      expect(tasks.get(nextProjectId, nextTask.id)!.sessionIds).toHaveLength(1)
    })

    it('deletes the fresh session once its lock clears and links one session on retry', async () => {
      closeDatabase()
      const dbPath = join(root, 'delete-lock.db')
      const config = loadConfig()
      config.database.path = dbPath
      initDatabase(config)
      initEventStore(getDatabase())
      const blockedProjectId = createProject('Delete locked', join(root, 'delete-locked')).id
      const nextProjectId = createProject('Delete next', join(root, 'delete-next')).id
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-02T00:00:00.000Z', blockedProjectId)
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-01T00:00:00.000Z', nextProjectId)
      const sessionCount = (id: string) =>
        (
          getDatabase().prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(id) as {
            n: number
          }
        ).n
      let releaseLock = () => {}
      const lockClosed = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      let locked = false
      const sessions = new SessionManager({
        getCurrentModelContext: () => 200000,
        getProviders: () => [],
      } as unknown as ConstructorParameters<typeof SessionManager>[0])
      const tasks = createTasksService({
        sessionManager: sessions,
        config: loadConfig(),
        broadcast: () => {},
        configDir: join(root, 'config'),
        launchWorkflow: (sessionId) => {
          const session = sessions.getSession(sessionId)
          if (session?.projectId === blockedProjectId && !locked) {
            locked = true
            const locker = new Database(dbPath)
            locker.pragma('busy_timeout = 0')
            locker.exec('BEGIN IMMEDIATE')
            setTimeout(() => {
              locker.exec('ROLLBACK')
              locker.close()
              releaseLock()
            }, 450)
            return 'start_failed'
          }
          return 'started'
        },
      })
      await tasks.setSettings(blockedProjectId, { queuePaused: true })
      await tasks.setSettings(nextProjectId, { queuePaused: true })
      const blockedTask = tasks.create(blockedProjectId, { prompt: '/default' }, { actor: 'human' })
      const nextTask = tasks.create(nextProjectId, { prompt: '/default' }, { actor: 'human' })
      await tasks.move(blockedProjectId, blockedTask.id, 'in_progress', { actor: 'human' })
      await tasks.move(nextProjectId, nextTask.id, 'in_progress', { actor: 'human' })
      getDatabase()
        .prepare(`UPDATE project_task_settings SET queue_paused = 0 WHERE project_id IN (?, ?)`)
        .run(blockedProjectId, nextProjectId)

      await tasks.retryQueuedLaunches()
      await lockClosed
      const afterFailure = tasks.get(blockedProjectId, blockedTask.id)!
      const failedSessions = sessionCount(blockedProjectId)
      await tasks.retryQueuedLaunches()
      const afterRetry = tasks.get(blockedProjectId, blockedTask.id)!
      const retriedSessions = sessionCount(blockedProjectId)
      const nextAfter = tasks.get(nextProjectId, nextTask.id)!

      expect([failedSessions, retriedSessions, afterFailure.sessionIds.length, afterRetry.sessionIds.length]).toEqual([
        0, 1, 0, 1,
      ])
      expect(afterFailure.runState).toBe('queued')
      expect(afterFailure.activeSessionId).toBeUndefined()
      expect(afterRetry.runState).toBe('running')
      expect(afterRetry.activeSessionId).toBe(afterRetry.sessionIds[0])
      expect(nextAfter).toMatchObject({ status: 'in_progress', runState: 'running' })
      expect(sessionCount(nextProjectId)).toBe(1)
      expect(nextAfter.sessionIds).toHaveLength(1)
      expect(nextAfter.activeSessionId).toBe(nextAfter.sessionIds[0])
    })

    it('deletes the fresh session after the delete budget expires and links one session on retry', async () => {
      closeDatabase()
      const dbPath = join(root, 'delete-budget.db')
      const config = loadConfig()
      config.database.path = dbPath
      initDatabase(config)
      initEventStore(getDatabase())
      const blockedProjectId = createProject('Budget locked', join(root, 'budget-locked')).id
      const nextProjectId = createProject('Budget next', join(root, 'budget-next')).id
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-02T00:00:00.000Z', blockedProjectId)
      getDatabase()
        .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
        .run('2020-01-01T00:00:00.000Z', nextProjectId)
      const sessionCount = (id: string) =>
        (
          getDatabase().prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(id) as {
            n: number
          }
        ).n
      let releaseLock = () => {}
      const lockClosed = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      let locked = false
      const sessions = new SessionManager({
        getCurrentModelContext: () => 200000,
        getProviders: () => [],
      } as unknown as ConstructorParameters<typeof SessionManager>[0])
      const tasks = createTasksService({
        sessionManager: sessions,
        config: loadConfig(),
        broadcast: () => {},
        configDir: join(root, 'config'),
        launchWorkflow: (sessionId) => {
          const session = sessions.getSession(sessionId)
          if (session?.projectId === blockedProjectId && !locked) {
            locked = true
            const locker = new Database(dbPath)
            locker.pragma('busy_timeout = 0')
            locker.exec('BEGIN IMMEDIATE')
            setTimeout(() => {
              locker.exec('ROLLBACK')
              locker.close()
              releaseLock()
            }, 3000)
            return 'start_failed'
          }
          return 'started'
        },
      })
      await tasks.setSettings(blockedProjectId, { queuePaused: true })
      await tasks.setSettings(nextProjectId, { queuePaused: true })
      const blockedTask = tasks.create(blockedProjectId, { prompt: '/default' }, { actor: 'human' })
      const nextTask = tasks.create(nextProjectId, { prompt: '/default' }, { actor: 'human' })
      await tasks.move(blockedProjectId, blockedTask.id, 'in_progress', { actor: 'human' })
      await tasks.move(nextProjectId, nextTask.id, 'in_progress', { actor: 'human' })
      getDatabase()
        .prepare(`UPDATE project_task_settings SET queue_paused = 0 WHERE project_id IN (?, ?)`)
        .run(blockedProjectId, nextProjectId)

      await tasks.retryQueuedLaunches()
      await lockClosed
      const afterFailure = tasks.get(blockedProjectId, blockedTask.id)!
      const failedSessions = sessionCount(blockedProjectId)
      await tasks.retryQueuedLaunches()
      const afterRetry = tasks.get(blockedProjectId, blockedTask.id)!
      const retriedSessions = sessionCount(blockedProjectId)
      const backlog = (tasks as { pendingFreshSessionDeletes?: () => number }).pendingFreshSessionDeletes?.() ?? -1

      expect([
        failedSessions,
        retriedSessions,
        afterFailure.sessionIds.length,
        afterRetry.sessionIds.length,
        afterFailure.runState,
        afterRetry.runState,
        backlog,
      ]).toEqual([0, 1, 0, 1, 'queued', 'running', 0])
      expect(afterFailure.activeSessionId).toBeUndefined()
      expect(afterRetry.activeSessionId).toBe(afterRetry.sessionIds[0])
      expect(sessionCount(nextProjectId)).toBe(1)
      expect(tasks.get(nextProjectId, nextTask.id)?.activeSessionId).toBe(
        tasks.get(nextProjectId, nextTask.id)?.sessionIds[0],
      )
    }, 20000)

    it('expands a command prompt and queues the expanded text instead of the slash line', async () => {
      const task = create('/fixme crash src/a.ts')
      const result = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })

      expect(launchSpy).not.toHaveBeenCalled()
      expect(sm.queued).toHaveLength(1)
      expect(sm.queued[0]?.sessionId).toBe(result.sessionId)
      expect(sm.queued[0]?.content).toBe('Fix the crash bug in src/a.ts.')
      expect(sm.queued[0]?.content).not.toContain('/fixme')
    })

    it('switches the seeded session to the command agentMode', async () => {
      const task = create('/fixme crash src/a.ts')
      const result = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(sm.modes.get(result.sessionId!)).toBe('builder')
    })

    it('keeps a task-selected agent when the command declares no agentMode', async () => {
      await writeFile(
        join(root, 'config', 'commands', 'plaincmd.command.md'),
        '---\nid: plaincmd\nname: Plain\n---\n\nDo {{thing}} now',
      )
      const task = create('/plaincmd stuff', { agentId: 'explorer' })
      const result = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(sm.modes.get(result.sessionId!)).toBe('explorer')
      expect(sm.queued[0]?.content).toBe('Do stuff now')
    })

    it('falls back to the raw prompt when a command leaves params unfilled', async () => {
      const task = create('/fixme crash')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(launchSpy).not.toHaveBeenCalled()
      expect(sm.queued[0]?.content).toBe('/fixme crash')
    })

    it('falls back to the raw prompt for an unknown slash id', async () => {
      const task = create('/definitely-not-a-thing some args')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(launchSpy).not.toHaveBeenCalled()
      expect(sm.queued[0]?.content).toBe('/definitely-not-a-thing some args')
    })

    it('queues plain prompts unchanged', async () => {
      const task = create('Just a regular task')
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(launchSpy).not.toHaveBeenCalled()
      expect(sm.queued[0]?.content).toBe('Just a regular task')
    })

    it('auto-launched queued tasks resolve slash commands too', async () => {
      const first = create('First')
      const second = create('/fixme crash src/a.ts')
      await service.move(projectId, first.id, 'in_progress', { actor: 'human' })
      await service.move(projectId, second.id, 'in_progress', { actor: 'human' })

      // Free the slot — second auto-launches and must seed with the expanded command.
      await service.move(projectId, first.id, 'todo', { actor: 'human' })
      expect(sm.queued.at(-1)?.content).toBe('Fix the crash bug in src/a.ts.')
      expect(sm.queued.at(-1)?.content).not.toContain('/fixme')
    })

    it('forwards task attachments to a launched workflow', async () => {
      const att: Attachment = { id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 10, data: 'hi' }
      const task = create('/fixit crash src/a.ts', { attachments: [att] })
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(launchSpy.mock.calls[0]![1].attachments).toEqual([att])
    })

    it('degrades a workflow with a missing required param to the raw prompt instead of wedging a slot', async () => {
      const task = create('/reqwf')
      const result = await service.move(projectId, task.id, 'in_progress', { actor: 'human' })

      expect(launchSpy).not.toHaveBeenCalled()
      // The task still launches (raw prompt) so no slot is wedged on a dead run.
      expect(result.task.runState).toBe('running')
      expect(sm.queued[0]?.content).toBe('/reqwf')
    })
  })

  describe('scheduled tasks', () => {
    const once = (runAt: string) => ({ type: 'once' as const, runAt })
    const recurring = (
      over: {
        startAt?: string
        end?: { kind: 'never' } | { kind: 'until'; until: string } | { kind: 'count'; count: number }
        occurrencesDone?: number
        freq?: 'day' | 'week' | 'month' | 'year'
        weekdays?: number[]
      } = {},
    ) => ({
      type: 'recurring' as const,
      freq: over.freq ?? 'day',
      interval: 1,
      ...(over.weekdays ? { weekdays: over.weekdays } : {}),
      startAt: over.startAt ?? '2030-01-01T09:00:00',
      end: over.end ?? { kind: 'never' },
      occurrencesDone: over.occurrencesDone ?? 0,
      nextRunAt: over.startAt ?? '2030-01-01T09:00:00',
    })

    it('creates a one-off scheduled task', () => {
      const task = create('Once', { schedule: once('2030-01-01T09:00:00') })
      expect(task.schedule).toMatchObject({ type: 'once', runAt: '2030-01-01T09:00:00' })
    })

    it('rejects an invalid once runAt', () => {
      expect(() => create('Once', { schedule: { type: 'once', runAt: 'not-a-date' } })).toThrow(/schedule/)
    })

    it('rejects a weekly rule with no weekdays', () => {
      expect(() => create('Weekly', { schedule: recurring({ freq: 'week', weekdays: [] }) })).toThrow(/weekday/i)
    })

    it('rejects a non-positive interval', () => {
      expect(() => create('Bad interval', { schedule: { ...recurring(), interval: 0 } })).toThrow(/interval/)
    })

    it('creates a recurring task whose first trigger is startAt', () => {
      const task = create('Recurring', { schedule: recurring() })
      expect(task.schedule?.type).toBe('recurring')
      expect(task.schedule).toMatchObject({ occurrencesDone: 0, nextRunAt: '2030-01-01T09:00:00' })
    })

    it('duplicate copies the schedule', () => {
      const task = create('Once', { schedule: once('2030-01-01T09:00:00') })
      const copy = service.duplicate(projectId, task.id, { actor: 'human' })
      expect(copy.schedule).toMatchObject({ type: 'once', runAt: '2030-01-01T09:00:00' })
    })

    it('editing the schedule replaces it and resets the occurrence counter', async () => {
      const task = create('Recurring', { schedule: recurring({ occurrencesDone: 2 }) })
      const result = await service.update(
        projectId,
        task.id,
        { schedule: recurring({ startAt: '2031-06-01T09:00:00' }) },
        { actor: 'human' },
      )
      expect(result.conflict).toBe(false)
      expect(result.task.schedule).toMatchObject({ occurrencesDone: 0, nextRunAt: '2031-06-01T09:00:00' })
    })

    it('update can clear the schedule', async () => {
      const task = create('Once', { schedule: once('2030-01-01T09:00:00') })
      const result = await service.update(projectId, task.id, { schedule: null }, { actor: 'human' })
      expect(result.task.schedule).toBeUndefined()
    })

    it('manual move to In Progress clears the schedule', async () => {
      const task = create('Once', { schedule: once('2030-01-01T09:00:00') })
      await service.move(projectId, task.id, 'in_progress', { actor: 'human' })
      expect(service.get(projectId, task.id)!.schedule).toBeUndefined()
    })

    it('manual move to Done clears the schedule', async () => {
      const task = create('Once', { schedule: once('2030-01-01T09:00:00') })
      await service.move(projectId, task.id, 'done', { actor: 'human' })
      expect(service.get(projectId, task.id)!.schedule).toBeUndefined()
    })
  })

  describe('runScheduled', () => {
    it('triggers a due one-off task: runs it, clears the schedule, seeds a session', async () => {
      const task = create('Due once', { schedule: { type: 'once', runAt: '2020-01-01T09:00:00' } })
      await service.runScheduled()
      const fresh = service.get(projectId, task.id)!
      expect(fresh.status).toBe('in_progress')
      expect(fresh.runState).toBe('running')
      expect(fresh.schedule).toBeUndefined()
      expect(sm.createdSessions).toHaveLength(1)
      expect(sm.queued[0]?.content).toBe('Due once')
    })

    it('ignores tasks that are not due yet', async () => {
      const task = create('Later', { schedule: { type: 'once', runAt: '2099-01-01T09:00:00' } })
      await service.runScheduled()
      expect(service.get(projectId, task.id)!.status).toBe('todo')
      expect(sm.createdSessions).toHaveLength(0)
    })

    it('spawns a single run for a due recurring template and advances it', async () => {
      const task = create('Recurring', {
        schedule: {
          type: 'recurring',
          freq: 'day',
          interval: 1,
          startAt: '2020-01-01T09:00:00',
          end: { kind: 'never' },
          occurrencesDone: 0,
          nextRunAt: '2020-01-01T09:00:00',
        },
      })
      await service.runScheduled()

      const template = service.get(projectId, task.id)!
      expect(template.status).toBe('todo') // template never leaves To Do
      const sched = template.schedule as Extract<NonNullable<typeof template.schedule>, { type: 'recurring' }>
      expect(sched.occurrencesDone).toBe(1)
      expect(new Date(sched.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 2000)

      const runs = service.list(projectId).filter((t) => t.id !== task.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('in_progress')
      expect(runs[0]!.schedule).toBeUndefined() // the run is a plain task
      expect(sm.createdSessions).toHaveLength(1)
    })

    it('only spawns one run even when several intervals were missed while off', async () => {
      const task = create('Way overdue', {
        schedule: {
          type: 'recurring',
          freq: 'day',
          interval: 1,
          startAt: '2020-01-01T09:00:00',
          end: { kind: 'never' },
          occurrencesDone: 0,
          nextRunAt: '2020-01-01T09:00:00',
        },
      })
      await service.runScheduled()
      const runs = service.list(projectId).filter((t) => t.id !== task.id)
      expect(runs).toHaveLength(1)
      const template = service.get(projectId, task.id)!
      const sched = template.schedule as Extract<NonNullable<typeof template.schedule>, { type: 'recurring' }>
      expect(sched.occurrencesDone).toBe(1)
    })

    it('clears the template schedule once the count of occurrences is exhausted', async () => {
      const task = create('One more', {
        schedule: {
          type: 'recurring',
          freq: 'day',
          interval: 1,
          startAt: '2020-01-01T09:00:00',
          end: { kind: 'count', count: 1 },
          occurrencesDone: 0,
          nextRunAt: '2020-01-01T09:00:00',
        },
      })
      await service.runScheduled()
      const template = service.get(projectId, task.id)!
      expect(template.schedule).toBeUndefined()
      // the final occurrence still ran
      expect(service.list(projectId).filter((t) => t.id !== task.id)).toHaveLength(1)
    })

    it('a recurring template queued behind a full slot still advances its next run', async () => {
      const blocker = create('Blocker')
      await service.move(projectId, blocker.id, 'in_progress', { actor: 'human' }) // slot full
      const task = create('Queued spawn', {
        schedule: {
          type: 'recurring',
          freq: 'day',
          interval: 1,
          startAt: '2020-01-01T09:00:00',
          end: { kind: 'never' },
          occurrencesDone: 0,
          nextRunAt: '2020-01-01T09:00:00',
        },
      })
      await service.runScheduled()

      const template = service.get(projectId, task.id)!
      const sched = template.schedule as Extract<NonNullable<typeof template.schedule>, { type: 'recurring' }>
      expect(sched.occurrencesDone).toBe(1)
      const spawned = service.list(projectId).find((t) => t.id !== task.id && t.id !== blocker.id)!
      expect(spawned.status).toBe('in_progress')
      expect(spawned.runState).toBe('queued')
    })

    it('removes the refused occurrence and its session without advancing the template', async () => {
      launchSpy.mockReturnValueOnce('start_failed').mockReturnValue('started')
      const template = create('/default', {
        schedule: {
          type: 'recurring',
          freq: 'day',
          interval: 1,
          startAt: '2020-01-01T09:00:00',
          end: { kind: 'never' },
          occurrencesDone: 0,
          nextRunAt: '2020-01-01T09:00:00',
        },
      })

      await service.runScheduled()

      expect(service.list(projectId).map((task) => task.id)).toEqual([template.id])
      expect([...sm.sessions.keys()]).toEqual([])
      expect(sm.reminders).toEqual([])
      const held = service.get(projectId, template.id)!.schedule as Extract<
        NonNullable<typeof template.schedule>,
        { type: 'recurring' }
      >
      expect(held.occurrencesDone).toBe(0)
      expect(held.nextRunAt).toBe('2020-01-01T09:00:00')

      await service.runScheduled()

      const runs = service.list(projectId).filter((task) => task.id !== template.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ status: 'in_progress', runState: 'running' })
      expect([...sm.sessions.keys()]).toEqual(runs[0]!.sessionIds)
      expect(runs[0]!.sessionIds).toHaveLength(1)
      const advanced = service.get(projectId, template.id)!.schedule as typeof held
      expect(advanced.occurrencesDone).toBe(1)
    })
  })
})
