import { afterEach, describe, expect, it } from 'vitest'
import {
  SessionRuntimeRegistry,
  getSessionRuntimeRegistry,
  resetSessionRuntimeRegistry,
  setSessionRuntimeRegistry,
} from './runtime.js'
import { createDiagnosticsCollector } from '../diagnostics/collector.js'

describe('SessionRuntime integration', () => {
  afterEach(() => {
    resetSessionRuntimeRegistry()
  })

  it('shares one runtime per session across registry consumers', () => {
    const registry = new SessionRuntimeRegistry()
    setSessionRuntimeRegistry(registry)

    const a = getSessionRuntimeRegistry().get('sess-1')
    const b = getSessionRuntimeRegistry().get('sess-1')
    expect(a).toBe(b)

    a.acquire('chat')
    expect(b.snapshot().state).toBe('running')
  })

  it('exposes runtimes through the diagnostics collector', () => {
    const registry = new SessionRuntimeRegistry()
    const collector = createDiagnosticsCollector({
      runtimeRegistry: registry,
      intervalMs: 1_000,
      enableLoopSampler: false,
    })

    const idle = registry.get('sess-idle')
    idle.recordCommand('pause')

    const running = registry.get('sess-run')
    running.acquire('workflow')

    const data = collector.getData()
    expect(data.runtimes).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-idle', state: 'idle', lastCommand: 'pause' },
        { sessionId: 'sess-run', state: 'workflow', lastCommand: 'workflow' },
      ]),
    )
  })

  it('reports paused state only when the cooperative pause gate is paused', () => {
    let pauseState: import('../../shared/types.js').PauseState = 'none'
    const registry = new SessionRuntimeRegistry({ getPauseState: () => pauseState })
    const runtime = registry.get('sess-1')
    runtime.acquire('chat')

    expect(runtime.snapshot().state).toBe('running')

    pauseState = 'paused'
    expect(runtime.snapshot().state).toBe('paused')

    pauseState = 'none'
    expect(runtime.snapshot().state).toBe('running')
  })

  it('stays in stopping until the aborted work releases, then allows relaunch', async () => {
    const registry = new SessionRuntimeRegistry()
    const runtime = registry.get('sess-1')
    const handle = runtime.acquire('chat')

    expect(runtime.stop()).toBe(true)
    expect(handle.signal.aborted).toBe(true)
    expect(runtime.snapshot().state).toBe('stopping')
    expect(() => runtime.acquire('chat')).toThrow('Session is stopping')

    const settled = runtime.awaitSettled()
    expect(runtime.release(handle)).toBe(true)
    await settled

    expect(runtime.snapshot().state).toBe('idle')
    const next = runtime.acquire('chat')
    expect(next.generation).toBe(2)
    expect(next.controller).not.toBe(handle.controller)
  })

  it('removes a runtime so a deleted session leaves no ghost entry', () => {
    const registry = new SessionRuntimeRegistry()
    registry.get('gone').acquire('chat')
    expect(registry.list()).toHaveLength(1)

    registry.remove('gone')
    expect(registry.list()).toEqual([])
    expect(registry.peek('gone')).toBeUndefined()
  })
})
