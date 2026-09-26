import { useLocalizedString } from '../../hooks/useLocalizedString'
import { activatePluginAction, badgeToneClasses, pluginIcon, type PluginActionContext } from './plugin-ui-utils'
import type { DeclarativeNode, PluginBadgeTone } from '@shared/plugin.js'
import { ChevronDownIcon } from '../shared/icons'

const PROGRESS_COLORS: Record<string, string> = {
  neutral: 'bg-text-muted',
  info: 'bg-accent-primary',
  success: 'bg-accent-success',
  warning: 'bg-accent-warning',
  danger: 'bg-accent-error',
}

const BUTTON_VARIANT_CLASSES: Record<'default' | 'primary' | 'danger' | 'ghost' | 'pill', string> = {
  default: 'bg-bg-tertiary text-text-primary hover:bg-bg-primary',
  primary: 'bg-accent-primary text-white hover:bg-accent-primary/80',
  danger: 'bg-accent-error text-white hover:bg-accent-error/80',
  ghost: 'p-2.5 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary',
  pill: 'px-1.5 py-0.5 shrink-0 rounded-full border border-accent-primary/40 bg-accent-primary/10 text-accent-primary text-[10px] font-mono font-medium hover:bg-accent-primary/20',
}

const GAP_CLASSES: Record<'none' | 'xs' | 'sm' | 'md' | 'lg', string> = {
  none: 'gap-0',
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
}

const ALIGN_CLASSES: Record<'start' | 'center' | 'end' | 'stretch', string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
}

const JUSTIFY_CLASSES: Record<'start' | 'center' | 'end' | 'between', string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
}

const CALLOUT_CLASSES: Record<PluginBadgeTone, string> = {
  neutral: 'bg-bg-tertiary border-border text-text-primary',
  info: 'bg-accent-primary/10 border-accent-primary/30 text-text-primary',
  success: 'bg-accent-success/10 border-accent-success/30 text-text-primary',
  warning: 'bg-accent-warning/10 border-accent-warning/30 text-text-primary',
  danger: 'bg-accent-error/10 border-accent-error/30 text-text-primary',
}

