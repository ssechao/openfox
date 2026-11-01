import type { BackgroundProcessToolArgs } from '../../tools/background-process/index.js'

export type BackgroundActionResult = { ok: true; output: string } | { ok: false; error: string }
import type { GatewayToWorkerMessage, WorkerIpcIdentity, WorkerToGatewayMessage } from './protocol.js'

export const BACKGROUND_REQUEST_DEADLINE_MS = 30_000

export class WorkerBackgroundClient {
  constructor(
    _identity: WorkerIpcIdentity,
    _send: (message: WorkerToGatewayMessage) => void,
    _deadlineMs = BACKGROUND_REQUEST_DEADLINE_MS,
  ) {}

  async execute(_defaultCwd: string, _args: BackgroundProcessToolArgs): Promise<BackgroundActionResult> {
    throw new Error('not implemented')
  }

  handleMessage(_message: GatewayToWorkerMessage): void {}

  close(_reason: string): void {}
}
