import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function isLiveProcess(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
      .toString()
      .trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

async function readPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim())
    if (pid > 0) return pid
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`no pid in ${file}`)
}

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

  it('keeps a stopping process registered until it is dead when its session is destroyed', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'term-ignoring', "trap '' TERM; sleep 60", process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    await new Promise((resolve) => setTimeout(resolve, 200))
    const stopping = stopProcess(backgroundProcess.id, sessionId)
    const destroying = destroySessionProcesses(sessionId)
    expect(getSessionProcesses(sessionId).map((proc) => proc.status)).toEqual(['stopping'])
    await destroying
    expect(getSessionProcesses(sessionId)).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(stopping).resolves.toBeUndefined()
  })

  it('kills a stopping process when shutdown follows the deletion of its session', async () => {
    const sessionId = crypto.randomUUID()
    const backgroundProcess = createProcess(sessionId, 'term-ignoring', "trap '' TERM; sleep 60", process.cwd())!
    const pid = startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)!

    await new Promise((resolve) => setTimeout(resolve, 200))
    const stopping = stopProcess(backgroundProcess.id, sessionId)
    const destroying = destroySessionProcesses(sessionId)
    await cleanupAllProcesses()
    expect(() => process.kill(pid, 0)).toThrow()
    await stopping
    await destroying
  })

  it.fails('keeps a process stopping until its whole tree is dead when its leader exits first', async () => {
    const sessionId = crypto.randomUUID()
    const pidFile = join(tmpdir(), `openfox-bg-${sessionId}.pid`)
    const backgroundProcess = createProcess(
      sessionId,
      'term-resistant-child',
      `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 60' & wait`,
      process.cwd(),
    )!
    startProcessCommand(backgroundProcess.id, sessionId, backgroundProcess.command, backgroundProcess.cwd)
    const childPid = await readPid(pidFile)
    const exited = new Promise<void>((resolve) => {
      const off = onProcessEvent((processId, msg) => {
        if (processId === backgroundProcess.id && msg.type === 'backgroundProcess.exited') {
          off()
          resolve()
        }
      })
    })

    const stopping = stopProcess(backgroundProcess.id, sessionId)
    await exited
    expect(getSessionProcesses(sessionId).map((proc) => proc.status)).toEqual(['stopping'])
    const destroying = destroySessionProcesses(sessionId)
    await cleanupAllProcesses()
    expect(isLiveProcess(childPid)).toBe(false)
    await stopping
    await destroying
    await rm(pidFile, { force: true })
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
