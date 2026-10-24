export const ORPHAN_WINDOW_MIN_MS = 2_000
export const ORPHAN_WINDOW_MAX_MS = 2_500

export interface OrphanObservationWindow {
  killAt: number
  capturedAt: number
  checkedAt: number
}

export function orphanDelayMs(window: OrphanObservationWindow): number {
  return window.checkedAt - window.capturedAt
}

export function orphanAfterSignalMs(window: OrphanObservationWindow): number {
  return window.checkedAt - window.killAt
}

export function orphanWindowSatisfied(window: OrphanObservationWindow): boolean {
  const delay = orphanDelayMs(window)
  const afterSignal = orphanAfterSignalMs(window)
  return (
    delay >= ORPHAN_WINDOW_MIN_MS &&
    delay <= ORPHAN_WINDOW_MAX_MS &&
    afterSignal >= ORPHAN_WINDOW_MIN_MS &&
    afterSignal <= ORPHAN_WINDOW_MAX_MS
  )
}
