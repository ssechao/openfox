import { useEffect, useState } from 'react'
import { diagnosticsResource } from '../lib/resources'
import { useResource } from './useResource'

export const DIAGNOSTICS_POLL_MS = 2_000
export const DIAGNOSTICS_STALE_MS = 3 * DIAGNOSTICS_POLL_MS

/**
 * Server health metrics, polled every 2s while mounted. The interval only
 * refreshes the shared cache key and stops on unmount. Data counts as stale
 * when no fresh payload arrived for three poll periods (client clock only).
 */
export function useDiagnostics() {
  const { data, loading, error, refresh } = useResource(diagnosticsResource)
  const [now, setNow] = useState(() => Date.now())
  const [receivedAt, setReceivedAt] = useState(() => Date.now())

  useEffect(() => {
    setReceivedAt(Date.now())
  }, [data])

  useEffect(() => {
    const pollTimer = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, DIAGNOSTICS_POLL_MS)
    return () => clearInterval(pollTimer)
  }, [refresh])

  return {
    data,
    loading,
    failed: error !== undefined,
    stale: data !== undefined && now - receivedAt > DIAGNOSTICS_STALE_MS,
  }
}
