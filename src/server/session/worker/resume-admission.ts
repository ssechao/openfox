import type { AdmissionResult } from './scheduler.js'

export interface AdmissionConsumption {
  admission: AdmissionResult
  consumed: boolean
}

export function admitWithStartFailure(
  admit: (start: () => void) => AdmissionResult,
  start: () => void,
  onDeferredFailure: (error: Error) => void,
): AdmissionResult {
  let admissionReturned = false
  const admission = admit(() => {
    try {
      start()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (admissionReturned) onDeferredFailure(failure)
      else throw failure
    }
  })
  admissionReturned = true
  return admission
}

export function consumeAfterAdmission(admit: () => AdmissionResult, consume: () => void): AdmissionConsumption {
  const admission = admit()
  const consumed = admission === 'started' || admission === 'waiting'
  if (consumed) consume()
  return { admission, consumed }
}
