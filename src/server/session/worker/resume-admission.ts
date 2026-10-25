import type { AdmissionResult } from './scheduler.js'

export interface AdmissionConsumption {
  admission: AdmissionResult
  consumed: boolean
}

export function consumeAfterAdmission(admit: () => AdmissionResult, consume: () => void): AdmissionConsumption {
  const admission = admit()
  const consumed = admission === 'started' || admission === 'waiting'
  if (consumed) consume()
  return { admission, consumed }
}
