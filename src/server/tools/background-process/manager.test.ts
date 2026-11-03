import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeBackgroundAction } from './actions.js'
import * as manager from './manager.js'
import type { BackgroundProcess } from '../../../shared/protocol.js'
import {
  createProcess,
  destroySessionProcesses,
  getSessionProcesses,
  onProcessEvent,
  startProcessCommand,
  stopProcess,
} from './manager.js'
import { cleanupAllProcesses, closeBackgroundAdmission, reopenBackgroundAdmission } from './store.js'

// Exit-notice API of lot 10f, typed here so the RED commit compiles.
type ExitNoticeShape = {
  sessionId: string
  processId: string
  name: string
  exitCode: number | null
  timedOut: boolean
  output: string
}
const exitNoticeApi = manager as unknown as {
  setExitNotifier?: (notifier: ((notice: ExitNoticeShape) => void) | null) => void
  formatExitNotice?: (notice: ExitNoticeShape) => string
}
const createNotifyingProcess = manager.createProcess as unknown as (
  sessionId: string,
  name: string,
  command: string,
  cwd: string,
  timeout: number | undefined,
  notifyOnExit: boolean,
) => BackgroundProcess | null

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

  it('keeps a process stopping until its whole tree is dead when its leader exits first', async () => {
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

describe('background process exit notices', () => {
  const notices: ExitNoticeShape[] = []

  async function settle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function waitForNotices(count: number): Promise<void> {
    for (let attempt = 0; attempt < 250 && notices.length < count; attempt++) await settle(20)
  }

  beforeEach(() => {
    notices.length = 0
    exitNoticeApi.setExitNotifier?.((notice) => notices.push(notice))
  })

  afterEach(async () => {
    exitNoticeApi.setExitNotifier?.(null)
    await cleanupAllProcesses()
    reopenBackgroundAdmission()
  })

  it.fails('notifies once with the exit code and last output lines when a notifyOnExit process exits', async () => {
    const sessionId = crypto.randomUUID()
    const proc = createNotifyingProcess(
      sessionId,
      'notify',
      "printf 'line1\nline2\n'; exit 3",
      process.cwd(),
      undefined,
      true,
    )!
    startProcessCommand(proc.id, sessionId, proc.command, proc.cwd)
    await waitForNotices(1)
    await settle(200)
    expect(notices).toEqual([
      {
        sessionId,
        processId: proc.id,
        name: 'notify',
        exitCode: 3,
        timedOut: false,
        output: 'line1\nline2',
      },
    ])
  })

  it('does not notify a process started without notifyOnExit', async () => {
    const sessionId = crypto.randomUUID()
    const proc = createNotifyingProcess(sessionId, 'quiet', 'exit 0', process.cwd(), undefined, false)!
    const exited = new Promise<void>((resolve) => {
      const off = onProcessEvent((processId, msg) => {
        if (processId === proc.id && msg.type === 'backgroundProcess.exited') {
          off()
          resolve()
        }
      })
    })
    startProcessCommand(proc.id, sessionId, proc.command, proc.cwd)
    await exited
    await settle(200)
    expect(notices).toEqual([])
  })

  it('does not notify a notifyOnExit process stopped explicitly', async () => {
    const sessionId = crypto.randomUUID()
    const proc = createNotifyingProcess(sessionId, 'stopped', 'sleep 60', process.cwd(), undefined, true)!
    startProcessCommand(proc.id, sessionId, proc.command, proc.cwd)
    await stopProcess(proc.id, sessionId)
    await settle(200)
    expect(notices).toEqual([])
  })

  it.fails('notifies a notifyOnExit process stopped by its timeout', async () => {
    const sessionId = crypto.randomUUID()
    const proc = createNotifyingProcess(sessionId, 'slow', 'sleep 60', process.cwd(), 300, true)!
    startProcessCommand(proc.id, sessionId, proc.command, proc.cwd)
    await waitForNotices(1)
    await settle(200)
    expect(notices).toEqual([
      {
        sessionId,
        processId: proc.id,
        name: 'slow',
        exitCode: null,
        timedOut: true,
        output: '',
      },
    ])
  })

  it('does not notify the processes stopped by a server shutdown', async () => {
    const sessionId = crypto.randomUUID()
    const proc = createNotifyingProcess(sessionId, 'shutdown', 'sleep 60', process.cwd(), undefined, true)!
    startProcessCommand(proc.id, sessionId, proc.command, proc.cwd)
    await cleanupAllProcesses()
    await settle(200)
    expect(notices).toEqual([])
  })

  it.fails('formats the exit notice queued to the session', () => {
    const format = exitNoticeApi.formatExitNotice!
    expect(
      format({
        sessionId: 's',
        processId: 'p',
        name: 'build',
        exitCode: 2,
        timedOut: false,
        output: 'a\nb',
      }),
    ).toBe('Background process "build" (p) exited with code 2.\nLast output lines:\na\nb')
    expect(
      format({
        sessionId: 's',
        processId: 'p',
        name: 'build',
        exitCode: null,
        timedOut: true,
        output: '',
      }),
    ).toBe('Background process "build" (p) was stopped by its timeout.\nLast output lines:\n(no output)')
  })
})
