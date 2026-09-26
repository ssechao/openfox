import { Fragment, useEffect, useState } from 'react'
import { useResource } from '../../hooks/useResource'
import { useT } from '../../hooks/useT'
import { useLocalizedString } from '../../hooks/useLocalizedString'
import { pluginSettingsResource, providersResource } from '../../lib/resources'
import { invokePluginRpc, savePluginSettings } from '../../lib/plugin-actions'
import { Button } from '../shared/Button'
import { Toggle } from '../shared/Toggle'
import type { PluginSettingsField, PluginSettingScope, PluginSettingValue } from '@shared/plugin.js'

type FormValues = Record<string, PluginSettingValue | string>

const FIELD_CLASS = 'w-full px-2.5 py-1.5 text-sm text-text-primary bg-bg-tertiary border border-border rounded'
const MASKED_SECRET = '••••••••••••••••'

function isSecretField(field: PluginSettingsField): boolean {
  return field.secret === true || field.type === 'password'
}

function isMaskedValue(value: unknown): boolean {
  return typeof value === 'string' && (value === MASKED_SECRET || /^[•*]+$/.test(value))
}

function FieldInput({
  id,
  value,
  onChange,
  multiline,
  type,
  placeholder,
}: {
  id: string
  value: string | number
  onChange: (value: string) => void
  multiline?: boolean
  type?: string
  placeholder?: string
}) {
  const strVal = String(value ?? '')
  if (multiline) {
    return (
      <textarea
        id={id}
        value={strVal}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        className={FIELD_CLASS}
      />
    )
  }
  return (
    <input
      id={id}
      type={type ?? 'text'}
      value={strVal}
      placeholder={placeholder ?? ''}
      onFocus={(event) => {
        if (strVal === MASKED_SECRET) {
          event.target.select()
        }
      }}
      onChange={(event) => {
        const next = event.target.value
        if (strVal === MASKED_SECRET && next.startsWith(MASKED_SECRET)) {
          onChange(next.slice(MASKED_SECRET.length))
        } else {
          onChange(next)
        }
      }}
      className={FIELD_CLASS}
    />
  )
}

function initialValue(
  field: PluginSettingsField,
  values: Record<string, unknown>,
  secretsSet: string[],
): FormValues[string] {
  if (isSecretField(field) && secretsSet.includes(field.key)) {
    return MASKED_SECRET
  }
  const stored = values[field.key]
  if (field.type === 'boolean') return typeof stored === 'boolean' ? stored : ((field.default as boolean) ?? false)
  if (field.type === 'number') return typeof stored === 'number' ? stored : ((field.default as number) ?? '')
  if (typeof stored === 'string') return stored
  return (field.default as string) ?? ''
}

