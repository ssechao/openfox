export {
  assignWorkerToken,
  clearWorkerToken,
  createWorkerFence,
  isWorkerMessageCurrent,
  isWorkerTokenCurrent,
  StaleWorkerGenerationError,
  isStaleWorkerGenerationError,
  type WorkerToken,
} from './token.js'
export {
  childrenFilePath,
  initChildrenTracking,
  reserveExclusiveChild,
  finalizeExclusiveChild,
  killTrackedChildren,
  captureExclusiveProcessInventory,
  verifyExclusiveProcessInventoryAfter,
  readProcessInventory,
  readTrackedChildren,
  removeChildrenFile,
  trackExclusiveChild,
  type TrackedChild,
  type ProcessInventoryEntry,
  type ExclusiveProcessInventory,
  type OrphanInventoryCheck,
  type ExclusiveChildReservation,
} from './children.js'
export {
  clearSessionInterrupted,
  getSessionInterruptedAt,
  markSessionInterrupted,
  findPendingToolReconciliations,
  planWorkerCrashRecovery,
} from './crash.js'
export { SessionWorkerManager, type SessionWorkerManagerDeps, type WorkerCrashReport } from './manager.js'
export {
  MAX_WAITING_SESSIONS,
  MAX_WORKER_PROCESSES,
  SessionTurnScheduler,
  resolveSessionWorkerEnabled,
  resolveWorkerPoolSize,
  type AdmissionResult,
  type CancellationResult,
} from './scheduler.js'
export type { GatewayToWorkerMessage, WorkerToGatewayMessage } from './protocol.js'
