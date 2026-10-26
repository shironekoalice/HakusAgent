/**
 * FlowField — one parameter control, shared by the inspector and the node
 * card's inline form.
 *
 * ComfyUI renders widgets directly on the node, and so do we: the same field
 * definition drives both surfaces, so a node's parameters are editable where
 * the operator is looking instead of only in the right rail.
 *
 * Two variants:
 * - `full` — label above control, used by the inspector;
 * - `inline` — compact row (label left, control right) for the node card.
 *
 * Every control carries `nodrag` so dragging inside a field never pans or
 * moves the node.
 */

import { useEffect, useMemo, useState } from 'react'
import { useFlowStore } from '@/store/flow'
import { useSettingsStore } from '@/store/settings'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import type { FieldDef } from '@/lib/flow/types'

interface Props {
  field: FieldDef
  value: unknown
  variant?: 'full' | 'inline'
  /** Field values used by `showWhen` gating and dynamic option lookups. */
  data: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  /** Batched history: focus opens, blur closes. */
  onFocus?: () => void
  onBlur?: () => void
}

/** Does this field apply given the node's current values? */
export function fieldVisible(field: FieldDef, data: Record<string, unknown>): boolean {
  if (!field.showWhen) return true
  return String(data[field.showWhen.key]) === String(field.showWhen.equals)
}

/**
 * Resolve a field's option list. Static `options` win; otherwise the runtime is
 * asked (providers / configured providers / the selected provider's models), so
 * the operator picks from what actually exists instead of typing a model id.
 */
function useFieldOptions(field: FieldDef, data: Record<string, unknown>, zh: boolean): Array<{ value: string; label: string }> {
  const providers = useSettingsStore((s) => s.providers)
  const loadProviders = useSettingsStore((s) => s.loadProviders)

  useEffect(() => {
    if (field.optionsFrom && providers.length === 0) void loadProviders().catch(() => undefined)
  }, [field.optionsFrom, providers.length, loadProviders])

  return useMemo(() => {
    if (field.options?.length) return field.options
    switch (field.optionsFrom) {
      case 'providers':
      case 'configured-providers': {
        const list = field.optionsFrom === 'configured-providers'
          ? providers.filter((p) => p.has_api_key)
          : providers
        return [
          { value: '', label: zh ? '（运行时默认）' : '(runtime default)' },
          ...list.map((p) => ({ value: p.id, label: `${p.display_name || p.id}${p.model_name ? ` · ${p.model_name}` : ''}` })),
        ]
      }
      case 'models': {
        const providerId = String(data[field.dependsOn || 'provider'] ?? '')
        const provider = providers.find((p) => p.id === providerId)
        const models = (provider as unknown as { models?: string[] } | undefined)?.models
        if (!models?.length) {
          return [{ value: '', label: zh ? '（供应商默认）' : '(provider default)' }]
        }
        return [
          { value: '', label: zh ? '（供应商默认）' : '(provider default)' },
          ...models.map((m) => ({ value: m, label: m })),
        ]
      }
      default:
        return []
    }
  }, [field.options, field.optionsFrom, field.dependsOn, providers, data, zh])
}

const NODRAG = 'nodrag nopan'

export function FlowField({ field, value, variant = 'full', data, onChange, onFocus, onBlur }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const dynamicOptions = useFieldOptions(field, data, zh)

  if (!fieldVisible(field, data)) return null

  const inline = variant === 'inline'
  const str = value === undefined || value === null ? '' : String(value)
  const isSelect = field.kind === 'select' || dynamicOptions.length > 0
  const common = cn(
    'rp-input',
    NODRAG,
    inline && 'flow-field-inline-control',
  )
  const batch = { onFocus, onBlur }

  const control = (() => {
    if (isSelect) {
      const opts = dynamicOptions.length ? dynamicOptions : (field.options ?? [])
      return (
        <select
          className={common}
          value={str}
          onChange={(e) => onChange(field.key, e.target.value)}
          title={field.placeholder || field.label}
        >
          {/* A value that is no longer offered must stay selectable, or the
              field would silently snap to the first option on render. */}
          {str && !opts.some((o) => o.value === str) ? <option value={str}>{str}</option> : null}
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    }
    switch (field.kind) {
      case 'switch':
        return (
          <button
            type="button"
            role="switch"
            aria-checked={str === 'yes' || str === 'true'}
            className={cn('flow-switch', NODRAG, str === 'yes' || str === 'true' && 'flow-switch-on')}
            onClick={() => onChange(field.key, str === 'yes' ? 'no' : 'yes')}
          >
            <span className="flow-switch-knob" />
          </button>
        )
      case 'number':
        return (
          <input
            className={common}
            type="number"
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(field.key, e.target.value === '' ? '' : Number(e.target.value))}
            {...batch}
          />
        )
      case 'textarea':
      case 'code':
        return (
          <textarea
            className={cn('rp-textarea', NODRAG, inline && 'flow-field-inline-control')}
            rows={inline ? Math.min(field.rows || 2, 3) : field.rows || 3}
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(field.key, e.target.value)}
            {...batch}
          />
        )
      case 'json':
        // Kept as a textarea rather than a rich editor: a JSON blob is written
        // far more often than it is browsed, and a pretty-printer would fight
        // the operator's cursor.
        return (
          <textarea
            className={cn('rp-textarea font-mono', NODRAG, inline && 'flow-field-inline-control')}
            rows={inline ? Math.min(field.rows || 2, 3) : field.rows || 3}
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(field.key, e.target.value)}
            {...batch}
          />
        )
      default:
        return (
          <input
            className={common}
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(field.key, e.target.value)}
            {...batch}
          />
        )
    }
  })()

  if (!inline) {
    return (
      <label className="flow-field">
        <span>{field.label}</span>
        {control}
      </label>
    )
  }

  return (
    <label className="flow-field-row">
      <span className="flow-field-row-label" title={field.label}>
        {field.label}
      </span>
      {control}
    </label>
  )
}

/** Convenience wrapper that writes straight into the store for a node. */
export function useFieldWriter(nodeId: string) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData)
  const beginBatch = useFlowStore((s) => s.beginBatch)
  const endBatch = useFlowStore((s) => s.endBatch)
  return {
    write: (key: string, value: unknown) => updateNodeData(nodeId, { [key]: value }),
    beginBatch,
    endBatch,
  }
}
