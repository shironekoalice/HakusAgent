/**
 * Model picker dialog: fetch a provider's models and choose several at once.
 *
 * Behaviour is ported from the DeepSeek Harness settings-models client
 * (`dsh-client-ui-settings-models/lib/client.js`, `ModelListEditor`), which is
 * the only one of the two references that actually implements multi-select.
 * ZCode has no batch model fetch at all, so there was nothing to take from it
 * here beyond the capacity formatting used by `formatContextWindow`.
 *
 * The parts worth keeping from DSH, because each fixes a real failure mode:
 *
 * - `picked` is a `Set<string>` of ids, not a list of rows. Selection survives
 *   a re-fetch, and a model that disappears from the response keeps its entry.
 * - Select-all applies to the **visible** (search-filtered) rows only. A button
 *   labelled "select all" that also selected rows the user filtered away would
 *   silently add models they never saw.
 * - Newly discovered models are pre-selected, already-known ones are not. The
 *   user asked to see what is *available*, and re-ticking what they already
 *   have is noise.
 * - Applying merges by id (`byId.get(id) ?? adopt(candidate)`): an existing row
 *   keeps whatever the user configured on it, and only genuinely new ids are
 *   appended. Replacing the list would discard edits made before the fetch.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** One model as the Runtime reported it. */
export interface DiscoveredModel {
  id: string
  name?: string | null
  owned_by?: string | null
  context_window?: number | null
}

interface ModelPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Provider name for the title, e.g. `local`. */
  providerLabel: string
  models: DiscoveredModel[]
  /** Ids the caller already has, so they are neither pre-ticked nor duplicated. */
  knownIds: string[]
  loading: boolean
  /** Applies the chosen ids. The caller merges; this component does not own the form. */
  onApply: (ids: string[]) => void
  copy: (zh: string, en: string) => string
}

/**
 * Compact capacity label (`1M`, `256K`) for a token count.
 *
 * Formatting is pinned to `en-US`: a context window is a technical figure, and
 * a zh-CN `Intl` would render 1000000 as `100万`, which no provider's docs use.
 * This mirrors ZCode's `tokenNumberFormat.ts` note about capacity badges.
 */
export function formatContextWindow(tokens: number | null | undefined): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
  // No fraction digits: a capacity badge is a spec label, and `131.1K` is noise
  // next to the `131K` a provider's own docs quote. ZCode's badge does the same.
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 })
    .format(tokens)
    .toUpperCase()
}

/**
 * Which ids a fresh fetch should pre-tick.
 *
 * DSH pre-selects the models the user does *not* already have: the dialog was
 * opened to find out what is available, and re-ticking what is already
 * configured is noise that makes the useful rows harder to spot.
 */
export function presetPickedIds(
  models: DiscoveredModel[],
  knownIds: string[],
): Set<string> {
  const known = new Set(knownIds.map((id) => id.toLowerCase()))
  return new Set(models.filter((model) => !known.has(model.id.toLowerCase())).map((model) => model.id))
}

/**
 * Select-all / deselect-all over the rows the user can currently see.
 *
 * Scoped to the visible rows on purpose: a button the user can see must not
 * silently change rows that a search filter is hiding.
 */
export function toggleVisibleSelection(
  picked: Set<string>,
  visible: DiscoveredModel[],
): Set<string> {
  const next = new Set(picked)
  if (visible.length > 0 && visible.every((model) => picked.has(model.id))) {
    for (const model of visible) next.delete(model.id)
    return next
  }
  for (const model of visible) next.add(model.id)
  return next
}

/** Ids the dialog would add: ticked, and not already configured. */
export function pendingAdditions(
  models: DiscoveredModel[],
  picked: Set<string>,
  knownIds: string[],
): string[] {
  const known = new Set(knownIds.map((id) => id.toLowerCase()))
  return models
    .filter((model) => picked.has(model.id) && !known.has(model.id.toLowerCase()))
    .map((model) => model.id)
}

