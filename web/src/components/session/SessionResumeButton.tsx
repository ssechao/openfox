import { memo, useState } from 'react'
import { useT } from '../../hooks/useT'
import { useSessionStore } from '../../stores/session'

interface SessionResumeButtonProps {
  sessionId: string
  interruptedAt: string
  disabled?: boolean
}

export const SessionResumeButton = memo(function SessionResumeButton({
  sessionId,
  interruptedAt,
  disabled = false,
}: SessionResumeButtonProps) {
  const t = useT()
  const resumeInterruption = useSessionStore((state) => state.resumeInterruption)
  const abortInProgress = useSessionStore((state) => state.panes[sessionId]?.abortInProgress ?? false)
  const error = useSessionStore((state) => state.panes[sessionId]?.error)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleClick = async () => {
    setLocalError(null)
    try {
      await resumeInterruption(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLocalError(message)
    }
  }

  const isDisabled = disabled || abortInProgress
  const displayError = error?.code === 'resume_failed' ? error.message : localError

  return (
    <div className="flex flex-col items-center gap-2 feed-item" data-testid="session-resume-section">
      <div className="text-xs text-text-secondary max-w-md text-center">
        {t(
          {
            en: 'Session interrupted at {{time}}. Resume explicitly to continue.',
            fr: 'Session interrompue à {{time}}. Reprenez explicitement pour continuer.',
          },
          { time: new Date(interruptedAt).toLocaleString() },
        )}
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        data-testid="session-resume-button"
        className="px-4 py-1.5 text-sm font-medium rounded bg-accent-primary/15 text-accent-primary border border-accent-primary/25 hover:bg-accent-primary/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {abortInProgress ? t({ en: 'Resuming…', fr: 'Reprise…' }) : t({ en: '▶ Resume', fr: '▶ Reprendre' })}
      </button>
      {displayError && (
        <div className="text-xs text-text-tool-error max-w-md text-center" data-testid="session-resume-error">
          {displayError}
        </div>
      )}
    </div>
  )
})
