import type {
  DiagnosticsSeries,
  DiagnosticsSeriesName,
  RuntimeLastCommand,
  RuntimeSnapshot,
  RuntimeState,
  WorkerSeriesExpiryReason,
} from '@shared/diagnostics.js'
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

const RUNTIME_STATE_LABELS: Record<RuntimeState, Translation> = {
  idle: { en: 'Idle', fr: 'Inactif' },
  running: { en: 'Running', fr: 'En cours' },
  paused: { en: 'Paused', fr: 'En pause' },
  stopping: { en: 'Stopping', fr: 'Arrêt en cours' },
  compacting: { en: 'Compacting', fr: 'Compactage' },
  workflow: { en: 'Workflow', fr: 'Workflow' },
}

const RUNTIME_COMMAND_LABELS: Record<RuntimeLastCommand, Translation> = {
  launch: { en: 'Launch', fr: 'Lancement' },
  stop: { en: 'Stop', fr: 'Arrêt' },
  pause: { en: 'Pause', fr: 'Pause' },
  resume: { en: 'Resume', fr: 'Reprise' },
  answer: { en: 'Answer', fr: 'Réponse' },
  workflow: { en: 'Workflow', fr: 'Workflow' },
  compact: { en: 'Compact', fr: 'Compactage' },
}

const WORKER_EXPIRY_LABELS: Record<WorkerSeriesExpiryReason, Translation> = {
  exit: { en: 'Exited', fr: 'Sortie normale' },
  crash: { en: 'Crashed', fr: 'Crash' },
  shutdown: { en: 'Shutdown', fr: 'Arrêt' },
  ttl: { en: 'TTL expired', fr: 'Délai dépassé' },
}

function formatValue(series: DiagnosticsSeries): string {
  const value = series.value ?? 0
  if (series.unit === 'bytes') return formatBytes(value)
  if (series.unit === 'count') return String(Math.round(value))
  return `${value < 10 ? value.toFixed(2) : value.toFixed(0)} ms`
}

const formatMs = (value: number) => `${value.toFixed(0)} ms`
const formatSecondsAgo = (value: number) => `${value.toFixed(0)} s`
const formatBytes = (value: number) => {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

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

            <section className="rounded border border-border bg-bg-secondary p-3" data-testid="sante-workers">
              <h2 className="text-sm font-medium text-text-primary mb-2">
                {t({ en: 'Worker processes', fr: 'Processus workers' })}
              </h2>
              {(data.workerProcesses ?? []).length === 0 ? (
                <div className="text-sm text-text-muted">
                  {t({ en: 'No worker processes', fr: 'Aucun processus worker' })}
                </div>
              ) : (
                <ul className="space-y-2">
                  {(data.workerProcesses ?? []).map((worker) => (
                    <li
                      key={`${worker.workerId}-${worker.generation}`}
                      data-testid={`sante-worker-${worker.workerId}-${worker.generation}`}
                      className="rounded border border-border/70 p-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-text-primary truncate">{worker.sessionId}</span>
                        <span className={worker.freshness === 'fresh' ? 'text-accent-success' : 'text-accent-warning'}>
                          {worker.freshness === 'fresh'
                            ? t({ en: 'Fresh', fr: 'À jour' })
                            : t({ en: 'Stale', fr: 'Périmé' })}
                        </span>
                      </div>
                      <div className="text-text-muted mt-1 break-all">
                        {worker.workerId}
                        {t(
                          {
                            en: ' · generation {{generation}} · PID {{pid}}',
                            fr: ' · génération {{generation}} · PID {{pid}}',
                          },
                          { generation: worker.generation, pid: worker.pid },
                        )}
                      </div>
                      <div className="text-text-muted mt-1">
                        {t(
                          {
                            en: 'RSS {{rss}} · Heap {{heap}} · age {{age}} s',
                            fr: 'RSS {{rss}} · Tas {{heap}} · âge {{age}} s',
                          },
                          {
                            rss:
                              worker.rss === null
                                ? t({ en: 'No data', fr: 'Pas de données' })
                                : formatBytes(worker.rss),
                            heap:
                              worker.heapUsed === null
                                ? t({ en: 'No data', fr: 'Pas de données' })
                                : formatBytes(worker.heapUsed),
                            age: (worker.ageMs / 1000).toFixed(1),
                          },
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-2">
                        {DIAGNOSTICS_SERIES_NAMES.map((name) => {
                          const series = worker.series[name]
                          return (
                            <div
                              key={name}
                              data-testid={`sante-worker-series-${worker.workerId}-${worker.generation}-${name}`}
                              className="flex items-center justify-between gap-2 text-text-muted"
                            >
                              <span className="truncate">{t(SERIES_LABELS[name])}</span>
                              <span className="whitespace-nowrap">
                                {t(
                                  {
                                    en: '{{value}} · {{samples}} samples',
                                    fr: '{{value}} · {{samples}} échantillons',
                                  },
                                  {
                                    value:
                                      series.value === null
                                        ? t({ en: 'No data', fr: 'Pas de données' })
                                        : formatValue(series),
                                    samples: series.samples,
                                  },
                                )}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded border border-border bg-bg-secondary p-3" data-testid="sante-stale-series">
              <h2 className="text-sm font-medium text-text-primary mb-2">
                {t({ en: 'Expired worker series', fr: 'Séries workers expirées' })}
              </h2>
              {(data.staleSeries ?? []).length === 0 ? (
                <div className="text-sm text-text-muted">
                  {t({ en: 'No expired worker series', fr: 'Aucune série worker expirée' })}
                </div>
              ) : (
                <ul className="space-y-1">
                  {(data.staleSeries ?? []).map((series) => (
                    <li
                      key={`${series.workerId}-${series.generation}`}
                      data-testid={`sante-stale-series-${series.workerId}-${series.generation}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="text-text-primary break-all">
                        {t(
                          {
                            en: '{{workerId}} · generation {{generation}}',
                            fr: '{{workerId}} · génération {{generation}}',
                          },
                          { workerId: series.workerId, generation: series.generation },
                        )}
                      </span>
                      <span className="text-accent-warning whitespace-nowrap">
                        {t(WORKER_EXPIRY_LABELS[series.reason])}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded border border-border bg-bg-secondary p-3" data-testid="sante-runtimes">
              <h2 className="text-sm font-medium text-text-primary mb-2">{t({ en: 'Runtimes', fr: 'Runtimes' })}</h2>
              {data.runtimes.length === 0 ? (
                <div className="text-sm text-text-muted">
                  {t({ en: 'No active runtimes', fr: 'Aucun runtime actif' })}
                </div>
              ) : (
                <ul className="space-y-1">
                  {data.runtimes.map((runtime: RuntimeSnapshot) => (
                    <li
                      key={runtime.sessionId}
                      data-testid={`runtime-${runtime.sessionId}`}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-text-primary truncate">{runtime.sessionId}</span>
                      <span className="text-text-muted">
                        {t(RUNTIME_STATE_LABELS[runtime.state])}
                        {runtime.lastCommand ? ` · ${t(RUNTIME_COMMAND_LABELS[runtime.lastCommand])}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
