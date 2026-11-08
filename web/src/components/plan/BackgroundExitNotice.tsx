import type { Message } from '@shared/types.js'
import { useT } from '../../hooks/useT'
import { parseBackgroundExitNotice } from './background-exit-notice'

export function BackgroundExitNotice({ message }: { message: Message }) {
  const t = useT()
  const parsed = parseBackgroundExitNotice(message.content)
  const title = t({ en: 'Background process', fr: 'Processus en arri\u00e8re-plan' })
  const outcome = !parsed
    ? null
    : parsed.outcome === 'timeout'
      ? t({ en: 'was stopped by its timeout', fr: 'a \u00e9t\u00e9 arr\u00eat\u00e9 par son d\u00e9lai' })
      : t(
          { en: 'exited with code {{code}}', fr: 's\u2019est termin\u00e9 avec le code {{code}}' },
          { code: parsed.exitCode ?? t({ en: 'unknown', fr: 'inconnu' }) },
        )

  return (
    <div
      data-testid="background-exit-notice"
      className="feed-item my-3 rounded border border-border bg-bg-tertiary/40 px-3 py-2"
    >
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{title}</div>
      {parsed && outcome ? (
        <div className="mt-1 text-sm text-text-primary">
          {t(
            { en: '{{name}} ({{processId}}) {{outcome}}', fr: '{{name}} ({{processId}}) {{outcome}}' },
            { name: parsed.name, processId: parsed.processId, outcome },
          )}
        </div>
      ) : null}
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-text-secondary">
        {parsed ? parsed.output : message.content}
      </pre>
    </div>
  )
}
