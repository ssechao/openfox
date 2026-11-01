import { afterEach, describe, expect, it } from 'vitest'
import { createProcess, onProcessEvent, startProcessCommand, stopProcess } from './manager.js'
import { cleanupAllProcesses } from './store.js'

describe('background process manager', () => {
  afterEach(async () => {
    await cleanupAllProcesses()
  })

  it.fails('destroys a running process before cleanupAllProcesses resolves', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'sleep', 'sleep 60', process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    expect(() => process.kill(pid, 0)).not.toThrow()
    await cleanupAllProcesses()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it.fails('kills a TERM-ignoring process before cleanupAllProcesses resolves', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'term-ignoring', "trap '' TERM; sleep 60", process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await cleanupAllProcesses()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it.fails('coalesces output events and bounds the output rate of a chatty process', async () => {
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
