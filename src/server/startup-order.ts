interface ContinuationServices {
  startSupervisor: () => Promise<void>
  configureSupervisor: () => void
  startQueueProcessor: () => void
  runBootAutoContinuations: () => void
  startTaskScheduler: () => void
}

export async function startContinuationServices(services: ContinuationServices): Promise<void> {
  await services.startSupervisor()
  services.configureSupervisor()
  services.startQueueProcessor()
  services.runBootAutoContinuations()
  services.startTaskScheduler()
}
