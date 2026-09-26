import { useLocalizedString } from '../../hooks/useLocalizedString'
import { badgeToneClasses, pluginIcon } from './plugin-ui-utils'
import type { PluginModelMetadataView } from '@shared/plugin.js'

/**
 * Renders plugin-contributed model metadata (badges) inside the model row.
 * Nothing renders when the plugin supplied no badges.
 */
export function PluginModelMeta({ metadata }: { metadata?: PluginModelMetadataView }) {
  const localize = useLocalizedString()
  if (!metadata?.badges?.length) return null

  return (
    <>
      {metadata.badges.map((badge, index) => {
        const hasLabel = Boolean(badge.label && (badge.label.en || badge.label.fr))
        const tooltipText = badge.tooltip ? localize(badge.tooltip) : hasLabel ? localize(badge.label) : undefined
        const Icon = badge.icon ? pluginIcon(badge.icon) : null

        return (
          <span
            key={`${badge.label?.en || 'badge'}-${index}`}
            data-plugin-badge
            title={tooltipText}
            className={
              hasLabel
                ? `inline-flex items-center gap-1 text-[10px] leading-none px-1.5 py-0.5 rounded border shrink-0 ${badgeToneClasses(
                    badge.tone,
                  )}`
                : 'inline-flex items-center cursor-help shrink-0'
            }
          >
            {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : null}
            {hasLabel ? <span>{localize(badge.label)}</span> : null}
          </span>
        )
      })}
    </>
  )
}
