/**
 * AndroidModelGlass — 液态玻璃模型选择器（Android 专属）。
 *
 * 点击顶栏标题浮岛弹出。视觉上对齐 iOS 26 Liquid Glass：
 *   - 高斯模糊 + 饱和度提升的半透明底（backdrop-blur-2xl + saturate）
 *   - 顶部 1px 高光（specular highlight）+ 柔和大阴影
 *   - 弹簧曲线展开动画
 *
 * 结构：模型商列表 → 点开某个模型商 → 手风琴展开该模型商的模型列表
 * （configured_models 优先，未配置时走 /v1/providers/{id}/models 实时目录）。
 * 选中后走 setDefaultModel，与桌面端模型选择完全同一条数据链路。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { apiClient } from '@/api/client'
import type { ProviderInfo, ProviderModel } from '@/api/types'
import { useSettingsStore } from '@/store/settings'
import { useAppStore } from '@/store/app'
import { isProviderConfigured, getHiddenProviders } from '@/lib/providerState'
import { cn } from '@/lib/utils'
import { LiquidGlassSurface } from '@/components/ui/liquid-glass-surface'

/** iOS-26 liquid glass surface: blur + saturate + specular top edge.
 *  Theme-adaptive: frosted white in light mode, smoked glass in dark mode. */
export const LIQUID_GLASS_CLASS = [
  'border border-black/10 bg-white/55 backdrop-blur-2xl backdrop-saturate-150',
  'dark:border-black/10 dark:border-white/15 dark:bg-white/[0.06]',
  'shadow-[0_12px_40px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.6)]',
  'dark:shadow-[0_12px_40px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.22)]',
].join(' ')

/** Spring pop-in used when the sheet expands. */
const SHEET_ANIM_CLASS = 'origin-top animate-in fade-in zoom-in-95 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]'

interface AndroidModelGlassProps {
  open: boolean
  onClose: () => void
}

