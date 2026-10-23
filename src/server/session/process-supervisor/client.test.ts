import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { SessionProcessSupervisor } from './client.js'

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 41,
    connected: true,
    send: vi.fn(),
    kill: vi.fn(() => true),
    stdin: { end: vi.fn() },
    exitCode: null,
    signalCode: null,
  })
  return child as unknown as ChildProcess & {
    send: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
}

describe('SessionProcessSupervisor', () => {
  it('waits for readiness before completing bootstrap', async () => {
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })

    const started = supervisor.start()
    expect(child.send).not.toHaveBeenCalled()
    child.emit('message', { type: 'ready', pid: 41 })
    await expect(started).resolves.toBeUndefined()
    expect(supervisor.isReady()).toBe(true)
  })

  it('rejects bootstrap when the supervisor exits before readiness', async () => {
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })

    const started = supervisor.start()
    child.emit('exit', 1, null)
    await expect(started).rejects.toThrow(/before readiness/i)
    expect(supervisor.isReady()).toBe(false)
  })

  it('relays worker lifecycle without forking from the gateway', async () => {
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })
    const started = supervisor.start()
    child.emit('message', { type: 'ready', pid: 41 })
    await started

    const handle = supervisor.spawnWorker({
      workerKey: 'worker-1',
      path: '/worker.js',
      execArgv: [],
      env: { TEST: '1' },
    })
    const messages: unknown[] = []
    const exits: unknown[] = []
    handle.on('message', (message) => messages.push(message))
    handle.on('exit', (code, signal) => exits.push([code, signal]))

    const spawnRequest = child.send.mock.calls.find(([message]) => message.type === 'worker.spawn')![0]
    child.emit('message', {
      type: 'worker.spawned',
      requestId: spawnRequest.requestId,
      workerKey: 'worker-1',
      pid: 99,
    })
    child.emit('message', { type: 'worker.message', workerKey: 'worker-1', message: { type: 'ready' } })
    handle.send({ type: 'start' })
    handle.kill('SIGTERM')
    child.emit('message', { type: 'worker.exit', workerKey: 'worker-1', code: 0, signal: null })

    expect(handle.pid).toBe(99)
    expect(messages).toEqual([{ type: 'ready' }])
    expect(exits).toEqual([[0, null]])
    expect(child.send).toHaveBeenCalledWith({
      type: 'worker.send',
      workerKey: 'worker-1',
      message: { type: 'start' },
    })
    expect(child.send).toHaveBeenCalledWith({ type: 'worker.kill', workerKey: 'worker-1', signal: 'SIGTERM' })
  })

  it('correlates native git results through the supervisor', async () => {
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })
    const started = supervisor.start()
    child.emit('message', { type: 'ready', pid: 41 })
    await started

    const result = supervisor.runGit('/repo', ['status'])
    const request = child.send.mock.calls.find(([message]) => message.type === 'git.run')![0]
    child.emit('message', {
      type: 'git.result',
      requestId: request.requestId,
      code: 0,
      stdout: 'clean',
    })

    await expect(result).resolves.toEqual({ code: 0, stdout: 'clean' })
  })
})
