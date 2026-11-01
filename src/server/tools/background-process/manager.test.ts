import { afterEach, describe, expect, it } from 'vitest'
import { executeBackgroundAction } from './actions.js'
import {
  createProcess,
  destroySessionProcesses,
  getSessionProcesses,
  onProcessEvent,
  startProcessCommand,
  stopProcess,
} from './manager.js'
import { cleanupAllProcesses, closeBackgroundAdmission, reopenBackgroundAdmission } from './store.js'

describe('background process manager', () => {
  afterEach(async () => {
    await cleanupAllProcesses()
    reopenBackgroundAdmission()
  })

  it('destroys a running process before cleanupAllProcesses resolves', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'sleep', 'sleep 60', process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    expect(() => process.kill(pid, 0)).not.toThrow()
    await cleanupAllProcesses()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('kills a TERM-ignoring process before cleanupAllProcesses resolves', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'term-ignoring', "trap '' TERM; sleep 60", process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await cleanupAllProcesses()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('waits for a process already stopping when cleanupAllProcesses runs', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'term-ignoring', "trap '' TERM; sleep 60", process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    await new Promise((resolve) => setTimeout(resolve, 200))
    const stopping = stopProcess(backgroundProcess.id, sessionId)
    await cleanupAllProcesses()
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(stopping).resolves.toBeUndefined()
  })

  it('refuses a process started while its session is being destroyed', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'sleep', 'sleep 60', process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    const destroying = destroySessionProcesses(sessionId)
    const lateProcess = createProcess(sessionId, 'late', 'sleep 60', process.cwd())
    expect(lateProcess).toBeNull()
    await destroying
    expect(getSessionProcesses(sessionId)).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('reports an explicit error when starting a process in a destroyed session', async () => {
    const sessionId = crypto.randomUUID()

    await destroySessionProcesses(sessionId)
    await expect(
      executeBackgroundAction(sessionId, process.cwd(), { action: 'start', command: 'sleep 60' }),
    ).resolves.toEqual({
      ok: false,
      error: `Background process refused: session ${sessionId} is closed or the server is stopping`,
    })
  })

  it('refuses a process started once background admission is closed', () => {
    closeBackgroundAdmission()

    expect(createProcess(crypto.randomUUID(), 'late', 'sleep 60', process.cwd())).toBeNull()
  })

  it('coalesces output events and bounds the output rate of a chatty process', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'chatty', 'yes x', process.cwd())!
    let outputEvents = 0
    let outputBytes = 0
    const unsubscribe = onProcessEvent((processId, event) => {
      if (processId === backgroundProcess.id && event.type === 'backgroundProcess.output') {
        const payload = event.payload as { content: string }
        outputEvents += 1
        outputBytes += Buffer.byteLength(payload.content)
      }
    })

    startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    unsubscribe()
    await stopProcess(backgroundProcess.id, sessionId)

    expect(outputEvents).toBeLessThanOrEqual(15)
    expect(outputBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})