export function AndroidModelGlass({ open, onClose }: AndroidModelGlassProps) {
  const providers = useSettingsStore((s) => s.providers)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const loadProviders = useSettingsStore((s) => s.loadProviders)
  const refreshServerInfo = useAppStore((s) => s.refreshServerInfo)

  const usable = useMemo(() => {
    // Must mirror Composer's usableProviders filter: providers the user
    // "deleted" (hidden) never come back, even with default/key markers.
    const hidden = new Set(getHiddenProviders())
    return providers.filter((p) => !hidden.has(p.id) && isProviderConfigured(p))
  }, [providers])

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({})
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)

  // Reset the accordion each time the sheet opens; default-expand the
  // current provider so the common case (switch model, same vendor) is one tap.
  const currentProvider = useMemo(
    () => providers.find((p) => p.is_default) || providers.find((p) => p.id === defaultModel),
    [providers, defaultModel],
  )
  useEffect(() => {
    if (open) {
      setExpandedProvider(currentProvider?.id ?? null)
      setModelsByProvider({})
      if (currentProvider) void ensureModels(currentProvider)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror Composer's loadModelsForProvider: configured models immediately,
  // live catalog enrichment when nothing is configured.
  const ensureModels = async (provider: ProviderInfo) => {
    if (modelsByProvider[provider.id]) return
    const configured = (provider.configured_models || []).filter(Boolean)
    if (configured.length > 0) {
      setModelsByProvider((prev) => ({
        ...prev,
        [provider.id]: Array.from(new Set(configured)).map((id) => ({ id, name: id, owned_by: null })),
      }))
      // Enrich with catalog metadata in the background (reasoning ladder etc.).
      void apiClient.listProviderModels(provider.id).then((r) => {
        if (!r.ok || !r.models?.length) return
        const catalogMap = new Map(r.models.map((m) => [m.id, m]))
        setModelsByProvider((prev) => {
          const existing = prev[provider.id]
          if (!existing) return prev
          return {
            ...prev,
            [provider.id]: existing.map((m) => {
              const catalog = catalogMap.get(m.id)
              return catalog ? { ...m, ...catalog, id: m.id, name: m.name } : m
            }),
          }
        })
      }).catch(() => undefined)
      return
    }
    setLoadingProvider(provider.id)
    try {
      const r = await apiClient.listProviderModels(provider.id)
      const models = r.ok && r.models?.length
        ? r.models
        : provider.models?.map((id) => ({ id, name: id, owned_by: null })) || []
      // Last resort: the provider's currently pinned model is always a
      // valid choice even when neither the catalog nor the config lists it.
      const list = models.length > 0
        ? models
        : provider.model_name
          ? [{ id: provider.model_name, name: provider.model_name, owned_by: null }]
          : []
      setModelsByProvider((prev) => ({ ...prev, [provider.id]: list }))
    } catch {
      setModelsByProvider((prev) => ({
        ...prev,
        [provider.id]: provider.model_name
          ? [{ id: provider.model_name, name: provider.model_name, owned_by: null }]
          : [],
      }))
    } finally {
      setLoadingProvider(null)
    }
  }

  const handleSelectProvider = (provider: ProviderInfo) => {
    setExpandedProvider((cur) => (cur === provider.id ? null : provider.id))
    if (expandedProvider !== provider.id) void ensureModels(provider)
  }

  const handleSelectModel = async (provider: ProviderInfo, modelId: string) => {
    if (switching) return
    setSwitching(true)
    try {
      await apiClient.setDefaultModel(provider.id, modelId)
      await loadProviders()
      await refreshServerInfo()
      onClose()
    } finally {
      setSwitching(false)
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[480]" role="dialog" aria-modal="true" aria-label="选择模型">
      {/* Dismiss scrim — lighter than dialogs: a tap outside just closes. */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} role="presentation" />
      <LiquidGlassSurface
        className={cn(
          '!absolute left-1/2 top-14 w-[min(92vw,340px)] -translate-x-1/2',
          'max-h-[70vh] overflow-y-auto overscroll-contain',
          SHEET_ANIM_CLASS,
        )}
        contentClassName="android-model-glass-content"
      >
        {switching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-black/10 dark:bg-black/25">
            <Loader2 className="h-5 w-5 animate-spin text-foreground dark:text-white/90" />
          </div>
        )}
        {usable.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            没有已配置的模型商
          </div>
        )}
        {usable.map((provider) => {
          const isCurrent = provider.is_default || provider.id === defaultModel
          const isExpanded = expandedProvider === provider.id
          const models = modelsByProvider[provider.id]
          return (
            <div key={provider.id} className="mb-0.5 last:mb-0">
              <button
                type="button"
                onClick={() => handleSelectProvider(provider)}
                aria-expanded={isExpanded}
                aria-controls={isExpanded ? `provider-models-${provider.id}` : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-colors',
                  isExpanded ? 'bg-foreground/[0.06] dark:bg-white/[0.08]' : 'active:bg-foreground/[0.04] dark:active:bg-white/[0.06]',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground/90 dark:text-white/95">
                    {provider.display_name || provider.id}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground/80 dark:text-white/50">
                    {provider.model_name || '未设置模型'}
                  </span>
                </span>
                {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                <ChevronDown
                  className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/80 dark:text-white/50 transition-transform', isExpanded && 'rotate-180')}
                />
              </button>

              {isExpanded && (
                <div
                  id={`provider-models-${provider.id}`}
                  role="region"
                  aria-label={`${provider.display_name || provider.id} models`}
                  className="liquid-glass-disclosure ml-3 border-l border-black/10 pl-1 dark:border-white/15"
                >
                  {loadingProvider === provider.id && !models ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      加载模型…
                    </div>
                  ) : models && models.length > 0 ? (
                    models.map((m) => {
                      const isSelected = isCurrent && provider.model_name === m.id
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => void handleSelectModel(provider, m.id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-foreground/85 dark:text-white/85 transition-colors active:bg-foreground/[0.06] dark:bg-white/[0.08]',
                            isSelected && 'bg-foreground/[0.08] text-foreground dark:bg-white/[0.1] dark:text-white',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
                          {isSelected && <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                        </button>
                      )
                    })
                  ) : (
                    <div className="px-3 py-2 text-xs text-muted-foreground/70 dark:text-white/45">该模型商没有可用模型</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </LiquidGlassSurface>
    </div>,
    document.body,
  )
}