/**
 * Append new ids, never replacing or reordering what is already there.
 *
 * The fetch is additive, so a rename or removal the user made before probing is
 * preserved. Matching is case-insensitive because provider ids are not reliably
 * cased consistently across endpoint responses.
 */
export function mergeModelIds(current: string[], additions: string[]): string[] {
  if (additions.length === 0) return current
  const seen = new Set(current.map((id) => id.toLowerCase()))
  const fresh = additions.filter((id) => !seen.has(id.toLowerCase()))
  return fresh.length > 0 ? [...current, ...fresh] : current
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  providerLabel,
  models,
  knownIds,
  loading,
  onApply,
  copy,
}: ModelPickerDialogProps) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Seed selection once per opened response, the way DSH does: new ids ticked,
  // known ids left alone. Re-running on every render would fight the user.
  const seededFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      seededFor.current = null
      setQuery('')
      return
    }
    if (loading) return
    const signature = models.map((model) => model.id).join('\u0000')
    if (seededFor.current === signature) return
    seededFor.current = signature
    setPicked(presetPickedIds(models, knownIds))
  }, [open, loading, models, knownIds])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return models
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        (model.name ?? '').toLowerCase().includes(needle),
    )
  }, [models, query])

  const allVisiblePicked = visible.length > 0 && visible.every((model) => picked.has(model.id))

  const toggleVisible = () => {
    setPicked((current) => toggleVisibleSelection(current, visible))
  }

  const apply = () => {
    onApply(pendingAdditions(models, picked, knownIds))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {providerLabel} {copy('可用模型列表', 'Available models')}
          </DialogTitle>
          <DialogDescription>
            {copy(
              '勾选要添加的模型，可全选或取消全选；已在列表中的模型不会重复添加。',
              'Tick the models to add. Select all or clear the selection; models you already have are not added twice.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy('搜索模型', 'Search models')}
              className="h-8 pl-8 text-xs"
              aria-label={copy('搜索模型', 'Search models')}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleVisible}
            disabled={visible.length === 0}
          >
            {allVisiblePicked ? copy('取消全选', 'Deselect all') : copy('全选', 'Select all')}
          </Button>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {copy(`已选 ${picked.size}`, `${picked.size} selected`)}
          </span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {copy(`正在从 ${providerLabel} 拉取模型列表...`, `Fetching models from ${providerLabel}...`)}
            </div>
          ) : visible.length > 0 ? (
            <div className="space-y-1">
              {visible.map((model) => {
                const isKnown = knownIds.some((id) => id.toLowerCase() === model.id.toLowerCase())
                const capacity = formatContextWindow(model.context_window)
                return (
                  <label
                    key={model.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                      picked.has(model.id)
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-transparent hover:border-border hover:bg-muted/30',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                      checked={picked.has(model.id)}
                      onChange={(event) => {
                        setPicked((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(model.id)
                          else next.delete(model.id)
                          return next
                        })
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12px]">{model.id}</span>
                      {model.name && model.name !== model.id && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {model.name}
                        </span>
                      )}
                    </span>
                    {capacity && (
                      <Badge variant="secondary" className="shrink-0 text-[9px]">
                        {capacity}
                      </Badge>
                    )}
                    {isKnown && (
                      <Badge variant="outline" className="shrink-0 text-[9px] text-muted-foreground">
                        {copy('已有', 'Added')}
                      </Badge>
                    )}
                    {model.owned_by && (
                      <Badge variant="secondary" className="shrink-0 text-[9px]">
                        {model.owned_by}
                      </Badge>
                    )}
                  </label>
                )
              })}
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              {models.length === 0
                ? copy('未获取到任何模型', 'No models returned')
                : copy('没有匹配的模型', 'No models match the search')}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {copy('取消', 'Cancel')}
          </Button>
          <Button type="button" size="sm" onClick={apply} disabled={loading}>
            {copy(`添加 ${picked.size} 个模型`, `Add ${picked.size} model(s)`)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
