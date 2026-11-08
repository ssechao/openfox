interface ContinuationServices {
  startSupervisor: () => Promise<void>
  configureSupervisor: () => void
  startQueueProcessor: () => void
  runBootAutoContinuations: () => void | Promise<void>
  startTaskScheduler: () => void
}

export async function startContinuationServices(services: ContinuationServices): Promise<void> {
  await services.startSupervisor()
  services.configureSupervisor()
  services.startQueueProcessor()
  await services.runBootAutoContinuations()
  services.startTaskScheduler()
}
