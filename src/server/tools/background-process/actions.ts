import * as manager from './manager.js'
import * as store from './store.js'

export interface BackgroundProcessToolArgs {
  action: 'start' | 'stop' | 'list' | 'status' | 'logs'
  name?: string
  command?: string
  cwd?: string
  timeout?: number
  processId?: string
  since?: number
  maxLines?: number
}

export type BackgroundActionResult = { ok: true; output: string } | { ok: false; error: string }

function processNotFoundError(id: string | undefined): string {
  return `Process not found: ${id ?? ''}`
}

export async function executeBackgroundAction(
  sessionId: string,
  defaultCwd: string,
  args: BackgroundProcessToolArgs,
): Promise<BackgroundActionResult> {
  switch (args.action) {
    case 'start': {
      const count = store.getSessionProcessCount(sessionId)
      const maxPerSession = store.getMaxPerSession()

      if (count >= maxPerSession) {
        return {
          ok: false,
          error: `Maximum number of background processes (${maxPerSession}) reached. Stop existing processes before starting new ones.`,
        }
      }

      const name = args.name ?? args.command?.split(' ')[0] ?? 'process'
      const process = manager.createProcess(sessionId, name, args.command!, defaultCwd, args.timeout)

      if (!process) {
        return { ok: false, error: 'Failed to create process. Maximum limit may have been reached.' }
      }

      const pid = manager.startProcessCommand(process.id, sessionId, args.command!, defaultCwd)

      if (!pid) {
        return { ok: false, error: 'Failed to start process.' }
      }

      return {
        ok: true,
        output: JSON.stringify(
          {
            processId: process.id,
            name: process.name,
            pid,
            status: 'running',
            maxReached: count + 1 >= maxPerSession,
          },
          null,
          2,
        ),
      }
    }

    case 'stop': {
      const proc = manager.getProcessStatus(args.processId!, sessionId)
      if (!proc) return { ok: false, error: processNotFoundError(args.processId) }

      if (proc.status !== 'running') {
        return { ok: false, error: `Process is not running (status: ${proc.status}). Cannot stop.` }
      }

      await manager.stopProcess(args.processId!, sessionId)

      return {
        ok: true,
        output: JSON.stringify(
          {
            processId: args.processId,
            status: 'removed',
          },
          null,
          2,
        ),
      }
    }

    case 'list': {
      const processes = manager.getSessionProcesses(sessionId)
      const maxPerSession = store.getMaxPerSession()

      return {
        ok: true,
        output: JSON.stringify(
          {
            processes,
            maxPerSession,
            currentCount: processes.filter((process) => process.status !== 'exited').length,
          },
          null,
          2,
        ),
      }
    }

    case 'status': {
      const proc = manager.getProcessStatus(args.processId!, sessionId)
      if (!proc) return { ok: false, error: processNotFoundError(args.processId) }

      const uptime = proc.startedAt ? Date.now() - proc.startedAt : null

      return {
        ok: true,
        output: JSON.stringify(
          {
            process: proc,
            uptime,
          },
          null,
          2,
        ),
      }
    }

    case 'logs': {
      const proc = manager.getProcessStatus(args.processId!, sessionId)
      if (!proc) return { ok: false, error: processNotFoundError(args.processId) }

      const since = args.since ?? 0
      const maxLines = Math.min(args.maxLines ?? 500, 2000)
      const { lines, totalLines, nextOffset, hasMore } = manager.getProcessLogs(args.processId!, since, maxLines)

      return {
        ok: true,
        output: JSON.stringify(
          {
            processId: args.processId,
            lines,
            totalLines,
            nextOffset,
            hasMore,
            truncated: hasMore,
          },
          null,
          2,
        ),
      }
    }

    default:
      return { ok: false, error: `Unknown action: ${args.action}` }
  }
}
