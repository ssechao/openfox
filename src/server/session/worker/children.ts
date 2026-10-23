/**
 * Exclusive-child tracking for session workers (étape 6a).
 *
 * A worker's shell children spawn detached (own process group), so a
 * `kill -9` on the worker leaves them orphaned and reparented. The worker
 * therefore records every spawned child pid synchronously in a sidecar file
 * (append-only JSONL, survives SIGKILL); the gateway reads that file when the
 * worker dies and kills each recorded process group.
 *
 * Tracking is active only inside a worker process (OPENFOX_WORKER_CHILDREN
 * set); everywhere else `trackExclusiveChild` is a no-op, so the gateway's own
 * shell calls and the shared MCP/LSP servers are never recorded and never
 * touched by the cleanup.
 */

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { killProcessTree } from '../../utils/process-tree.js'
import { logger } from '../../utils/logger.js'

export interface TrackedChild {
  pid: number
  command?: string
}

export function childrenFilePath(dbPath: string, workerId: string): string {
  return `${dbPath}.worker-${workerId}.children`
}

function activeFilePath(): string | null {
  const path = process.env['OPENFOX_WORKER_CHILDREN']
  return path && path.length > 0 ? path : null
}

export function initChildrenTracking(path: string): void {
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 })
}

/**
 * Record a spawned exclusive child. Synchronous and best-effort: it must
 * never break the tool call that spawned the process.
 */
export function trackExclusiveChild(pid: number | undefined, command?: string): void {
  const path = activeFilePath()
  if (!path || !pid || !Number.isFinite(pid) || pid <= 0) return
  try {
    const entry: TrackedChild = { pid, ...(command ? { command: command.slice(0, 200) } : {}) }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch (error) {
    logger.warn('Failed to track worker child', {
      pid,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function readTrackedChildren(path: string): TrackedChild[] {
  if (!existsSync(path)) return []
  const children: TrackedChild[] = []
  const seen = new Set<number>()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as TrackedChild
      if (Number.isFinite(entry.pid) && entry.pid > 0 && !seen.has(entry.pid)) {
        seen.add(entry.pid)
        children.push(entry)
      }
    } catch {
      // Ignore truncated trailing line (worker killed mid-append)
    }
  }
  return children
}

/**
 * Kill every recorded child's process group, then unlink the file. Returns
 * the pids that were signaled (the cleanup proof). Missing processes are
 * fine — they may have exited on their own before the worker died.
 */
export async function killTrackedChildren(path: string): Promise<number[]> {
  const children = readTrackedChildren(path)
  const killed: number[] = []
  for (const child of children) {
    try {
      await killProcessTree(child.pid)
      killed.push(child.pid)
    } catch (error) {
      logger.debug('Worker child already gone', {
        pid: child.pid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  removeChildrenFile(path)
  return killed
}

export function removeChildrenFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone
  }
}
