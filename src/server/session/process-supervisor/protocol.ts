import type { ExclusiveProcessInventory, OrphanInventoryCheck, ProcessInventoryEntry } from '../worker/children.js'

export interface SupervisorWorkerSpawn {
  type: 'worker.spawn'
  requestId: string
  workerKey: string
  path: string
  execArgv: string[]
  env: NodeJS.ProcessEnv
}

export type GatewayToSupervisorMessage =
  | SupervisorWorkerSpawn
  | { type: 'worker.send'; workerKey: string; message: unknown }
  | { type: 'worker.kill'; workerKey: string; signal: NodeJS.Signals }
  | { type: 'git.run'; requestId: string; cwd: string; args: string[] }
  | { type: 'children.cleanup'; requestId: string; path: string }
  | {
      type: 'children.capture'
      requestId: string
      workerPid: number
      path: string
      capturedAt: number
      recordedWorker?: ProcessInventoryEntry
    }
  | { type: 'children.verify'; requestId: string; inventory: ExclusiveProcessInventory }
  | { type: 'shutdown' }

export type SupervisorToGatewayMessage =
  | { type: 'ready'; pid: number }
  | {
      type: 'worker.spawned'
      requestId: string
      workerKey: string
      pid: number
      inventory?: ProcessInventoryEntry
    }
  | { type: 'worker.spawn_error'; requestId: string; workerKey: string; error: string }
  | { type: 'worker.message'; workerKey: string; message: unknown }
  | { type: 'worker.stderr'; workerKey: string; chunk: string }
  | { type: 'worker.error'; workerKey: string; error: string }
  | { type: 'worker.exit'; workerKey: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'git.spawned'; requestId: string; pid: number; parentPid: number; cwd: string; args: string[] }
  | { type: 'git.result'; requestId: string; code: number | null; stdout: string }
  | { type: 'children.cleanup.result'; requestId: string; killedChildren: number[]; error?: string }
  | { type: 'children.capture.result'; requestId: string; inventory?: ExclusiveProcessInventory; error?: string }
  | { type: 'children.verify.result'; requestId: string; orphanCheck?: OrphanInventoryCheck; error?: string }
  | { type: 'shutdown.complete' }
