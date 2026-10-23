/**
 * IPC protocol between the gateway and a session worker (étape 6a).
 *
 * Every message carries the (workerId, generation) identity; the gateway
 * drops any message whose pair is not the live token, and the worker drops
 * any command whose pair is not its own. PIDs never appear in the protocol.
 */

import type { Config } from '../../../shared/types.js'
import type { ServerMessage } from '../../../shared/protocol.js'
import type { DiagnosticsData } from '../../../shared/diagnostics.js'
import type { WorkerToken } from './token.js'

export type { WorkerToken }

export type GatewayToWorkerMessage =
  (WorkerToken & { type: 'start'; sessionId: string; config: Config }) | (WorkerToken & { type: 'abort' })

export type WorkerToGatewayMessage =
  | (WorkerToken & { type: 'ready'; pid: number })
  | (WorkerToken & { type: 'ws'; msg: ServerMessage })
  | (WorkerToken & { type: 'health'; data: DiagnosticsData })
  | (WorkerToken & { type: 'done'; ok: boolean; error?: string })
