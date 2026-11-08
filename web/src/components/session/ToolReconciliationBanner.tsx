import { memo, useState } from 'react'
import type { PendingToolReconciliationPayload } from '@shared/protocol.js'
import { useT } from '../../hooks/useT'
import { useSessionStore } from '../../stores/session'

interface ToolReconciliationBannerProps {
  sessionId: string
  pending: PendingToolReconciliationPayload[]
}

export const ToolReconciliationBanner = memo(function ToolReconciliationBanner({
  sessionId,
  pending,
}: ToolReconciliationBannerProps) {
  const t = useT()
  const reconcilePendingTools = useSessionStore((state) => state.reconcilePendingTools)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (pending.length === 0) return null

  const handleClick = async () => {
    setBusy(true)
    setError(null)
    try {
      await reconcilePendingTools(sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2 feed-item" data-testid="tool-reconciliation-banner">
      <div className="text-xs text-text-secondary max-w-md text-center">
        {t(
          {
            en: '{{count}} tool call(s) stopped before a result. Confirm they did not finish before editing or running commands.',
            fr: '{{count}} appel(s) d’outil se sont arrêtés sans résultat. Confirmez qu’ils ne se sont pas terminés avant de modifier ou d’exécuter.',
          },
          { count: pending.length },
        )}
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        data-testid="tool-reconciliation-confirm"
        className="px-4 py-1.5 text-sm font-medium rounded bg-accent-primary/15 text-accent-primary border border-accent-primary/25 hover:bg-accent-primary/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy
          ? t({ en: 'Confirming…', fr: 'Confirmation…' })
          : t({ en: 'Confirm and continue', fr: 'Confirmer et continuer' })}
      </button>
      {error && (
        <div className="text-xs text-text-tool-error max-w-md text-center" data-testid="tool-reconciliation-error">
          {error}
        </div>
      )}
    </div>
  )
})