export function PluginSettingsForm({
  pluginId,
  scope: initialScope = 'global',
  projectId,
}: {
  pluginId: string
  scope?: PluginSettingScope
  projectId?: string
}) {
  const t = useT()
  const localize = useLocalizedString()
  const [scope, setScope] = useState<PluginSettingScope>(initialScope)
  const { data } = useResource(pluginSettingsResource, pluginId, scope, projectId)
  const [values, setValues] = useState<FormValues>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!data) return
    const next: FormValues = {}
    for (const field of data.schema.fields) next[field.key] = initialValue(field, data.values, data.secretsSet)
    setValues(next)
  }, [data])

  if (!data) {
    return <p className="text-sm text-text-muted">{t({ en: 'Loading settings…', fr: 'Chargement des paramètres…' })}</p>
  }

  const projectScoped = projectId !== undefined && data.schema.fields.some((field) => field.scope === 'project')

  const saveValues = async (nextValues: FormValues) => {
    const payload: Record<string, unknown> = {}
    for (const field of data.schema.fields) {
      if (field.type === 'button') continue
      const value = nextValues[field.key]
      if (isSecretField(field) && (isMaskedValue(value) || value === '' || value === undefined)) continue
      if (field.type === 'number' && value === '') continue
      payload[field.key] = value
    }
    const result = await savePluginSettings(pluginId, payload, scope, projectId)
    if (!result.ok) {
      setError(result.error ?? t({ en: 'Failed to save settings', fr: 'Échec de l’enregistrement des paramètres' }))
      return
    }
    pluginSettingsResource.write(
      {
        schema: data.schema,
        values: payload as Record<string, string | number | boolean>,
        secretsSet: data.secretsSet,
      },
      pluginId,
      scope,
      projectId,
    )
    void providersResource.refresh()
    setError(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex flex-col gap-4">
      {projectScoped ? (
        <div>
          <label className="block text-xs text-text-secondary mb-1" htmlFor="plugin-setting-scope">
            {t({ en: 'Applies to', fr: 'S’applique à' })}
          </label>
          <select
            id="plugin-setting-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as PluginSettingScope)}
            className={FIELD_CLASS}
          >
            <option value="global">{t({ en: 'All projects', fr: 'Tous les projets' })}</option>
            <option value="project">{t({ en: 'This project', fr: 'Ce projet' })}</option>
          </select>
        </div>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {data.schema.fields.map((field, index) => {
          const label = localize(field.label)
          const description = field.description ? localize(field.description) : undefined
          const value = values[field.key]
          const parentEnabled = field.parentKey ? values[field.parentKey] === true : true
          const previousField = index > 0 ? data.schema.fields[index - 1] : undefined
          const previousParentKey = previousField?.parentKey
          const startsGroup = Boolean(field.parentKey && field.parentKey !== previousParentKey)
          const nextParentKey =
            index < data.schema.fields.length - 1 ? data.schema.fields[index + 1]?.parentKey : undefined
          const endsGroup = Boolean(field.parentKey && field.parentKey !== nextParentKey)
          const isHalf = field.width === 'half'
          const showSectionHeader =
            field.section !== undefined &&
            (previousField === undefined ||
              previousField.section === undefined ||
              localize(field.section) !== localize(previousField.section))

          return (
            <Fragment key={field.key}>
              {showSectionHeader ? (
                <div className="col-span-1 sm:col-span-2 pt-3 pb-1 border-b border-border/50">
                  <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">
                    {localize(field.section!)}
                  </span>
                </div>
              ) : null}
              <div
                className={`${isHalf ? 'col-span-1' : 'col-span-1 sm:col-span-2'} ${field.parentKey ? `ml-3 pl-4 border-l-2 border-border/60 ${startsGroup ? 'pt-1' : ''} ${endsGroup ? 'pb-1' : ''}` : ''} ${!parentEnabled ? 'opacity-45' : ''}`}
              >
                <label className="block text-xs text-text-secondary mb-1" htmlFor={`plugin-setting-${field.key}`}>
                  {label}
                </label>
                {field.type === 'boolean' ? (
                  <Toggle
                    enabled={value === true}
                    onClick={() => {
                      if (!parentEnabled) return
                      const next = { ...values, [field.key]: !(values[field.key] === true) }
                      setValues(next)
                      void saveValues(next)
                    }}
                  />
                ) : field.type === 'button' ? (
                  <div className="pt-0.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        setError(null)
                        try {
                          await invokePluginRpc(pluginId, field.rpcMethod ?? field.key, {})
                        } catch (actionError) {
                          setError(
                            actionError instanceof Error
                              ? actionError.message
                              : t({ en: 'Action failed', fr: 'Échec de l’action' }),
                          )
                        }
                      }}
                    >
                      {localize(field.buttonLabel ?? field.label)}
                    </Button>
                  </div>
                ) : field.type === 'select' ? (
                  <select
                    id={`plugin-setting-${field.key}`}
                    value={String(value ?? '')}
                    onChange={(event) => setValues((state) => ({ ...state, [field.key]: event.target.value }))}
                    className={FIELD_CLASS}
                  >
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {localize(option.label)}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'textarea' ? (
                  <FieldInput
                    id={`plugin-setting-${field.key}`}
                    value={String(value ?? '')}
                    onChange={(next) => setValues((state) => ({ ...state, [field.key]: next }))}
                    multiline
                  />
                ) : (
                  <FieldInput
                    id={`plugin-setting-${field.key}`}
                    value={String(value ?? '')}
                    onChange={(next) =>
                      setValues((state) => ({
                        ...state,
                        [field.key]: field.type === 'number' ? (next === '' ? '' : Number(next)) : next,
                      }))
                    }
                    type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                    {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                  />
                )}
                {description ? <p className="mt-1 text-xs text-text-muted">{description}</p> : null}
              </div>
            </Fragment>
          )
        })}
      </div>
      {error ? <p className="text-xs text-accent-error">{error}</p> : null}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={() => void saveValues(values)}>
          {saved ? t({ en: 'Saved', fr: 'Enregistré' }) : t({ en: 'Save', fr: 'Enregistrer' })}
        </Button>
      </div>
    </div>
  )
}
