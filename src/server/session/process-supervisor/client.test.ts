import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('correlates child cleanup results through the supervisor', async () => {
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })
    const started = supervisor.start()
    child.emit('message', { type: 'ready', pid: 41 })
    await started

    const result = supervisor.cleanupWorkerChildren('/tmp/worker.children')
    const request = child.send.mock.calls.find(([message]) => message.type === 'children.cleanup')![0]
    child.emit('message', {
      type: 'children.cleanup.result',
      requestId: request.requestId,
      killedChildren: [99],
    })

    await expect(result).resolves.toEqual([99])
  })

  it('keeps an HTTP witness responsive while cleanup blocks in the supervisor process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-supervisor-cleanup-'))
    const entry = join(root, 'fixture.cjs')
    writeFileSync(
      entry,
      `
process.send({ type: 'ready', pid: process.pid })
process.on('message', (message) => {
  if (message.type === 'children.cleanup') {
    const until = Date.now() + 1500
    while (Date.now() < until) {}
    process.send({ type: 'children.cleanup.result', requestId: message.requestId, killedChildren: [] })
  }
  if (message.type === 'shutdown') {
    process.send({ type: 'shutdown.complete' })
    process.exit(0)
  }
})
`,
    )
    const supervisor = new SessionProcessSupervisor({ entry: { path: entry, execArgv: [] } })
    const witness = createServer((_request, response) => response.end('ok'))
    await new Promise<void>((resolve) => witness.listen(0, '127.0.0.1', resolve))
    const address = witness.address()
    if (!address || typeof address === 'string') throw new Error('HTTP witness did not bind')

    try {
      await supervisor.start()
      let cleanupSettled = false
      const cleanup = supervisor.cleanupWorkerChildren('/tmp/worker.children').finally(() => {
        cleanupSettled = true
      })
      const response = await fetch(`http://127.0.0.1:${address.port}`)
      expect(await response.text()).toBe('ok')
      expect(cleanupSettled).toBe(false)
      await expect(cleanup).resolves.toEqual([])
    } finally {
      await supervisor.shutdown()
      await new Promise<void>((resolve, reject) => witness.close((error) => (error ? reject(error) : resolve())))
      rmSync(root, { recursive: true, force: true })
    }
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
