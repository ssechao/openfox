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
  | { type: 'shutdown' }

export type SupervisorToGatewayMessage =
  | { type: 'ready'; pid: number }
  | { type: 'worker.spawned'; requestId: string; workerKey: string; pid: number }
  | { type: 'worker.spawn_error'; requestId: string; workerKey: string; error: string }
  | { type: 'worker.message'; workerKey: string; message: unknown }
  | { type: 'worker.stderr'; workerKey: string; chunk: string }
  | { type: 'worker.error'; workerKey: string; error: string }
  | { type: 'worker.exit'; workerKey: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'git.spawned'; requestId: string; pid: number; parentPid: number; cwd: string; args: string[] }
  | { type: 'git.result'; requestId: string; code: number | null; stdout: string }
  | { type: 'shutdown.complete' }
