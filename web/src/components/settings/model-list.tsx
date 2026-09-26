import { useState, useRef, useEffect, useMemo, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckIcon,
  EditSmallIcon,
  EyeIcon,
  HeartIcon,
  HeartFilledIcon,
  StarIcon,
  StarFilledIcon,
  WarningIcon,
} from '../shared/icons'
import type { Provider } from '../../stores/config'
import type { PluginModelMetadataView, LocalizedString } from '@shared/plugin.js'
import { isSmallContext } from '../../lib/context-warning'
import { useT } from '../../hooks/useT'
import { useLocalizedString } from '../../hooks/useLocalizedString'
import { PluginModelMeta } from '../plugins/PluginModelMeta'
import { PluginLogo } from '../shared/PluginLogo'
import { badgeToneTextClass, badgeToneClasses } from '../plugins/plugin-ui-utils'

export function formatContextWindow(context: number): string {
  if (context >= 1000000) return `${(context / 1000000).toFixed(1)}M`
  if (context >= 1000) return `${(context / 1000).toFixed(0)}K`
  return `${context}`
}

export interface ModelWithConfig {
  id: string
  name?: string
  contextWindow: number
  source: 'backend' | 'user' | 'default'
  supportsVision?: boolean
  reasoningEfforts?: string[]
  reasoningEffortOverride?: string
  thinkingLevel?: string
  thinkingEnabled?: boolean
  pluginMetadata?: PluginModelMetadataView
}

export function modelMatchesQuery(model: { name?: string; id: string }, query: string): boolean {
  const q = query.toLowerCase()
  const name = (model.name ?? '').toLowerCase()
  const id = model.id.toLowerCase()
  const idDisplay = id.replace(/-/g, ' ')
  return name.includes(q) || id.includes(q) || idDisplay.includes(q)
}

export function getVisibleModels(provider: Provider): ModelWithConfig[] {
  const hasSelected = provider.models.some((m) => m.selected)
  const source = hasSelected ? provider.models.filter((m) => m.selected) : provider.models
  return source.map((m) => {
    const reasoningEfforts = m.reasoningEfforts?.length
      ? m.reasoningEfforts
      : m.modes?.length
        ? m.modes.map((mode) => mode.level)
        : undefined
    return {
      id: m.id,
      ...(m.name !== undefined ? { name: m.name } : {}),
      contextWindow: m.contextWindow,
      source: m.source ?? 'default',
      ...(m.supportsVision !== undefined ? { supportsVision: m.supportsVision } : {}),
      ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
      ...(m.reasoningEffortOverride ? { reasoningEffortOverride: m.reasoningEffortOverride } : {}),
      ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
      ...(m.thinkingEnabled !== undefined ? { thinkingEnabled: m.thinkingEnabled } : {}),
      ...(m.pluginMetadata ? { pluginMetadata: m.pluginMetadata } : {}),
    }
  })
}

// ============================================================================
// ModelEntryRow
// ============================================================================

export interface ModelEntryRowProps {
  providerId: string
  modelConfig: ModelWithConfig
  isActive: boolean
  highlighted: boolean
  onModelClick: (providerId: string, modelId: string) => void
  providerLogo?: string
  isDefault?: boolean
  isFavorite?: boolean
  disabled?: boolean
  hasSession?: boolean
  settingDefault?: boolean
  onSetDefault?: (e: React.MouseEvent, providerId: string, modelId: string) => void
  onToggleFavorite?: (e: React.MouseEvent, providerId: string, modelId: string) => void
  onEditModel?: (providerId: string, model: ModelWithConfig) => void
  /** Available reasoning efforts for this model (shown as compact chips). */
  reasoningEfforts?: string[]
  /** Currently effective effort for this model (override/session/default). */
  selectedEffort?: string
  onSelectEffort?: (providerId: string, modelId: string, effort: string) => void
}

