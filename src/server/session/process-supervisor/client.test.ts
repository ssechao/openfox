import { EventEmitter } from 'node:events'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { initChildrenTracking } from '../worker/children.js'
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
    const signalProcess = vi.fn((_pid: number, _signal?: string | number) => true as const)
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
      signalProcess,
      readProcessIdentity: async () => ({ status: 'found', identity: 'linux:99' }),
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
    const stdout: string[] = []
    const stderr: string[] = []
    const exits: unknown[] = []
    handle.on('message', (message) => messages.push(message))
    handle.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    handle.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    handle.on('exit', (code, signal) => exits.push([code, signal]))

    const spawnRequest = child.send.mock.calls.find(([message]) => message.type === 'worker.spawn')![0]
    child.emit('message', {
      type: 'worker.spawned',
      requestId: spawnRequest.requestId,
      workerKey: 'worker-1',
      pid: 99,
      inventory: { pid: 99, startedAt: 'linux:99', pgid: 99 },
    })
    child.emit('message', { type: 'worker.message', workerKey: 'worker-1', message: { type: 'ready' } })
    child.emit('message', { type: 'worker.stdout', workerKey: 'worker-1', chunk: 'worker output\n' })
    child.emit('message', { type: 'worker.stderr', workerKey: 'worker-1', chunk: 'worker error\n' })
    handle.send({ type: 'start' })
    await handle.killVerified('SIGTERM', Date.now() + 1_000)
    child.emit('message', { type: 'worker.exit', workerKey: 'worker-1', code: 0, signal: null })

    expect(handle.pid).toBe(99)
    expect(messages).toEqual([{ type: 'ready' }])
    expect(stdout).toEqual(['worker output\n'])
    expect(stderr).toEqual(['worker error\n'])
    expect(exits).toEqual([[0, null]])
    expect(child.send).toHaveBeenCalledWith({
      type: 'worker.send',
      workerKey: 'worker-1',
      message: { type: 'start' },
    })
    expect(signalProcess).toHaveBeenCalledWith(99, 'SIGTERM')
    expect(child.send).not.toHaveBeenCalledWith({ type: 'worker.kill', workerKey: 'worker-1', signal: 'SIGTERM' })
  })

  it('stop before inventory capture still terminates the worker', async () => {
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
      workerKey: 'worker-stopping-before-inventory',
      path: '/worker.js',
      execArgv: [],
      env: process.env,
    })

    await expect(handle.killVerified('SIGTERM', Date.now() + 1_000)).resolves.toBeUndefined()
    expect(child.send).toHaveBeenCalledWith({
      type: 'worker.kill',
      workerKey: 'worker-stopping-before-inventory',
      signal: 'SIGTERM',
    })
  })

  it('slow identity read on SIGTERM leaves a SIGKILL budget', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
      readProcessIdentity: () => new Promise(() => {}),
    })
    const started = supervisor.start()
    child.emit('message', { type: 'ready', pid: 41 })
    await started
    const handle = supervisor.spawnWorker({
      workerKey: 'slow-identity-worker',
      path: '/worker.js',
      execArgv: [],
      env: process.env,
    })
    const spawnRequest = child.send.mock.calls.find(([message]) => message.type === 'worker.spawn')![0]
    child.emit('message', {
      type: 'worker.spawned',
      requestId: spawnRequest.requestId,
      workerKey: 'slow-identity-worker',
      pid: 99,
      inventory: { pid: 99, startedAt: 'linux:99', pgid: 99 },
    })

    try {
      const stopStartedAt = Date.now()
      const term = handle.killVerified('SIGTERM', stopStartedAt + 500)
      await vi.advanceTimersByTimeAsync(500)
      await expect(term).resolves.toBeUndefined()

      const kill = handle.killVerified('SIGKILL', stopStartedAt + 1_000)
      await vi.advanceTimersByTimeAsync(500)
      await expect(kill).resolves.toBeUndefined()
      expect(child.send).toHaveBeenCalledWith({
        type: 'worker.kill',
        workerKey: 'slow-identity-worker',
        signal: 'SIGKILL',
      })
      expect(Date.now()).toBeLessThan(stopStartedAt + 2_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses signaling when spawn identity is absent or the handle already exited', async () => {
    const child = fakeChild()
    const signalProcess = vi.fn((_pid: number, _signal?: string | number) => true as const)
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
      signalProcess,
      readProcessIdentity: async () => ({ status: 'found', identity: 'linux:99' }),
    })
    const started = supervisor.start()
    child.emit('message', { type: 'ready', pid: 41 })
    await started
    const missing = supervisor.spawnWorker({
      workerKey: 'worker-missing',
      path: '/worker.js',
      execArgv: [],
      env: process.env,
    })
    const missingRequest = child.send.mock.calls.find(
      ([message]) => message.type === 'worker.spawn' && message.workerKey === 'worker-missing',
    )![0]
    child.emit('message', {
      type: 'worker.spawned',
      requestId: missingRequest.requestId,
      workerKey: 'worker-missing',
      pid: 98,
    })
    await expect(missing.killVerified('SIGTERM', Date.now() + 1_000)).rejects.toThrow(/identity.*unavailable/i)

    const exited = supervisor.spawnWorker({
      workerKey: 'worker-exited',
      path: '/worker.js',
      execArgv: [],
      env: process.env,
    })
    const exitedRequest = child.send.mock.calls.find(
      ([message]) => message.type === 'worker.spawn' && message.workerKey === 'worker-exited',
    )![0]
    child.emit('message', {
      type: 'worker.spawned',
      requestId: exitedRequest.requestId,
      workerKey: 'worker-exited',
      pid: 99,
      inventory: { pid: 99, startedAt: 'linux:99', pgid: 99 },
    })
    child.emit('message', { type: 'worker.exit', workerKey: 'worker-exited', code: 0, signal: null })
    await expect(exited.killVerified('SIGKILL', Date.now() + 1_000)).rejects.toThrow(/already exited/i)
    expect(signalProcess).not.toHaveBeenCalled()
  })

  it('refuses to signal a reused PID whose start identity changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-supervisor-reused-pid-'))
    const workerEntry = join(root, 'foreign.cjs')
    writeFileSync(workerEntry, `setInterval(() => {}, 1000)\n`)
    const foreign = fork(workerEntry, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })

    try {
      const started = supervisor.start()
      child.emit('message', { type: 'ready', pid: 41 })
      await started
      const handle = supervisor.spawnWorker({
        workerKey: 'worker-reused',
        path: '/worker.js',
        execArgv: [],
        env: process.env,
      })
      const request = child.send.mock.calls.find(([message]) => message.type === 'worker.spawn')![0]
      child.emit('message', {
        type: 'worker.spawned',
        requestId: request.requestId,
        workerKey: 'worker-reused',
        pid: foreign.pid,
        inventory: { pid: foreign.pid, startedAt: 'reused:original-worker', pgid: foreign.pid },
      })

      await expect(handle.killVerified('SIGKILL', Date.now() + 1_000)).rejects.toThrow(/identity.*changed/i)
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow()
    } finally {
      foreign.kill('SIGKILL')
      await new Promise<void>((resolve) => foreign.once('exit', () => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('signals a second worker while the supervisor event loop is blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-supervisor-priority-kill-'))
    const entry = join(root, 'fixture.cjs')
    const workerEntry = join(root, 'worker.cjs')
    const stoppedPath = join(root, 'worker-2-stopped')
    writeFileSync(
      workerEntry,
      `process.on('SIGTERM', () => {
  if (process.env.STOPPED_PATH) require('node:fs').writeFileSync(process.env.STOPPED_PATH, '')
  process.exit(0)
})
process.send('ready')
setInterval(() => {}, 1000)
`,
    )
    writeFileSync(
      entry,
      `
const { fork } = require('node:child_process')
const workers = new Map()
process.send({ type: 'ready', pid: process.pid })
process.on('message', (message) => {
  if (message.type === 'worker.spawn') {
    const worker = fork(message.path, [], { env: message.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    workers.set(message.workerKey, worker)
    process.send({
      type: 'worker.spawned',
      requestId: message.requestId,
      workerKey: message.workerKey,
      pid: worker.pid,
      inventory: { pid: worker.pid, startedAt: message.workerKey, pgid: worker.pid },
    })
    worker.on('message', (payload) => {
      process.send({ type: 'worker.message', workerKey: message.workerKey, message: payload })
    })
    worker.on('exit', (code, signal) => {
      workers.delete(message.workerKey)
      process.send({ type: 'worker.exit', workerKey: message.workerKey, code, signal })
    })
  }
  if (message.type === 'children.cleanup') {
    const until = Date.now() + 3000
    while (Date.now() < until) {}
    process.send({ type: 'children.cleanup.result', requestId: message.requestId, killedChildren: [] })
  }
  if (message.type === 'shutdown') {
    for (const worker of workers.values()) worker.kill('SIGKILL')
    process.send({ type: 'shutdown.complete' })
    process.exit(0)
  }
})
`,
    )
    const supervisor = new SessionProcessSupervisor({
      entry: { path: entry, execArgv: [] },
      readProcessIdentity: async () => ({ status: 'found', identity: 'worker-2' }),
    })

    try {
      await supervisor.start()
      const first = supervisor.spawnWorker({
        workerKey: 'worker-1',
        path: workerEntry,
        execArgv: [],
        env: process.env,
      })
      const second = supervisor.spawnWorker({
        workerKey: 'worker-2',
        path: workerEntry,
        execArgv: [],
        env: { ...process.env, STOPPED_PATH: stoppedPath },
      })
      await Promise.all([
        new Promise<void>((resolve) => first.on('message', () => resolve())),
        new Promise<void>((resolve) => second.on('message', () => resolve())),
      ])

      const cleanup = supervisor.cleanupWorkerChildren('/tmp/worker.children')
      const startedAt = Date.now()
      await expect(second.killVerified('SIGTERM', Date.now() + 1_000)).resolves.toBeUndefined()
      await vi.waitFor(
        () => {
          expect(existsSync(stoppedPath)).toBe(true)
        },
        { timeout: 1_900 },
      )
      expect(Date.now() - startedAt).toBeLessThanOrEqual(2_000)
      await cleanup
    } finally {
      await supervisor.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

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

  it('rejects an inventory capture that misses its absolute deadline', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const supervisor = new SessionProcessSupervisor({
      forkProcess: vi.fn(() => child),
      entry: { path: '/supervisor.js', execArgv: [] },
      startupTimeoutMs: 100,
    })
    const started = supervisor.start()
    child.emit('message', { type: 'ready', pid: 41 })
    await started

    try {
      const capture = supervisor.captureWorkerInventory(
        99,
        '/tmp/worker.children',
        undefined,
        Date.now(),
        Date.now() + 100,
      )
      const rejected = expect(capture).rejects.toThrow(/capture exceeded recovery deadline/i)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
    } finally {
      vi.useRealTimers()
    }
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

  it('keeps an HTTP witness responsive while inventory verification blocks in the supervisor process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-supervisor-verify-'))
    const entry = join(root, 'fixture.cjs')
    writeFileSync(
      entry,
      `
process.send({ type: 'ready', pid: process.pid })
process.on('message', (message) => {
  if (message.type === 'children.verify') {
    const until = Date.now() + 1500
    while (Date.now() < until) {}
    process.send({
      type: 'children.verify.result',
      requestId: message.requestId,
      orphanCheck: {
        checkedAt: message.inventory.capturedAt + 2000,
        clean: true,
        survivingIdentities: [],
        survivingGroups: [],
        liveReservations: [],
        errors: [],
      },
    })
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
      let verificationSettled = false
      const verification = supervisor
        .verifyWorkerInventory({
          capturedAt: Date.now() - 2_000,
          children: [],
          groups: [],
          reservations: [],
          errors: [],
        })
        .finally(() => {
          verificationSettled = true
        })
      const response = await fetch(`http://127.0.0.1:${address.port}`)
      expect(await response.text()).toBe('ok')
      expect(verificationSettled).toBe(false)
      await expect(verification).resolves.toMatchObject({ clean: true })
    } finally {
      await supervisor.shutdown()
      await new Promise<void>((resolve, reject) => witness.close((error) => (error ? reject(error) : resolve())))
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('captures worker identity at spawn and anchors inventory through the real supervisor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openfox-supervisor-inventory-'))
    const workerEntry = join(root, 'worker.cjs')
    const childrenPath = join(root, 'worker.children')
    writeFileSync(workerEntry, `process.send({ type: 'ready' }); setInterval(() => {}, 1000)\n`)
    initChildrenTracking(childrenPath)
    const supervisor = new SessionProcessSupervisor()

    try {
      await supervisor.start()
      const handle = supervisor.spawnWorker({
        workerKey: 'inventory-worker',
        path: workerEntry,
        execArgv: [],
        env: process.env,
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker readiness timed out')), 5_000)
        handle.on('message', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      expect(handle.inventory).toMatchObject({
        pid: handle.pid,
        startedAt: expect.any(String),
        pgid: expect.any(Number),
      })
      const capturedAt = Date.now() - 250
      const inventory = await supervisor.captureWorkerInventory(handle.pid!, childrenPath, handle.inventory, capturedAt)
      expect(inventory).toMatchObject({
        capturedAt,
        worker: handle.inventory,
        errors: [],
      })
      await handle.killVerified('SIGKILL', Date.now() + 1_000)
      await new Promise<void>((resolve) => handle.once('exit', () => resolve()))
    } finally {
      await supervisor.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

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
