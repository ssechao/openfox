import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PauseState } from '../../shared/types.js'
import {
  SessionAlreadyRunningError,
  SessionRuntime,
  SessionRuntimeRegistry,
  resetSessionRuntimeRegistry,
  type ExecutionHandle,
  type RuntimeKind,
} from './runtime.js'

afterEach(() => {
  resetSessionRuntimeRegistry()
})

function expectRunningError(fn: () => unknown, message = 'Session is already running'): SessionAlreadyRunningError {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SessionAlreadyRunningError)
  const typed = caught as SessionAlreadyRunningError
  expect(typed.status).toBe(409)
  expect(typed.code).toBe('SESSION_ALREADY_RUNNING')
  expect(typed.message).toBe(message)
  return typed
}

describe('SessionRuntime acquire', () => {
  it('acquires a fresh root controller per turn and records lastCommand from the kind', () => {
    const runtime = new SessionRuntime('sess-1')
    const first = runtime.acquire('chat')
    expect(first.generation).toBe(1)
    expect(first.controller.signal.aborted).toBe(false)
    expect(runtime.snapshot()).toEqual({ sessionId: 'sess-1', state: 'running', lastCommand: 'launch' })

    expect(runtime.release(first)).toBe(true)
    const second = runtime.acquire('chat')
    expect(second.generation).toBe(2)
    expect(second.controller).not.toBe(first.controller)
    expect(first.controller.signal.aborted).toBe(false)
  })

  it('refuses a second acquire from a different path with an explicit 409', () => {
    const runtime = new SessionRuntime('sess-1')
    const chat = runtime.acquire('chat')
    expectRunningError(() => runtime.acquire('workflow'))
    expectRunningError(() => runtime.acquire('compact'))
    expect(runtime.currentHandle()?.controller).toBe(chat.controller)
    expect(runtime.snapshot().state).toBe('running')
  })

  it('maps compact and workflow kinds onto diagnostic states', () => {
    const runtime = new SessionRuntime('sess-1')
    const compact = runtime.acquire('compact')
    expect(runtime.snapshot()).toMatchObject({ state: 'compacting', lastCommand: 'compact' })
    runtime.release(compact)
    runtime.acquire('workflow')
    expect(runtime.snapshot()).toMatchObject({ state: 'workflow', lastCommand: 'workflow' })
  })

  it('exposes paused only when the cooperative gate is actually paused', () => {
    let pauseState: PauseState = 'pending'
    const runtime = new SessionRuntime('sess-1', { getPauseState: () => pauseState })
    runtime.acquire('chat')
    expect(runtime.snapshot().state).toBe('running')
    pauseState = 'paused'
    expect(runtime.snapshot().state).toBe('paused')
  })
})

describe('SessionRuntime stop and late finally', () => {
  it('holds stopping until the aborted work releases, then allows relaunch', async () => {
    const runtime = new SessionRuntime('sess-1')
    const handle = runtime.acquire('chat')
    expect(runtime.stop()).toBe(true)
    expect(handle.controller.signal.aborted).toBe(true)
    expect(runtime.snapshot().state).toBe('stopping')
    expect(runtime.snapshot().lastCommand).toBe('stop')
    expectRunningError(() => runtime.acquire('workflow'), 'Session is stopping')

    const settled = runtime.awaitSettled()
    expect(runtime.release(handle)).toBe(true)
    await settled
    expect(runtime.snapshot().state).toBe('idle')

    const next = runtime.acquire('chat')
    expect(next.generation).toBe(2)
    expect(next.controller).not.toBe(handle.controller)
    expect(next.controller.signal.aborted).toBe(false)
  })

  it('ignores a late finally from the old run so it cannot clean up the new one', () => {
    const runtime = new SessionRuntime('sess-1')
    const oldHandle = runtime.acquire('chat')
    runtime.stop()
    expect(runtime.release(oldHandle)).toBe(true)

    const next = runtime.acquire('chat')
    const abortSpy = vi.spyOn(next.controller, 'abort')
    expect(runtime.release(oldHandle)).toBe(false)
    expect(runtime.isCurrent(next)).toBe(true)
    expect(next.controller.signal.aborted).toBe(false)
    expect(abortSpy).not.toHaveBeenCalled()
    expect(runtime.snapshot().state).toBe('running')
  })

  it('does not reuse an aborted controller on the next turn', () => {
    const runtime = new SessionRuntime('sess-1')
    const first = runtime.acquire('chat')
    runtime.stop()
    runtime.release(first)
    const second = runtime.acquire('compact')
    expect(second.controller.signal.aborted).toBe(false)
    expect(first.controller.signal.aborted).toBe(true)
  })
})