export function ModelEntryRow({
  providerId,
  modelConfig,
  isActive,
  isDefault: isDef,
  isFavorite,
  disabled,
  hasSession,
  settingDefault,
  highlighted,
  onModelClick,
  providerLogo,
  onSetDefault,
  onToggleFavorite,
  onEditModel,
  reasoningEfforts,
  selectedEffort,
  onSelectEffort,
}: ModelEntryRowProps) {
  const t = useT()
  const localize = useLocalizedString()
  const [showPopover, setShowPopover] = useState(false)
  const [popoverCoords, setPopoverCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const rowRef = useRef<HTMLDivElement>(null)

  const pluginMeta = modelConfig.pluginMetadata
  const popover = pluginMeta?.popover
  const subline = pluginMeta?.subline
  const nameToneClass = pluginMeta?.nameTone ? badgeToneTextClass(pluginMeta.nameTone) : ''

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (popover && (popover.rows?.length || popover.title)) {
      const dropdown = (e.currentTarget as HTMLElement).closest('[data-dropdown-container]') as HTMLElement | null
      const targetRect = dropdown ? dropdown.getBoundingClientRect() : (rowRef.current?.getBoundingClientRect() ?? null)
      const rowRect = rowRef.current?.getBoundingClientRect()
      if (targetRect && rowRect) {
        const spaceOnRight = window.innerWidth - targetRect.right
        const popoverWidth = 220
        const left =
          spaceOnRight > popoverWidth ? targetRect.right + 8 : Math.max(8, targetRect.left - popoverWidth - 8)
        setPopoverCoords({
          top: rowRect.top,
          left,
        })
        setShowPopover(true)
      }
    }
  }

  const handleMouseLeave = () => {
    setShowPopover(false)
  }

  const showEfforts = (reasoningEfforts?.length ?? 0) > 0 && !!onSelectEffort

  const resolveText = (text?: LocalizedString | string): string => {
    if (!text) return ''
    if (typeof text === 'string') return text
    return localize(text)
  }

  return (
    <div
      ref={rowRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`relative ${highlighted ? 'bg-bg-tertiary' : 'hover:bg-bg-tertiary'} ${disabled ? 'opacity-50 cursor-wait' : ''}`}
    >
      <div
        className={`flex items-center px-4 py-1.5 text-sm transition-colors group ${
          isActive ? 'text-accent-primary' : 'text-text-secondary'
        }`}
      >
        <button
          type="button"
          onClick={() => onModelClick(providerId, modelConfig.id)}
          disabled={disabled}
          className={`flex-1 min-w-0 text-left truncate ${nameToneClass}`}
        >
          {providerLogo && (
            <PluginLogo icon={providerLogo} className="w-3.5 h-3.5 shrink-0 inline-block mr-1.5 align-middle" />
          )}
          {modelConfig.name ?? modelConfig.id.split('/').pop()?.replace(/-/g, ' ') ?? modelConfig.id}
          {subline && subline.length > 0 && (
            <div
              data-model-subline
              className="text-[11px] font-mono flex items-center gap-1.5 whitespace-nowrap overflow-hidden text-ellipsis mt-0.5"
            >
              {subline.map((part, index) => (
                <span key={index} className="inline-flex items-center shrink-0">
                  <span className={badgeToneTextClass(part.tone)}>{part.text}</span>
                  {index < subline.length - 1 && <span className="text-text-muted ml-1.5">·</span>}
                </span>
              ))}
            </div>
          )}
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          {modelConfig.supportsVision && (
            <span
              data-vision
              className="text-text-muted flex-shrink-0"
              title={t({ en: 'Vision model', fr: 'Modèle vision' })}
              aria-label={t({ en: 'Vision model', fr: 'Modèle vision' })}
            >
              <EyeIcon className="w-3.5 h-3.5" />
            </span>
          )}
          <span className="text-xs text-text-muted">{formatContextWindow(modelConfig.contextWindow)}</span>
          <PluginModelMeta metadata={modelConfig.pluginMetadata} />
          {isSmallContext(modelConfig.contextWindow) && (
            <span
              data-small-context
              className="text-accent-warning"
              title={t({
                en: 'Small context window — agent prompts may be truncated by the provider',
                fr: 'Fenêtre de contexte réduite — les invites de l’agent peuvent être tronquées par le fournisseur',
              })}
            >
              <WarningIcon className="w-3.5 h-3.5" />
            </span>
          )}
          {onToggleFavorite && (
            <button
              type="button"
              onClick={(e) => onToggleFavorite(e, providerId, modelConfig.id)}
              disabled={disabled}
              className="p-0.5 hover:bg-bg-tertiary rounded transition-colors"
              title={
                isFavorite
                  ? t({ en: 'Remove from favorites', fr: 'Retirer des favoris' })
                  : t({ en: 'Add to favorites', fr: 'Ajouter aux favoris' })
              }
            >
              {isFavorite ? (
                <HeartFilledIcon className="w-3.5 h-3.5 text-rose-500" />
              ) : (
                <HeartIcon className="w-3.5 h-3.5 text-text-muted hover:text-rose-500" />
              )}
            </button>
          )}
          {hasSession && onSetDefault && (
            <button
              type="button"
              onClick={(e) => onSetDefault(e, providerId, modelConfig.id)}
              disabled={settingDefault}
              className="p-0.5 hover:bg-bg-tertiary rounded transition-colors disabled:opacity-40"
              title={
                isDef
                  ? t({ en: 'Default model', fr: 'Modèle par défaut' })
                  : t({ en: 'Set as default model', fr: 'Définir comme modèle par défaut' })
              }
            >
              {isDef ? (
                <StarFilledIcon className="w-3.5 h-3.5 text-accent-warning" />
              ) : (
                <StarIcon className="w-3.5 h-3.5 text-text-muted hover:text-accent-warning" />
              )}
            </button>
          )}
          {onEditModel && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onEditModel(providerId, modelConfig)
              }}
              className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-bg-tertiary rounded transition-opacity"
              title={t({ en: 'Edit model context', fr: 'Modifier le contexte du modèle' })}
            >
              <EditSmallIcon className="w-3 h-3 text-text-muted" />
            </button>
          )}
          {isActive && (
            <span
              className="text-accent-success flex-shrink-0"
              title={t({ en: 'Session model', fr: 'Modèle de session' })}
            >
              <CheckIcon className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
      </div>
      {showEfforts && (
        <div
          className="flex flex-wrap items-center gap-1 px-4 pb-1.5"
          aria-label={t({
            en: `Reasoning efforts for ${modelConfig.id}`,
            fr: `Niveaux de raisonnement pour ${modelConfig.id}`,
          })}
        >
          {reasoningEfforts!.map((effort) => {
            const isEffortActive = selectedEffort === effort
            return (
              <button
                key={effort}
                type="button"
                onClick={() => onSelectEffort!(providerId, modelConfig.id, effort)}
                disabled={disabled}
                className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                  isEffortActive
                    ? 'text-accent-primary border-accent-primary/50 bg-accent-primary/10'
                    : 'text-text-muted border-border hover:text-text-primary hover:border-text-muted'
                }`}
              >
                {effort}
              </button>
            )
          })}
        </div>
      )}
      {showPopover &&
        popover &&
        createPortal(
          <div
            data-model-popover
            data-pricing-popover
            className="fixed z-[9999] px-3 py-2 bg-bg-secondary border border-border rounded-lg shadow-xl text-xs space-y-1.5 pointer-events-none whitespace-nowrap min-w-[180px]"
            style={{
              top: `${popoverCoords.top}px`,
              left: `${popoverCoords.left}px`,
            }}
          >
            {(popover.title || popover.badge) && (
              <div className="font-medium text-text-primary pb-1 border-b border-border/50 flex items-center justify-between gap-2">
                <span>{resolveText(popover.title) || modelConfig.name || modelConfig.id}</span>
                {popover.badge && (
                  <span
                    className={`px-1.5 py-0.5 text-[9px] font-medium leading-none rounded border ${badgeToneClasses(
                      popover.badge.tone,
                    )}`}
                  >
                    {resolveText(popover.badge.label)}
                  </span>
                )}
              </div>
            )}
            {popover.rows?.map((row, idx) => (
              <div key={idx} className="text-text-secondary flex justify-between items-center gap-3">
                <span>{resolveText(row.label)}</span>
                <span className="font-mono text-text-primary">
                  {row.strikeThroughValue && (
                    <span className="line-through text-text-muted mr-1.5">{row.strikeThroughValue}</span>
                  )}
                  <span className={badgeToneTextClass(row.tone)}>{row.value}</span>
                </span>
              </div>
            ))}
            {popover.footer && (
              <div className="text-text-muted text-[10px] pt-1 border-t border-border/40 flex justify-between gap-3">
                <span>{resolveText(popover.footer)}</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

// ============================================================================
// useModelSearch hook
// ============================================================================

export interface UseModelSearchOptions {
  providers: Provider[]
  onSelect: (providerId: string, modelId: string) => void
  onEscape?: () => void
  /** Number of extra items after the model list (e.g. "Manage providers") */
  extraItemCount?: number
}

export interface UseModelSearchReturn {
  searchQuery: string
  setSearchQuery: (q: string) => void
  highlightedIndex: number
  setHighlightedIndex: (i: number) => void
  visibleGroups: Array<{ provider: Provider; models: ModelWithConfig[] }>
  flatItems: Array<{ providerId: string; modelConfig: ModelWithConfig }>
  totalNavItems: number
  handleSearchKeyDown: (e: React.KeyboardEvent) => void
  highlightedRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
}

export function useModelSearch({
  providers,
  onSelect,
  onEscape,
  extraItemCount = 0,
}: UseModelSearchOptions): UseModelSearchReturn {
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const highlightedRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Compute visible providers and their models, filtered by search query
  const visibleGroups = useMemo(() => {
    if (searchQuery.trim()) {
      return providers
        .map((p) => ({
          provider: p,
          models: getVisibleModels(p).filter((m) => modelMatchesQuery(m, searchQuery)),
        }))
        .filter((g) => g.models.length > 0)
    }
    return providers.map((p) => ({
      provider: p,
      models: getVisibleModels(p),
    }))
  }, [providers, searchQuery])

  // Flat list of all visible model items for keyboard navigation
  const flatItems = useMemo(
    () => visibleGroups.flatMap((g) => g.models.map((m) => ({ providerId: g.provider.id, modelConfig: m }))),
    [visibleGroups],
  )

  const totalNavItems = flatItems.length + extraItemCount

  // Auto-highlight first item when filtered results change, clamp otherwise
  useEffect(() => {
    if (totalNavItems <= 1) {
      setHighlightedIndex(-1)
    } else if (highlightedIndex >= totalNavItems) {
      setHighlightedIndex(totalNavItems - 1)
    } else if (highlightedIndex < 0 && searchQuery.trim()) {
      setHighlightedIndex(0)
    }
  }, [totalNavItems, highlightedIndex, searchQuery])

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedIndex])

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        onEscape?.()
        break
      case 'ArrowDown':
        e.preventDefault()
        if (totalNavItems > 0) {
          setHighlightedIndex((prev) => (prev < totalNavItems - 1 ? prev + 1 : 0))
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (totalNavItems > 0) {
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : totalNavItems - 1))
        }
        break
      case 'Home':
        e.preventDefault()
        setHighlightedIndex(0)
        break
      case 'End':
        e.preventDefault()
        setHighlightedIndex(totalNavItems - 1)
        break
      case 'Enter':
        e.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < flatItems.length) {
          const item = flatItems[highlightedIndex]
          if (item) {
            onSelect(item.providerId, item.modelConfig.id)
          }
        }
        break
    }
  }

  return {
    searchQuery,
    setSearchQuery,
    highlightedIndex,
    setHighlightedIndex,
    visibleGroups,
    flatItems,
    totalNavItems,
    handleSearchKeyDown,
    highlightedRef,
    inputRef,
  }
}
