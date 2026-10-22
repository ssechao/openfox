import type { DiagnosticsSeries, DiagnosticsSeriesName } from '@shared/diagnostics.js'
import { DIAGNOSTICS_SERIES_NAMES } from '@shared/diagnostics.js'
import type { Translation } from '@shared/i18n/index.js'
import { useDiagnostics } from '../../hooks/useDiagnostics'
import { useT } from '../../hooks/useT'
import { Sparkline } from '../shared/Sparkline'
import { HeartIcon } from '../shared/icons'

const SERIES_LABELS: Record<DiagnosticsSeriesName, Translation> = {
  eventLoopDelayP50: { en: 'Event loop delay p50', fr: 'Retard de la boucle p50' },
  eventLoopDelayP99: { en: 'Event loop delay p99', fr: 'Retard de la boucle p99' },
  eventLoopDelayMax: { en: 'Event loop delay max', fr: 'Retard de la boucle max' },
  healthLatencyP99: { en: '/api/health server handling p99', fr: 'Traitement serveur /api/health p99' },
  eventStoreReadP99: { en: 'EventStore read p99', fr: 'Lecture EventStore p99' },
  eventStoreWriteP99: { en: 'EventStore write p99', fr: 'Écriture EventStore p99' },
  walSize: { en: 'WAL size', fr: 'Taille du WAL' },
  runningSessions: { en: 'Running sessions', fr: 'Sessions en cours' },
  rss: { en: 'Memory (RSS)', fr: 'Mémoire (RSS)' },
  heapUsed: { en: 'Memory (heap)', fr: 'Mémoire (heap)' },
  snapshotCacheHits: { en: 'Snapshot cache hits', fr: 'Cache instantanés hits' },
  snapshotCacheMisses: { en: 'Snapshot cache misses', fr: 'Cache instantanés misses' },
  snapshotCacheBytes: { en: 'Snapshot cache bytes', fr: 'Cache instantanés octets' },
  snapshotCacheEvictions: { en: 'Snapshot cache evictions', fr: 'Cache instantanés évictions' },
  snapshotCacheLimitBytes: { en: 'Snapshot cache limit', fr: 'Cache instantanés limite' },
}

function formatValue(series: DiagnosticsSeries): string {
  const value = series.value ?? 0
  if (series.unit === 'bytes') {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${value} B`
  }
  if (series.unit === 'count') return String(Math.round(value))
  return `${value < 10 ? value.toFixed(2) : value.toFixed(0)} ms`
}

const formatMs = (value: number) => `${value.toFixed(0)} ms`
const formatSecondsAgo = (value: number) => `${value.toFixed(0)} s`

export function SantePage() {
  const t = useT()
  const { data, loading, failed, stale } = useDiagnostics()

  const history = data?.history ?? []
  const lastTimestamp = history.at(-1)?.timestamp ?? 0
  const curve = history.flatMap((point) =>
    point.eventLoopDelayMax === null
      ? []
      : [{ x: (point.timestamp - lastTimestamp) / 1000, y: point.eventLoopDelayMax }],
  )

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6" data-testid="sante-page">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <HeartIcon className="w-5 h-5 text-accent-error" />
          <h1 className="text-lg font-semibold text-text-primary">{t({ en: 'Health', fr: 'Santé' })}</h1>
          {stale && (
            <span
              data-testid="sante-stale"
              className="text-xs px-2 py-0.5 rounded bg-accent-warning/20 text-accent-warning"
            >
              {t({ en: 'Stale data', fr: 'Données périmées' })}
            </span>
          )}
        </div>

        {failed && (
          <div
            data-testid="sante-error"
            className="rounded border border-accent-error/50 bg-accent-error/10 px-3 py-2 text-sm text-accent-error"
          >
            {t({ en: 'Could not read /api/diagnostics.', fr: 'Impossible de lire /api/diagnostics.' })}
          </div>
        )}

        {!data && loading && <div className="text-sm text-text-muted">{t({ en: 'Loading…', fr: 'Chargement…' })}</div>}

        {data && (
          <>
            <section className="rounded border border-border bg-bg-secondary p-3" data-testid="sante-curve">
              <Sparkline
                data={curve}
                width={100}
                label={t(
                  {
                    en: 'Event loop delay, max per second over the last {{seconds}} s',
                    fr: 'Retard de la boucle, max par seconde sur les {{seconds}} dernières s',
                  },
                  { seconds: Math.round(data.historyMs / 1000) },
                )}
                formatY={formatMs}
                formatX={formatSecondsAgo}
              />
            </section>

            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {DIAGNOSTICS_SERIES_NAMES.map((name) => {
                const series = data.series[name]
                return (
                  <div
                    key={name}
                    data-testid={`sante-series-${name}`}
                    className="rounded border border-border bg-bg-secondary p-3"
                  >
                    <div className="text-xs text-text-muted truncate">{t(SERIES_LABELS[name])}</div>
                    <div className="text-lg font-medium text-text-primary mt-1">
                      {series.value === null ? t({ en: 'No data', fr: 'Pas de données' }) : formatValue(series)}
                    </div>
                    <div className="text-[10px] text-text-muted mt-1">
                      {t(
                        {
                          en: 'window {{seconds}} s · {{samples}} samples',
                          fr: 'fenêtre {{seconds}} s · {{samples}} échantillons',
                        },
                        {
                          seconds: Math.round((series.window.endMs - series.window.startMs) / 1000),
                          samples: series.samples,
                        },
                      )}
                    </div>
                  </div>
                )
              })}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