export function interpolate(text: string, values?: Record<string, unknown>): string {
  if (!values) return text
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

export interface DeclarativeRendererProps {
  node: DeclarativeNode
  values?: Record<string, unknown>
  context?: PluginActionContext & { pluginId?: string }
}

export function DeclarativeRenderer({ node, values = {}, context = {} }: DeclarativeRendererProps) {
  const localize = useLocalizedString()

  switch (node.type) {
    case 'text':
      return (
        <div className={node.className ?? (node.muted ? 'text-sm text-text-muted' : 'text-sm text-text-primary')}>
          {interpolate(localize(node.text), values)}
        </div>
      )

    case 'keyValue':
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {node.items.map((item, index) => (
            <div key={index} className="contents">
              <dt className="text-text-muted">{localize(item.key)}</dt>
              <dd className="text-text-primary">{interpolate(item.value, values)}</dd>
            </div>
          ))}
        </dl>
      )

    case 'table':
      return (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {node.columns.map((column, index) => (
                <th key={index} className="text-left text-text-muted font-medium pb-1">
                  {localize(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/50">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="py-0.5 text-text-primary">
                    {interpolate(cell, values)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )

    case 'progress': {
      const pct = node.max > 0 ? Math.min(100, Math.max(0, (node.value / node.max) * 100)) : 0
      const labelText = localize(node.label)
      const toneColor = PROGRESS_COLORS[node.tone ?? 'info'] ?? 'bg-accent-primary'
      return (
        <div className="w-full space-y-1.5">
          {labelText ? (
            <div className="flex justify-between text-xs text-text-muted font-mono">
              <span>{labelText}</span>
              <span>
                {node.value} / {node.max}
              </span>
            </div>
          ) : null}
          <div className="relative h-1.5 w-full rounded-full bg-bg-tertiary">
            <div className={`h-full rounded-full ${toneColor}`} style={{ width: `${pct}%` }} />
            {pct > 0 && (
              <div
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full ${toneColor} ring-2 ring-bg-secondary`}
                style={{ left: `${pct}%` }}
              />
            )}
          </div>
        </div>
      )
    }

    case 'badge':
      return (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium ${badgeToneClasses(
            node.tone,
          )}`}
        >
          {localize(node.label)}
        </span>
      )

    case 'button': {
      const Icon = node.icon ? pluginIcon(node.icon) : null
      const labelText = localize(node.label)
      const isGhost = node.variant === 'ghost'
      const showLabel = !isGhost || !Icon
      return (
        <button
          type="button"
          title={labelText || undefined}
          aria-label={labelText || undefined}
          onClick={() => void activatePluginAction(context.pluginId, node.onActivate, context)}
          className={`transition-colors inline-flex items-center justify-center ${
            isGhost
              ? `${BUTTON_VARIANT_CLASSES.ghost} ${!Icon ? 'px-2.5 py-1.5 text-sm' : ''}`
              : `gap-1.5 px-3 py-1.5 rounded text-sm font-medium ${BUTTON_VARIANT_CLASSES[node.variant ?? 'default']}`
          }`}
        >
          {Icon && <Icon className="w-4 h-4" />}
          {showLabel && labelText && <span>{labelText}</span>}
        </button>
      )
    }

    case 'divider':
      return <hr className="border-border my-2" />

    case 'stack': {
      const directionClass = node.direction === 'row' ? 'flex flex-row w-full' : 'flex flex-col'
      const gapClass = GAP_CLASSES[node.gap ?? 'sm']
      const alignClass = ALIGN_CLASSES[node.align ?? 'start']
      const justifyClass = JUSTIFY_CLASSES[node.justify ?? 'start']
      return (
        <div className={`${directionClass} ${gapClass} ${alignClass} ${justifyClass} ${node.className ?? ''}`}>
          {node.children.map((child, index) => (
            <DeclarativeRenderer key={`stack-${index}-${child.type}`} node={child} values={values} context={context} />
          ))}
        </div>
      )
    }

    case 'card': {
      return (
        <div
          className={`rounded-lg border border-border bg-bg-secondary p-3 shadow-sm space-y-2 flex-1 min-w-0 ${
            node.className ?? ''
          }`}
        >
          {(node.title || node.subtitle) && (
            <div className="space-y-0.5">
              {node.title && <h4 className="text-sm font-semibold text-text-primary">{localize(node.title)}</h4>}
              {node.subtitle && <p className="text-xs text-text-muted">{localize(node.subtitle)}</p>}
            </div>
          )}
          <div className="space-y-2">
            {node.children.map((child, index) => (
              <DeclarativeRenderer key={`card-${index}-${child.type}`} node={child} values={values} context={context} />
            ))}
          </div>
        </div>
      )
    }

    case 'details': {
      return (
        <details className={`group mt-2 ${node.className ?? ''}`} open={node.defaultOpen}>
          <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary list-none flex items-center gap-1 select-none">
            <ChevronDownIcon className="w-3 h-3 transition-transform group-open:rotate-180" />
            {interpolate(localize(node.title), values)}
          </summary>
          <div className="mt-3 space-y-2">
            {node.children.map((child, index) => (
              <DeclarativeRenderer key={`${index}-${child.type}`} node={child} values={values} context={context} />
            ))}
          </div>
        </details>
      )
    }

    case 'callout': {
      const Icon = node.icon ? pluginIcon(node.icon) : pluginIcon(node.tone === 'danger' ? 'warning' : 'info')
      return (
        <div
          className={`flex items-start gap-2.5 p-3 rounded-md border text-sm ${CALLOUT_CLASSES[node.tone ?? 'info']}`}
        >
          <Icon className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            {node.title && <div className="font-medium text-text-primary">{localize(node.title)}</div>}
            <div className="text-text-secondary">{interpolate(localize(node.text), values)}</div>
          </div>
        </div>
      )
    }

    case 'icon': {
      const Icon = pluginIcon(node.icon)
      return <Icon className={`w-4 h-4 ${node.className ?? ''}`} />
    }

    case 'input': {
      const triggerAction = (action: typeof node.onChange, value: string) => {
        if (action) {
          void activatePluginAction(context.pluginId, action, { ...context, fieldId: node.id, value })
        }
      }
      return (
        <div className="flex-1 min-w-0">
          {node.label && <label className="text-xs text-text-secondary block mb-0.5">{localize(node.label)}</label>}
          <input
            id={node.id}
            type={node.inputType ?? 'text'}
            defaultValue={interpolate(node.defaultValue ?? '', values)}
            placeholder={node.placeholder ? localize(node.placeholder) : undefined}
            onChange={(e) => {
              triggerAction(node.onChange, e.target.value)
            }}
            onBlur={(e) => {
              triggerAction(node.onBlur, e.target.value)
            }}
            className="w-full px-2 py-1 bg-bg-tertiary border border-border rounded text-xs text-text-primary focus:outline-none focus:border-accent-primary"
          />
        </div>
      )
    }

    case 'select': {
      return (
        <div className="flex-1 min-w-0">
          {node.label && <label className="text-xs text-text-secondary block mb-0.5">{localize(node.label)}</label>}
          <select
            id={node.id}
            defaultValue={node.defaultValue}
            onChange={(e) => {
              if (node.onChange) {
                void activatePluginAction(context.pluginId, node.onChange, {
                  ...context,
                  fieldId: node.id,
                  value: e.target.value,
                })
              }
            }}
            className="w-full px-2 py-1 bg-bg-tertiary border border-border rounded text-xs text-text-primary focus:outline-none focus:border-accent-primary cursor-pointer"
          >
            {node.options.map((option) => (
              <option key={option.value} value={option.value}>
                {localize(option.label)}
              </option>
            ))}
          </select>
        </div>
      )
    }

    case 'iframe': {
      const height = typeof node.height === 'number' ? `${node.height}px` : (node.height ?? '200px')
      const width = typeof node.width === 'number' ? `${node.width}px` : (node.width ?? '100%')
      return (
        <iframe
          src={node.url}
          style={{ height, width }}
          sandbox="allow-scripts allow-forms allow-same-origin"
          className="border-0 rounded"
        />
      )
    }

    default:
      return null
  }
}