describe('SessionRuntimeRegistry', () => {
  it('is one runtime per sessionId and lists snapshots for diagnostics', () => {
    const registry = new SessionRuntimeRegistry()
    const a = registry.get('a')
    expect(registry.get('a')).toBe(a)
    a.acquire('chat')
    registry.get('b').recordCommand('pause')
    expect(registry.list()).toEqual([
      { sessionId: 'a', state: 'running', lastCommand: 'launch' },
      { sessionId: 'b', state: 'idle', lastCommand: 'pause' },
    ])
  })

  it('drops the runtime on remove so DELETE leaves no ghost', () => {
    const registry = new SessionRuntimeRegistry()
    const runtime = registry.get('gone')
    runtime.acquire('chat')
    registry.remove('gone')
    expect(registry.list()).toEqual([])
    expect(registry.peek('gone')).toBeUndefined()
    expectRunningError(() => runtime.acquire('chat'), 'Session is stopping')
  })
})

describe('queue vs stop contract (unit stand-in for QueueProcessor)', () => {
  it('starts exactly one follow-up turn after a normal finish when a message is queued', () => {
    const runtime = new SessionRuntime('sess-1')
    const queue = ['first', 'second']
    const launched: string[] = []
    let stopClearedQueue = false

    const startTurn = (source: string) => {
      const handle = runtime.acquire('chat')
      launched.push(source)
      queue.shift()
      return handle
    }

    const finish = (handle: ExecutionHandle, outcome: 'success' | 'stop') => {
      if (!runtime.release(handle)) return
      if (outcome === 'stop' || stopClearedQueue) return
      if (queue.length > 0) startTurn('follow-up')
    }

    const first = startTurn('initial')
    expect(queue).toEqual(['second'])
    finish(first, 'success')
    expect(launched).toEqual(['initial', 'follow-up'])
    expect(runtime.snapshot().state).toBe('running')
  })

  it('Stop drains the queue and does not start a follow-up turn', () => {
    const runtime = new SessionRuntime('sess-1')
    const queue = ['first', 'queued']
    const launched: string[] = []

    const startTurn = () => {
      const handle = runtime.acquire('chat')
      launched.push(queue.shift()!)
      return handle
    }

    const handle = startTurn()
    runtime.stop()
    queue.length = 0
    if (runtime.release(handle) && queue.length > 0) startTurn()
    expect(launched).toEqual(['first'])
    expect(runtime.snapshot().state).toBe('idle')
    expect(queue).toEqual([])
  })
})

describe('concurrent path helper', () => {
  it('lets only one of chat/workflow/compact win when they race', () => {
    const runtime = new SessionRuntime('sess-1')
    const kinds: RuntimeKind[] = ['chat', 'workflow', 'compact']
    const winners: ExecutionHandle[] = []
    const losers: string[] = []
    for (const kind of kinds) {
      try {
        winners.push(runtime.acquire(kind))
      } catch (error) {
        expect(error).toBeInstanceOf(SessionAlreadyRunningError)
        losers.push((error as Error).message)
      }
    }
    expect(winners).toHaveLength(1)
    expect(winners[0]!.kind).toBe('chat')
    expect(losers).toEqual(['Session is already running', 'Session is already running'])
    expect(runtime.currentHandle()?.controller).toBe(winners[0]!.controller)
  })
})
