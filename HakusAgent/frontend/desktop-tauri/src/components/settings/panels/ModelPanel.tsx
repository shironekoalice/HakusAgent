/**
 * Model provider panel — Phase 1 升级版
 *
 * 对齐 Cherry Studio 的 ProviderSettings 设计, 但保持 HakusAI 自己的简洁风格.
 *
 * 新增功能 (P0):
 *   - 左侧 Provider 列表分组 (国内/国际/本地/聚合) + 搜索框
 *   - 右侧编辑表单新增 4 个按钮:
 *     1. 「测试连接」 — 调 /api/providers/{id}/test, 显示 ok / 延迟 / 错误详情
 *     2. 「获取模型列表」 — 调 /api/providers/{id}/fetch-models, 弹窗勾选写入
 *     3. 「多 Key 管理」 — 列出/添加/删除额外 Key (主 Key 不动)
 *     4. 「自定义 Header」 — 兼容第三方中转 (DMXAPI / OpenRouter 等)
 *
 * 保留原有: Model Name / Base URL / API Key / 设为默认 / 保存配置.
 *
 * 不变: 与 settings store 的接口完全不变, 只是新增能力.
 */

import { useEffect, useState, useMemo, useRef } from 'react'
import { GlassSelect } from '@/components/ui/glass-select'
import {
  Check, Eye, EyeOff, Loader2,
  Activity, ListPlus, KeyRound, Settings2, Search, Trash2, Plus, RefreshCw,
  CheckCircle2, XCircle, ArrowLeft, ChevronDown, Pencil, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { isProviderConfigured, getHiddenProviders, hideProvider, unhideProvider } from '@/lib/providerState'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { useSettingsStore } from '@/store/settings'
import { apiClient, BackendOutdatedError } from '@/api/client'
import { BackendOutdatedBanner } from '@/components/settings/BackendOutdatedBanner'
import { ProviderLogo } from '@/components/ui/provider-logo'
import { ModelPickerDialog, type DiscoveredModel, mergeModelIds } from '@/components/settings/panels/ModelPickerDialog'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import type {
  ProviderInfo, ProviderMeta, ProviderModel, ProviderKeyEntry,
  ConnectionTestResult,
} from '@/api/types'

// Provider 默认 model_name 占位符（参考 TUI model_config_overlay）
const DEFAULT_MODEL_HINTS: Record<string, string> = {
  opencode: 'deepseek-v4-flash-free',
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet-20241022',
  qwen: 'qwen-plus',
  gemini: 'gemini-1.5-flash',
  glm: 'glm-4-flash',
  mimo: 'mimo-7b-rl',
  ollama: 'qwen2.5:7b',
}

// 默认 Base URL 提示
const DEFAULT_BASE_URL_HINTS: Record<string, string> = {
  opencode: 'https://api.opencode.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  mimo: 'https://api.mimo.xiaomi.com/v1',
  ollama: 'http://localhost:11434/v1',
}

function providerRouteHint(provider: ProviderInfo, locale: 'zh-CN' | 'en-US'): string {
  const protocol = provider.wire === 'anthropic'
    ? 'Anthropic Messages'
    : provider.wire === 'responses'
      ? 'OpenAI Responses'
      : 'OpenAI Chat Completions'
  const auth = provider.auth_mode === 'oauth' ? 'OAuth' : provider.auth_mode === 'none'
    ? (locale === 'zh-CN' ? '无需密钥' : 'No key required')
    : 'API Key'
  return `${protocol} · ${auth}`
}

function providerGroupLabel(group: string, locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'zh-CN') return group
  const labels: Record<string, string> = {
    '国内服务': 'China services',
    '国际服务': 'International services',
    '聚合 / 中转': 'Aggregators / gateways',
    '本地 / 自托管': 'Local / self-hosted',
    '自定义模型商': 'Custom providers',
    '自定义': 'Custom',
    '其他': 'Other',
  }
  return labels[group] || group
}

export function ModelPanel() {
  const toast = useToast()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const providers = useSettingsStore((s) => s.providers)
  const providersLoading = useSettingsStore((s) => s.providersLoading)
  const providersError = useSettingsStore((s) => s.providersError)
  const loadProviders = useSettingsStore((s) => s.loadProviders)
  const resetProvidersLoading = useSettingsStore((s) => s.resetProvidersLoading)

  const [selectedId, setSelectedId] = useState<string>('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [customEditorOpen, setCustomEditorOpen] = useState(false)
  const [modelName, setModelName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiFormat, setApiFormat] = useState<'openai' | 'responses' | 'anthropic'>('openai')
  // 上下文窗口（token 数），以字符串保存输入态以便区分「空」与「0」。
  // 中转站/自建路由不在内置模型目录里，只有用户手填后上下文圆环才能显示占比。
  const [contextWindow, setContextWindow] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [providerModels, setProviderModels] = useState<string[]>([])
  const [newModel, setNewModel] = useState('')
  // 正在就地重命名的模型（值为原模型 ID），null = 没有编辑中的行。
  const [editingModel, setEditingModel] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [saving, setSaving] = useState(false)

  // ── 自动保存：模型相关配置改动后防抖落盘，无需手动点保存 ──
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const savedSnapshotRef = useRef<{ providerId: string; modelName: string; baseUrl: string; apiFormat: string; models: string[]; contextWindow: string } | null>(null)

  // ── 批量删除自定义模型商（内置确认弹窗，不用系统 confirm）──
  const [deleteSelection, setDeleteSelection] = useState<string[]>([])
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // 新增: provider 元数据 (分组)
  const [metaList, setMetaList] = useState<ProviderMeta[]>([])
  const [search, setSearch] = useState('')

  // 新增: 测试连接状态
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  // 新增: 获取模型列表对话框
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<ProviderModel[]>([])

  // 新增: 多 Key 管理对话框
  const [keysDialogOpen, setKeysDialogOpen] = useState(false)
  const [keyList, setKeyList] = useState<ProviderKeyEntry[]>([])
  const [newKey, setNewKey] = useState('')
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [keysLoading, setKeysLoading] = useState(false)

  // 新增: 自定义 Header 对话框
  const [headersDialogOpen, setHeadersDialogOpen] = useState(false)
  const [headerEntries, setHeaderEntries] = useState<{ k: string; v: string }[]>([])
  const [customSaving, setCustomSaving] = useState(false)
  const [customModels, setCustomModels] = useState<string[]>([])
  const [customNewModel, setCustomNewModel] = useState('')
  // New-provider model discovery. A provider being created has no saved
  // configuration, so the probe carries the endpoint and key from the form
  // itself; the Runtime accepts an unknown id when it is given an endpoint.
  const [customPickerOpen, setCustomPickerOpen] = useState(false)
  const [customDiscovering, setCustomDiscovering] = useState(false)
  const [customDiscovered, setCustomDiscovered] = useState<DiscoveredModel[]>([])
  // 自定义模型商编辑器里的就地重命名（与内置模型商同一套交互）。
  const [editingCustomModel, setEditingCustomModel] = useState<string | null>(null)
  const [editingCustomValue, setEditingCustomValue] = useState('')
  const [lastProviderRefresh, setLastProviderRefresh] = useState<Date | null>(null)
  const [customForm, setCustomForm] = useState({
    id: '', display_name: '', base_url: '', model: '', api_key: '', api_key_env: '', group: '自定义模型商', wire: 'openai',
  })
  const providerFormRef = useRef<HTMLDivElement | null>(null)
  const refreshInFlightRef = useRef(false)

  // 初次加载拉 provider 列表 + meta
  useEffect(() => {
    let active = true
    const state = useSettingsStore.getState()
    if (state.providersLoading && state.providersLoadingSince) {
      const elapsed = Date.now() - state.providersLoadingSince
      if (elapsed > 12000) {
        console.warn(`[ModelPanel] resetting stuck providersLoading (elapsed=${elapsed}ms)`)
        resetProvidersLoading()
      }
    }
    if (useSettingsStore.getState().providers.length === 0 && !useSettingsStore.getState().providersLoading) {
      loadProviders()
    }
    // 同时拉 provider 元数据 (分组用)
    apiClient.getProvidersMeta().then((r) => {
      if (active) setMetaList(r.providers)
    }).catch((e) => {
      console.warn('[ModelPanel] getProvidersMeta failed:', e)
    })
    return () => { active = false }
  }, [loadProviders, resetProvidersLoading])

  // Provider catalogs change independently from the current form (new routes,
  // rotated credentials, updated defaults). Refresh in the background so the
  // picker stays current without making the user reopen Settings.
  useEffect(() => {
    let active = true
    const refresh = async () => {
      if (
        !active
        || document.visibilityState !== 'visible'
        || !navigator.onLine
        || refreshInFlightRef.current
      ) return

      refreshInFlightRef.current = true
      try {
        await Promise.all([
          loadProviders(),
          apiClient.getProvidersMeta().then((r) => {
            if (active) setMetaList(r.providers)
          }),
        ])
        if (active) setLastProviderRefresh(new Date())
      } catch (error) {
        console.warn('[ModelPanel] background provider refresh failed:', error)
      } finally {
        refreshInFlightRef.current = false
      }
    }
    const timer = window.setInterval(refresh, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [loadProviders])

  // 默认选中 is_default 或第一个
  useEffect(() => {
    if (!selectedId && providers.length > 0) {
      const def = providers.find((p) => p.is_default) || providers[0]
      setSelectedId(def.id)
    }
  }, [providers, selectedId])

  // 选中变化时同步表单
  const selected: ProviderInfo | undefined = providers.find((p) => p.id === selectedId)
  useEffect(() => {
    if (selected) {
      // Each provider has its own detail form. Do not carry the previous
      // provider's scroll offset into the newly selected form.
      if (providerFormRef.current) providerFormRef.current.scrollTop = 0
      setModelName(selected.model_name || '')
      setBaseUrl(selected.base_url || '')
      setApiFormat(selected.wire === 'anthropic' ? 'anthropic' : selected.wire === 'responses' ? 'responses' : 'openai')
      setApiKey('')
      setShowKey(false)
      // `models` is the provider's catalog (or a live discovery result), not
      // necessarily user configuration. Keep the editor focused on models
      // the user has actually selected, plus the current model for legacy
      // configs that predate `configured_models`.
      const configuredModels = Array.isArray(selected.configured_models)
        ? selected.configured_models
        : []
      const initialModels = configuredModels.length > 0
        ? configuredModels
        : (selected.model_name ? [selected.model_name] : [])
      setProviderModels(Array.from(new Set(initialModels)))
      const initialContextWindow = selected.context_window ? String(selected.context_window) : ''
      setContextWindow(initialContextWindow)
      setNewModel('')
      setTestResult(null) // 切换 provider 时清空上次测试结果
      savedSnapshotRef.current = {
        providerId: selected.id,
        modelName: selected.model_name || '',
        baseUrl: selected.base_url || '',
        apiFormat: selected.wire === 'anthropic' ? 'anthropic' : selected.wire === 'responses' ? 'responses' : 'openai',
        models: Array.from(new Set(initialModels)),
        contextWindow: initialContextWindow,
      }
      setSaveState('idle')
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 分组 + 搜索过滤
  const groupedProviders = useMemo(() => {
    const metaMap = new Map(metaList.map((m) => [m.id, m]))
    const hidden = new Set(getHiddenProviders())
    const filtered = providers.filter((p) => {
      // 已被用户"删除"的内置目录条目从概览隐藏；搜索是找回它们的通道。
      if (!search.trim() && hidden.has(p.id)) return false
      // Dsh keeps the overview focused on routes the user has actually added
      // or enabled. Searching is the explicit escape hatch for the full
      // built-in catalog, so no provider becomes unreachable.
      if (!search.trim()) {
        return p.is_custom || p.enabled !== false || p.has_api_key || p.is_default || p.id === 'ollama'
      }
      const q = search.toLowerCase()
      return p.id.toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q)
    })
    const groups = new Map<string, ProviderInfo[]>()
    for (const p of filtered) {
      const g = metaMap.get(p.id)?.group ?? (p.is_custom ? '自定义模型商' : '其他')
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(p)
    }
    // 按 meta 的 groups 顺序排序
    const preferred = ['国内服务', '国际服务', '聚合 / 中转', '本地 / 自托管', '自定义模型商', '自定义', '其他']
    const order = [
      ...preferred,
      ...Array.from(new Set(metaList.map((m) => m.group))),
      ...Array.from(groups.keys()),
    ].filter((group, index, all) => all.indexOf(group) === index)
    return order
      .filter((g) => groups.has(g))
      .map((g) => ({ group: g, items: groups.get(g)! }))
  }, [providers, metaList, search])

  const openProviderEditor = (providerId?: string) => {
    const nextId = providerId
      || providers.find((provider) => provider.enabled === false)?.id
      || providers.find((provider) => !provider.has_api_key && provider.id !== 'ollama')?.id
      || providers[0]?.id
    if (!nextId) return
    if (getHiddenProviders().includes(nextId)) unhideProvider(nextId)
    setSelectedId(nextId)
    setEditorOpen(true)
  }

  const persistNow = async (overrides?: { apiKey?: string }) => {
    if (!selected || saving) return
    setSaving(true)
    setSaveState('saving')
    try {
      const body: Record<string, any> = { provider: selected.id }
      if (modelName.trim()) body.model_name = modelName.trim()
      if (selected.has_url) body.base_url = baseUrl.trim()
      const key = overrides?.apiKey ?? apiKey
      if (selected.id !== 'ollama' && key.trim()) body.api_key = key.trim()
      body.models = providerModels
      body.enabled = selected.enabled !== false
      body.wire = apiFormat
      // 空字符串 = 清除已保存的值（发送显式 null），非空必须是合法正整数。
      const trimmedContextWindow = contextWindow.trim()
      if (trimmedContextWindow) {
        const parsed = Number(trimmedContextWindow)
        if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
          setSaveState('error')
          toast.error(copy('上下文窗口必须是正整数（token 数）', 'Context window must be a positive integer (tokens)'))
          setSaving(false)
          return
        }
        body.context_window = parsed
      } else {
        body.context_window = null
      }
      await apiClient.updateProvider(body as any)
      savedSnapshotRef.current = {
        providerId: selected.id,
        modelName: modelName.trim(),
        baseUrl: baseUrl.trim(),
        apiFormat,
        models: providerModels,
        contextWindow: trimmedContextWindow,
      }
      if (overrides?.apiKey) {
        setApiKey('')
        setShowKey(false)
      }
      setSaveState('saved')
      setSavedAt(new Date())
      await loadProviders()
    } catch (e: any) {
      setSaveState('error')
      toast.error(copy(`保存失败：${e?.message || e}`, `Save failed: ${e?.message || e}`))
    } finally {
      setSaving(false)
    }
  }

  // Manual save: edits stay local until the user clicks 保存. The status
  // pill only reflects the in-flight/saved/error state of that explicit save.
  // (Changed from the old 800ms debounced auto-save per user request.)

  // Editing a provider that is no longer in the list (deleted elsewhere, or
  // a creation whose persistence is still settling) must not render an empty
  // pane — bounce back to the overview once loading has settled.
  // Must stay above every early return so hook order never changes (React #300).
  useEffect(() => {
    if (!editorOpen || customEditorOpen || selected || providersLoading) return
    const timer = setTimeout(() => setEditorOpen(false), 1200)
    return () => clearTimeout(timer)
  }, [editorOpen, customEditorOpen, selected, providersLoading])

  const handleUseModel = async () => {
    if (!selected) return
    const model = modelName.trim() || providerModels[0]
    if (!model) {
      toast.error(copy('请先添加或选择一个模型', 'Add or select a model first'))
      return
    }
    setSaving(true)
    try {
      await apiClient.setDefaultModel(selected.id, model)
      toast.success(copy(`已切换当前模型为 ${selected.display_name} / ${model}`, `Current model changed to ${selected.display_name} / ${model}`))
      await loadProviders()
    } catch (e: any) {
      toast.error(copy(`切换失败：${e?.message || e}`, `Could not switch model: ${e?.message || e}`))
    } finally {
      setSaving(false)
    }
  }

  // === 测试连接 ===
  const handleTestConnection = async () => {
    if (!selected) return
    setTesting(true)
    setTestResult(null)
    try {
      // 如果用户刚填了 api_key/base_url/model 但还没保存, 用这些值临时测试
      const overrides: Record<string, any> = {}
      if (apiKey.trim()) overrides.api_key = apiKey.trim()
      if (selected.has_url && baseUrl.trim()) overrides.base_url = baseUrl.trim()
      if (modelName.trim()) overrides.model = modelName.trim()
      const r = await apiClient.testProviderConnection(selected.id, overrides)
      setTestResult(r)
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch (e: any) {
      setTestResult({
        ok: false,
        message: copy(`测试失败: ${e?.message || e}`, `Test failed: ${e?.message || e}`),
        detail: undefined,
        latency_ms: null,
      })
      toast.error(copy(`测试失败：${e?.message || e}`, `Test failed: ${e?.message || e}`))
    } finally {
      setTesting(false)
    }
  }

  // === 获取模型列表 ===
  const handleFetchModels = async () => {
    if (!selected) return
    setFetchingModels(true)
    setModelDialogOpen(true)
    setFetchedModels([])
    try {
      const overrides: Record<string, any> = {}
      if (apiKey.trim()) overrides.api_key = apiKey.trim()
      if (selected.has_url && baseUrl.trim()) overrides.base_url = baseUrl.trim()
      const r = await apiClient.fetchProviderModels(selected.id, overrides)
      if (r.ok && r.models.length > 0) {
        setFetchedModels(r.models)
        toast.success(r.message)
      } else if (!r.ok) {
        toast.error(r.message || copy('获取模型列表失败', 'Could not fetch models'))
      } else {
        toast.info(copy('该 provider 未返回任何模型', 'This provider returned no models'))
      }
    } catch (e: any) {
      toast.error(copy(`获取失败：${e?.message || e}`, `Fetch failed: ${e?.message || e}`))
    } finally {
      setFetchingModels(false)
    }
  }

  // === 新建模型商时的可用模型列表 ===
  //
  // The provider does not exist in config yet, so the probe has to carry the
  // endpoint and key the user is about to save. The Runtime resolves an unknown
  // id as a generic OpenAI-compatible route when a base_url is supplied, which
  // is what makes this work before the first save.
  const handleFetchCustomModels = async () => {
    const baseUrlValue = customForm.base_url.trim()
    if (!baseUrlValue) {
      toast.error(copy('请先填写 Base URL', 'Enter a Base URL first'))
      return
    }
    const providerId = customForm.id.trim() || 'custom-provider'
    setCustomPickerOpen(true)
    setCustomDiscovering(true)
    setCustomDiscovered([])
    try {
      const overrides: Record<string, any> = { base_url: baseUrlValue }
      if (customForm.api_key.trim()) overrides.api_key = customForm.api_key.trim()
      const r = await apiClient.fetchProviderModels(providerId, overrides)
      if (r.ok && r.models.length > 0) {
        setCustomDiscovered(r.models)
        toast.success(copy(`获取到 ${r.models.length} 个模型`, `Found ${r.models.length} models`))
      } else if (!r.ok) {
        toast.error(r.message || copy('获取模型列表失败', 'Could not fetch models'))
      } else {
        toast.info(copy('该服务未返回任何模型', 'This service returned no models'))
      }
    } catch (e: any) {
      toast.error(copy(`获取失败：${e?.message || e}`, `Fetch failed: ${e?.message || e}`))
    } finally {
      setCustomDiscovering(false)
    }
  }

  /**
   * Append newly discovered ids, keeping any row the user already configured.
   *
   * Mirrors DSH's `byId.get(id) ?? adopt(candidate)`: the fetch is additive. A
   * replace would silently discard a rename the user made before probing.
   */
  const handleApplyCustomModels = (ids: string[]) => {
    if (ids.length === 0) return
    setCustomModels((current) => mergeModelIds(current, ids))
    toast.success(copy(`已添加 ${ids.length} 个模型`, `Added ${ids.length} model(s)`))
  }

  // === 多 Key 管理 ===
  const handleOpenKeys = async () => {
    if (!selected) return
    setKeysDialogOpen(true)
    setKeysLoading(true)
    try {
      const ks = await apiClient.listProviderKeys(selected.id)
      setKeyList(ks)
    } catch (e: any) {
      toast.error(copy(`加载 Key 列表失败：${e?.message || e}`, `Could not load key list: ${e?.message || e}`))
    } finally {
      setKeysLoading(false)
    }
  }

  const handleAddKey = async () => {
    if (!selected || !newKey.trim()) return
    try {
      const entry = await apiClient.addProviderKey(selected.id, newKey.trim(), newKeyLabel.trim())
      setKeyList((ks) => [...ks, entry])
      setNewKey('')
      setNewKeyLabel('')
      toast.success(copy('已添加 Key', 'Key added'))
    } catch (e: any) {
      toast.error(copy(`添加失败：${e?.message || e}`, `Could not add: ${e?.message || e}`))
    }
  }

  const handleDeleteKey = async (keyId: string) => {
    if (!selected) return
    try {
      await apiClient.deleteProviderKey(selected.id, keyId)
      setKeyList((ks) => ks.filter((k) => k.id !== keyId))
      toast.success(copy('已删除 Key', 'Key deleted'))
    } catch (e: any) {
      toast.error(copy(`删除失败：${e?.message || e}`, `Could not delete: ${e?.message || e}`))
    }
  }

  // === 自定义 Header ===
  const handleOpenHeaders = async () => {
    if (!selected) return
    setHeadersDialogOpen(true)
    try {
      const h = await apiClient.getProviderHeaders(selected.id)
      const entries = Object.entries(h).map(([k, v]) => ({ k, v }))
      setHeaderEntries(entries.length > 0 ? entries : [{ k: '', v: '' }])
    } catch (e: any) {
      toast.error(copy(`加载 Header 失败：${e?.message || e}`, `Could not load headers: ${e?.message || e}`))
      setHeaderEntries([{ k: '', v: '' }])
    }
  }

  const handleSaveHeaders = async () => {
    if (!selected) return
    const obj: Record<string, string> = {}
    for (const { k, v } of headerEntries) {
      if (k.trim() && v.trim()) obj[k.trim()] = v.trim()
    }
    try {
      await apiClient.setProviderHeaders(selected.id, obj)
      toast.success(copy(`已保存 ${Object.keys(obj).length} 个自定义 Header`, `Saved ${Object.keys(obj).length} custom headers`))
      setHeadersDialogOpen(false)
    } catch (e: any) {
      toast.error(copy(`保存失败：${e?.message || e}`, `Save failed: ${e?.message || e}`))
    }
  }

  const handleCreateCustomProvider = async () => {
    const id = customForm.id.trim()
    const baseUrlValue = customForm.base_url.trim()
    if (!id || !baseUrlValue) {
      toast.error(copy('请填写模型商 ID 和 Base URL', 'Enter a provider ID and Base URL'))
      return
    }
    setCustomSaving(true)
    try {
      await apiClient.createCustomProvider({
        id,
        display_name: customForm.display_name.trim() || id,
        base_url: baseUrlValue,
        model: customModels[0] || undefined,
        api_key: customForm.api_key.trim() || undefined,
        api_key_env: customForm.api_key_env.trim() || undefined,
        group: customForm.group.trim() || copy('自定义模型商', 'Custom providers'),
        models: customModels,
        enabled: true,
        wire: customForm.wire,
      })
      // The runtime persists asynchronously — the freshly created provider
      // can be missing from the first refreshed list. Wait (briefly) for it
      // to appear before opening the editor, otherwise `selected` resolves
      // undefined and the editor renders an empty black pane.
      let created = providers.find((provider) => provider.id === id)
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        await loadProviders()
        created = useSettingsStore.getState().providers.find((provider) => provider.id === id)
      }
      if (created) {
        setSelectedId(id)
        setCustomEditorOpen(false)
        setEditorOpen(true)
      } else {
        setCustomEditorOpen(false)
        setEditorOpen(false)
        toast.success(copy('自定义模型商已添加，可在列表中打开', 'Custom provider added; open it from the list'))
      }
      resetCustomProviderForm()
      if (created) toast.success(copy('自定义模型商已添加', 'Custom provider added'))
    } catch (error: any) {
      toast.error(copy(`添加失败：${error?.message || error}`, `Could not add: ${error?.message || error}`))
    } finally {
      setCustomSaving(false)
    }
  }

  const confirmDeleteIds = (ids: string[]) => {
    setDeleteSelection(ids)
    setConfirmDeleteOpen(true)
  }

  // 内置模型商"删除"：重置本地配置（停用、清空模型列表与密钥）并从列表隐藏。
  // 目录条目本身无法从 Runtime 配置移除，重新添加会自动解除隐藏。
  const handleDeleteBuiltinProvider = async (id: string) => {
    try {
      await apiClient.updateProvider({ provider: id, enabled: false, models: [] })
      hideProvider(id)
      await loadProviders()
      if (selectedId === id) {
        setSelectedId('')
        setEditorOpen(false)
      }
      return true
    } catch (error: any) {
      toast.error(copy(`删除失败：${error?.message || error}`, `Could not delete: ${error?.message || error}`))
      return false
    }
  }

  const handleDeleteCustomProvider = async () => {
    if (!selected?.is_custom) return
    confirmDeleteIds([selected.id])
  }

  const runBatchDelete = async () => {
    const ids = [...deleteSelection]
    if (ids.length === 0) return
    setDeleting(true)
    const failed: string[] = []
    for (const id of ids) {
      try {
        const provider = providers.find((p) => p.id === id)
        if (provider?.is_custom) {
          await apiClient.deleteCustomProvider(id)
        } else {
          const ok = await handleDeleteBuiltinProvider(id)
          if (!ok) failed.push(id)
        }
      } catch (error: any) {
        failed.push(`${id}: ${error?.message || error}`)
      }
    }
    setDeleteSelection([])
    setConfirmDeleteOpen(false)
    await loadProviders()
    if (selectedId && ids.includes(selectedId)) {
      setSelectedId('')
      setEditorOpen(false)
    }
    setDeleting(false)
    if (failed.length === 0) {
      if (ids.length === 1) {
        const name = providers.find((p) => p.id === ids[0])?.display_name || ids[0]
        toast.success(copy(`已删除 ${name}`, `Deleted ${name}`))
      } else {
        toast.success(copy(`已删除 ${ids.length} 个模型商`, `Deleted ${ids.length} provider(s)`))
      }
    } else {
      toast.error(copy(`部分删除失败：${failed.join('；')}`, `Some deletions failed: ${failed.join('; ')}`))
    }
  }

  const resetCustomProviderForm = () => {
    setCustomForm({
      id: '',
      display_name: '',
      base_url: '',
      model: '',
      api_key: '',
      api_key_env: '',
      group: copy('自定义模型商', 'Custom providers'),
      wire: 'openai',
    })
    setCustomModels([])
    setCustomNewModel('')
  }

  const handleAddCustomModel = () => {
    const id = customNewModel.trim()
    if (!id) return
    if (customModels.some((m) => m.toLowerCase() === id.toLowerCase())) {
      setCustomNewModel('')
      return
    }
    setCustomModels((prev) => [...prev, id])
    setCustomNewModel('')
  }

  const handleRemoveCustomModel = (model: string) => {
    setCustomModels((prev) => prev.filter((m) => m !== model))
  }

  // 列表首位即当前模型，重命名第一项时要连当前模型 ID 一起更新，
  // 否则保存后配置里的 `model` 与列表对不上。
  const handleRenameCustomModel = (from: string, to: string) => {
    const value = to.trim()
    if (!value || value === from) {
      setEditingCustomModel(null)
      return
    }
    const clash = customModels.some(
      (m) => m !== from && m.toLowerCase() === value.toLowerCase(),
    )
    if (clash) return
    const wasFirst = customModels[0] === from
    setCustomModels((prev) => prev.map((m) => (m === from ? value : m)))
    if (wasFirst) setCustomForm((v) => ({ ...v, model: value }))
    setEditingCustomModel(null)
  }

  const handleToggleProvider = async (enabled: boolean, providerOverride?: ProviderInfo) => {
    const target = providerOverride || selected
    if (!target) return
    const models = target.id === selected?.id
      ? providerModels
      : (target.configured_models || (target.model_name ? [target.model_name] : []))
    setSaving(true)
    try {
      await apiClient.updateProvider({
        provider: target.id,
        enabled,
        model_name: target.id === selected?.id ? (modelName.trim() || undefined) : (target.model_name || undefined),
        models: target.id === selected?.id ? models : undefined,
        wire: target.id === selected?.id ? apiFormat : target.wire,
      })
      await loadProviders()
      toast.success(enabled ? copy(`${target.display_name} 已启用`, `${target.display_name} enabled`) : copy(`${target.display_name} 已停用`, `${target.display_name} disabled`))
    } catch (error: any) {
      toast.error(copy(`更新失败：${error?.message || error}`, `Update failed: ${error?.message || error}`))
    } finally {
      setSaving(false)
    }
  }

  const handleAddModel = () => {
    const value = newModel.trim()
    if (!value) return
    setProviderModels((current) => current.some((item) => item.toLowerCase() === value.toLowerCase()) ? current : [...current, value])
    if (!modelName.trim()) setModelName(value)
    setNewModel('')
  }

  // 就地重命名一条模型记录。中转站/自建路由的模型 ID 经常要改（上游换了
  // 别名、手抄时打错），此前只能删掉重加，而删掉会连带清掉「当前模型」的
  // 选择。重命名保留它在列表中的位置，并把当前模型指针一起跟着走。
  const handleRenameModel = (from: string, to: string) => {
    const value = to.trim()
    if (!value || value === from) {
      setEditingModel(null)
      return
    }
    // 与添加保持同一套去重规则：大小写不敏感，避免同一 ID 出现两次。
    const clash = providerModels.some(
      (item) => item !== from && item.toLowerCase() === value.toLowerCase(),
    )
    if (clash) return
    setProviderModels((current) => current.map((item) => (item === from ? value : item)))
    if (modelName === from) setModelName(value)
    setEditingModel(null)
  }

  const handleRemoveModel = (model: string) => {
    setProviderModels((current) => current.filter((item) => item !== model))
    if (modelName === model) {
      setModelName(providerModels.find((item) => item !== model) || '')
    }
  }

  // Loading and backend failures belong to the catalog entry point too. An
  // empty provider list should explain its state before offering actions.
  if (providersLoading && providers.length === 0) {
    return (
      <div className="space-y-3 py-12">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {copy('加载 provider 列表...', 'Loading providers...')}
        </div>
        <div className="text-center text-[11px] text-muted-foreground">
          {copy('如果超过 10s 未响应，将自动显示错误信息', 'An error will appear automatically if this takes longer than 10 seconds')}
        </div>
      </div>
    )
  }

  if (providersError && providers.length === 0) {
    if (providersError instanceof BackendOutdatedError) {
      return (
        <BackendOutdatedBanner
          message={providersError.message}
          backendVersion={providersError.backendVersion}
          onRetry={() => loadProviders()}
        />
      )
    }
    return (
      <div className="space-y-3 py-6">
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">
          <div className="mb-1 font-medium">{copy('加载 Provider 列表失败', 'Could not load providers')}</div>
          <div className="break-all text-[12px] text-red-500/80">{providersError.message}</div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {copy('模型列表暂时无法加载，请稍后重试或重新打开 HakusAI。', 'The model list is temporarily unavailable. Try again or reopen HakusAI.')}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadProviders()}>
          {copy('重试', 'Retry')}
        </Button>
      </div>
    )
  }

  // Keep the first screen focused on the provider catalog. Editing a route is
  // an intentional second step, matching the compact Dsh settings flow.
  if (!editorOpen) {
    return (
      <div className="model-provider-overview mx-auto w-full max-w-3xl space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{copy('模型', 'Models')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy('填入各模型商的 API 密钥即可使用对应模型。', 'Add a provider API key to use its models.')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => void loadProviders().then(() => setLastProviderRefresh(new Date()))}
            disabled={providersLoading}
            title={copy('刷新模型商列表', 'Refresh providers')}
            aria-label={copy('刷新模型商列表', 'Refresh providers')}
          >
            <RefreshCw className={cn('h-4 w-4', providersLoading && 'animate-spin')} />
          </Button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy('搜索模型商…', 'Search providers…')}
            className="h-9 rounded-lg pl-9"
          />
        </div>

        <div className="space-y-5">
          {groupedProviders.map(({ group, items }) => (
            <section key={group} aria-labelledby={`provider-group-${group}`} className="space-y-2.5">
              <h3 id={`provider-group-${group}`} className="px-1 text-xs font-semibold text-muted-foreground">
                {providerGroupLabel(group, locale)}
              </h3>
              <div className="model-provider-overview-list">
                {items.map((provider) => {
                  const enabled = provider.enabled !== false
                  const configured = provider.has_api_key || provider.auth_mode === 'none' || provider.id === 'ollama'
                  return (
                    <div
                      key={provider.id}
                      className={cn(
                        'model-provider-overview-row group relative flex items-center gap-3 px-3.5 py-2.5',
                        !enabled && 'opacity-65',
                      )}
                    >
                      <ProviderLogo providerId={provider.id} size={24} className="shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold">{provider.display_name}</span>
                          <span
                            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', configured ? 'bg-emerald-400' : 'bg-amber-400')}
                            title={configured ? copy('已配置', 'Configured') : copy('尚未配置密钥', 'API key not configured')}
                            aria-label={configured ? copy('已配置', 'Configured') : copy('尚未配置密钥', 'API key not configured')}
                          />
                          {provider.is_default && <span className="text-[10px] text-muted-foreground">{copy('当前使用', 'In use')}</span>}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {provider.model_name || copy('尚未选择模型', 'No model selected')}
                        </p>
                      </div>
                      <Switch
                        checked={enabled}
                        disabled={saving}
                        onCheckedChange={(value) => void handleToggleProvider(value, provider)}
                        aria-label={`${provider.display_name} ${enabled ? copy('已启用', 'enabled') : copy('已停用', 'disabled')}`}
                        className="h-5 w-9 shrink-0"
                      />
                      <Button
                        type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => confirmDeleteIds([provider.id])}
                        title={provider.is_custom ? copy('删除', 'Delete') : copy('删除（重置并隐藏）', 'Delete (reset & hide)')}
                        aria-label={`${copy('删除', 'Delete')} ${provider.display_name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0 px-3 text-xs"
                        onClick={() => openProviderEditor(provider.id)}
                      >
                        {copy('编辑', 'Edit')}
                      </Button>

                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          {groupedProviders.length === 0 && (
            <div className="rounded-lg border border-dashed border-border/80 px-4 py-10 text-center text-sm text-muted-foreground">
              {search.trim()
                ? copy('没有匹配的模型商', 'No matching providers')
                : copy('还没有添加模型商，点击下方按钮开始配置。', 'No providers have been added yet. Start with one of the actions below.')}
            </div>
          )}
        </div>

        {/* 批量删除确认（内置弹窗） */}
        <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{copy('删除自定义模型商', 'Delete custom providers')}</DialogTitle>
              <DialogDescription>
                {(() => {
                  const names = deleteSelection.map((id) => providers.find((p) => p.id === id)?.display_name || id).join('、')
                  const hasBuiltin = deleteSelection.some((id) => !providers.find((p) => p.id === id)?.is_custom)
                  const prefix = copy(`即将删除 ${deleteSelection.length} 个模型商：${names}。`, `About to delete ${deleteSelection.length} provider(s): ${names}. `)
                  return hasBuiltin
                    ? prefix + copy(
                        '内置模型商将被重置并从列表隐藏（之后可从「添加内置模型商」重新启用）。此操作不会删除已有会话记录，且无法撤销。',
                        'Built-in providers are reset and hidden from the lists (re-enable them from "Add built-in model provider" later). Session history is kept. This cannot be undone.',
                      )
                    : prefix + copy(
                        '此操作只移除本地配置，不会删除已有会话记录，且无法撤销。',
                        'This removes local configuration only, keeps session history, and cannot be undone.',
                      )
                })()}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>
                {copy('取消', 'Cancel')}
              </Button>
              <Button variant="destructive" onClick={() => void runBatchDelete()} disabled={deleting}>
                {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                {copy('删除', 'Delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-dashed border-border/90 px-4 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.03] hover:text-foreground"
            onClick={() => openProviderEditor()}
          >
            <Plus className="h-4 w-4" />
            {copy('添加内置模型商', 'Add built-in model provider')}
          </button>
          <button
            type="button"
            className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-dashed border-border/90 px-4 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.03] hover:text-foreground"
            onClick={() => {
              resetCustomProviderForm()
              setCustomEditorOpen(true)
              setEditorOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            {copy('添加自定义模型商', 'Add custom model provider')}
          </button>
        </div>

        {lastProviderRefresh && (
          <p className="text-right text-[11px] text-muted-foreground/70">
            {copy('上次更新', 'Updated')} {lastProviderRefresh.toLocaleTimeString()}
          </p>
        )}
      </div>
    )
  }

  if (customEditorOpen) {
    return (
      <div className="model-provider-editor-layout block">
        <div className="model-provider-form mx-auto w-full max-w-3xl space-y-5">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => {
                resetCustomProviderForm()
                setCustomEditorOpen(false)
                setEditorOpen(false)
              }}
              aria-label={copy('返回模型列表', 'Back to models')}
              title={copy('返回模型列表', 'Back to models')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium text-muted-foreground">{copy('模型', 'Models')}</span>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" />
              <h2 className="text-xl font-semibold tracking-tight">{copy('添加自定义模型商', 'Add custom model provider')}</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy('添加一个兼容 OpenAI Chat Completions 的第三方服务或内网网关。', 'Add an OpenAI Chat Completions-compatible service or private gateway.')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-id">{copy('唯一 ID', 'Unique ID')}</Label>
            <Input id="custom-provider-id" name="provider-identifier" autoComplete="off" value={customForm.id} onChange={(e) => setCustomForm((v) => ({ ...v, id: e.target.value }))} />
            <p className="text-[11px] text-muted-foreground">{copy('仅用于本地保存和识别，建议使用小写短横线。', 'Stored locally to identify this provider. Lowercase with dashes is recommended.')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-name">{copy('显示名称', 'Display name')}</Label>
            <Input id="custom-provider-name" name="provider-display-name" autoComplete="off" value={customForm.display_name} onChange={(e) => setCustomForm((v) => ({ ...v, display_name: e.target.value }))} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-url">Base URL</Label>
            <Input id="custom-provider-url" name="provider-endpoint" autoComplete="off" value={customForm.base_url} onChange={(e) => setCustomForm((v) => ({ ...v, base_url: e.target.value }))} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-group">{copy('分组', 'Group')}</Label>
            <Input id="custom-provider-group" name="provider-group" autoComplete="off" value={customForm.group} onChange={(e) => setCustomForm((v) => ({ ...v, group: e.target.value }))} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{copy('模型列表', 'Models')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleFetchCustomModels}
                disabled={customDiscovering || !customForm.base_url.trim()}
                title={!customForm.base_url.trim() ? copy('请先填写 Base URL', 'Enter a Base URL first') : undefined}
              >
                {customDiscovering
                  ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  : <ListPlus className="mr-1 h-3.5 w-3.5" />}
                {copy('获取模型列表', 'Fetch models')}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{copy('列表中的第一个模型将作为当前模型。', 'The first model in the list becomes the current model.')}</p>
            <div className="space-y-1.5">
              {customModels.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs text-muted-foreground">{copy('尚未添加模型', 'No models added yet')}</div>
              ) : customModels.map((model, index) => (
                <div key={model} className="flex items-center gap-2 rounded-lg px-3 py-2 bg-muted/20">
                  {editingCustomModel === model ? (
                    <>
                      <Input
                        autoFocus
                        autoComplete="off"
                        value={editingCustomValue}
                        onChange={(e) => setEditingCustomValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleRenameCustomModel(model, editingCustomValue) }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingCustomModel(null) }
                        }}
                        className="h-7 flex-1 font-mono text-xs"
                        aria-label={copy('编辑模型 ID', 'Edit model id')}
                      />
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-600 hover:text-emerald-500" onClick={() => handleRenameCustomModel(model, editingCustomValue)} disabled={!editingCustomValue.trim()} title={copy('确认', 'Confirm')} aria-label={copy('确认修改', 'Confirm edit')}><Check className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => setEditingCustomModel(null)} title={copy('取消', 'Cancel')} aria-label={copy('取消修改', 'Cancel edit')}><X className="h-3.5 w-3.5" /></Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{model}</span>
                      {index === 0 && <span className="text-[10px] text-muted-foreground">{copy('当前', 'Current')}</span>}
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={() => { setEditingCustomModel(model); setEditingCustomValue(model) }} title={copy('编辑模型 ID', 'Edit model id')} aria-label={`${copy('编辑模型', 'Edit model')} ${model}`}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveCustomModel(model)} title={copy('移除模型', 'Remove model')} aria-label={`${copy('移除模型', 'Remove model')} ${model}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input autoComplete="off" value={customNewModel} onChange={(e) => setCustomNewModel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel() } }} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={handleAddCustomModel} disabled={!customNewModel.trim()}><Plus className="mr-1 h-3.5 w-3.5" />{copy('添加', 'Add')}</Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-wire">{copy('接口格式', 'API format')}</Label>
            <GlassSelect
              id="custom-provider-wire"
              value={customForm.wire}
              onChange={(value) => setCustomForm((v) => ({ ...v, wire: value }))}
              ariaLabel={copy('接口格式', 'API format')}
              options={[
                { value: 'openai', label: 'OpenAI Chat Completions' },
                { value: 'responses', label: copy('Responses（原生）', 'Responses (native)') },
                { value: 'anthropic', label: 'Anthropic Messages' },
              ]}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-key">{copy('API Key（可选）', 'API key (optional)')}</Label>
            <Input id="custom-provider-key" name="provider-secret" type="password" autoComplete="new-password" value={customForm.api_key} onChange={(e) => setCustomForm((v) => ({ ...v, api_key: e.target.value }))} placeholder={copy('保存到系统凭据存储', 'Saved to secure system storage')} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-provider-env">{copy('环境变量名（可选）', 'Environment variable (optional)')}</Label>
            <Input id="custom-provider-env" name="provider-secret-env" autoComplete="off" value={customForm.api_key_env} onChange={(e) => setCustomForm((v) => ({ ...v, api_key_env: e.target.value }))}  />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => {
              resetCustomProviderForm()
              setCustomEditorOpen(false)
              setEditorOpen(false)
            }}>
              {copy('取消', 'Cancel')}
            </Button>
            <Button type="button" onClick={handleCreateCustomProvider} disabled={customSaving}>
              {customSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {copy('添加模型商', 'Add provider')}
            </Button>
          </div>
        </div>

        <ModelPickerDialog
          open={customPickerOpen}
          onOpenChange={setCustomPickerOpen}
          providerLabel={customForm.display_name.trim() || customForm.id.trim() || copy('自定义模型商', 'Custom provider')}
          models={customDiscovered}
          knownIds={customModels}
          loading={customDiscovering}
          onApply={handleApplyCustomModels}
          copy={copy}
        />
      </div>
    )
  }

  return (
    <div className="model-provider-editor-layout block">
      <div ref={providerFormRef} className="model-provider-form mx-auto w-full max-w-3xl space-y-5">
        {!selected && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {copy('未找到该模型商，正在返回列表…', 'Provider not found — returning to the list…')}
          </div>
        )}
        {selected && (
          <>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setEditorOpen(false)}
              aria-label={copy('返回模型列表', 'Back to models')}
              title={copy('返回模型列表', 'Back to models')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium text-muted-foreground">{copy('模型', 'Models')}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
                <ProviderLogo providerId={selected.id} size={28} />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{selected.display_name}</span>
                    {selected.is_default && <span className="text-[10px] text-muted-foreground">{copy('当前使用', 'In use')}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{providerRouteHint(selected, locale)} · ID: {selected.id}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selected.is_custom && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={handleDeleteCustomProvider} disabled={saving} title={copy('删除自定义模型商', 'Delete custom provider')} aria-label={copy('删除自定义模型商', 'Delete custom provider')}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={handleUseModel} disabled={saving || selected.enabled === false}>{copy('使用此模型', 'Use this model')}</Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="provider-route">{copy('提供方', 'Provider')}</Label>
              <GlassSelect
                id="provider-route"
                value={selectedId}
                onChange={setSelectedId}
                ariaLabel={copy('提供方', 'Provider')}
                options={providers.map((provider) => ({ value: provider.id, label: provider.display_name }))}
              />
              <p className="text-[11px] text-muted-foreground">{providerRouteHint(selected, locale)}</p>
            </div>

            <Separator />

            {/* 快速操作按钮区 — P0 新增 */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={testing}
              >
                {testing ? (
                  <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> {copy('测试中...', 'Testing...')}</>
                ) : (
                  <><Activity className="mr-1.5 h-3.5 w-3.5" /> {copy('测试连接', 'Test connection')}</>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleFetchModels}
                disabled={fetchingModels}
              >
                {fetchingModels ? (
                  <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> {copy('获取中...', 'Fetching...')}</>
                ) : (
                  <><ListPlus className="mr-1.5 h-3.5 w-3.5" /> {copy('获取模型列表', 'Fetch models')}</>
                )}
              </Button>
              {!apiClient.usesEmbeddedRuntime && selected.supports_multi_key !== false && selected.id !== 'ollama' && (
                <Button variant="outline" size="sm" onClick={handleOpenKeys}>
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" /> {copy('多 Key 管理', 'Manage keys')}
                </Button>
              )}
              {selected.has_url && (
                <Button variant="outline" size="sm" onClick={handleOpenHeaders}>
                  <Settings2 className="mr-1.5 h-3.5 w-3.5" /> {copy('自定义 Header', 'Custom headers')}
                </Button>
              )}
            </div>

            {/* 测试连接结果 */}
            {testResult && (
              <div
                className={cn(
                  'rounded-lg border p-3 text-xs',
                  testResult.ok
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
                )}
              >
                <div className="flex items-start gap-2">
                  {testResult.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{testResult.message}</div>
                    {testResult.detail && (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] opacity-80">
                        {testResult.detail}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/10 px-3 py-2.5">
              <div>
                <Label>{copy('启用此模型商', 'Enable this provider')}</Label>
                <p className="text-[11px] text-muted-foreground">{copy('关闭后新对话不再使用它。', 'New chats stop using it while off.')}</p>
              </div>
              <Switch
                checked={selected.enabled !== false}
                disabled={saving}
                onCheckedChange={(value) => void handleToggleProvider(value)}
                aria-label={`${selected.display_name}启用状态`}
              />
            </div>

            <div className="space-y-2.5">
              <div>
                <Label>{copy('模型列表', 'Models')}</Label>
                <p className="text-[11px] text-muted-foreground">{copy('一个模型商可以保存多个模型，当前模型用于新对话。', 'Save multiple models per provider; the current model is used for new chats.')}</p>
              </div>
              <div className="space-y-1.5">
                {providerModels.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">{copy('尚未添加模型', 'No models added yet')}</div>
                ) : providerModels.map((model) => {
                  const current = modelName === model
                  const editing = editingModel === model
                  return (
                    <div key={model} className={cn('flex items-center gap-2 rounded-lg px-3 py-2', current ? 'bg-foreground/[0.055] ring-1 ring-foreground/10' : 'bg-muted/20')}>
                      {editing ? (
                        <>
                          <Input
                            autoFocus
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); handleRenameModel(model, editingValue) }
                              if (e.key === 'Escape') { e.preventDefault(); setEditingModel(null) }
                            }}
                            className="h-7 flex-1 font-mono text-xs"
                            aria-label={copy('编辑模型 ID', 'Edit model id')}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-emerald-600 hover:text-emerald-500"
                            onClick={() => handleRenameModel(model, editingValue)}
                            disabled={!editingValue.trim()}
                            title={copy('确认', 'Confirm')}
                            aria-label={copy('确认修改', 'Confirm edit')}
                          ><Check className="h-3.5 w-3.5" /></Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            onClick={() => setEditingModel(null)}
                            title={copy('取消', 'Cancel')}
                            aria-label={copy('取消修改', 'Cancel edit')}
                          ><X className="h-3.5 w-3.5" /></Button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => setModelName(model)} className="min-w-0 flex-1 truncate text-left font-mono text-xs" title={model}>{model}</button>
                          {current && <span className="text-[10px] text-muted-foreground">{copy('当前', 'Current')}</span>}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => { setEditingModel(model); setEditingValue(model) }}
                            title={copy('编辑模型 ID', 'Edit model id')}
                            aria-label={`${copy('编辑模型', 'Edit model')} ${model}`}
                          ><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveModel(model)} title={copy('移除模型', 'Remove model')} aria-label={`${copy('移除模型', 'Remove model')} ${model}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="flex gap-2">
                <Input autoComplete="off" value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel() } }}  className="font-mono text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={handleAddModel} disabled={!newModel.trim()}><Plus className="mr-1 h-3.5 w-3.5" />{copy('添加', 'Add')}</Button>
              </div>
            </div>

            {selected.has_url && (
              <div className="space-y-2">
                <Label htmlFor="base-url">Base URL</Label>
                <Input
                  id="base-url"
                  name="provider-endpoint"
                  autoComplete="off"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}

                />
                <p className="text-[11px] text-muted-foreground">
                  {copy('留空使用默认地址。Ollama 用户通常填', 'Leave blank to use the default. Ollama users often use')} <code className="font-mono">http://localhost:11434/v1</code>
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="api-format">{copy('API 格式', 'API format')}</Label>
              <GlassSelect
                id="api-format"
                value={apiFormat}
                onChange={(value) => setApiFormat(value as 'openai' | 'responses' | 'anthropic')}
                ariaLabel={copy('API 格式', 'API format')}
                options={[
                  { value: 'openai', label: 'OpenAI Chat Completions' },
                  { value: 'responses', label: copy('Responses（原生）', 'Responses (native)') },
                  { value: 'anthropic', label: 'Anthropic Messages' },
                ]}
              />
              <p className="text-[11px] text-muted-foreground">{copy('按当前模型商支持的接口选择，更改后自动应用。', 'Choose the interface supported by this provider; changes apply automatically.')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="context-window">{copy('上下文窗口', 'Context window')}</Label>
              <Input
                id="context-window"
                autoComplete="off"
                inputMode="numeric"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={copy('例如 128000', 'e.g. 128000')}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                {copy(
                  '可选，单位 token。中转站和自建路由不在内置模型目录里，填了这项后聊天框旁的上下文圆环才能显示占用比例；留空则显示「未知」。',
                  'Optional, in tokens. Aggregator and self-hosted routes are not in the built-in model catalog; filling this in lets the context ring show usage. Leave blank to show "unknown".',
                )}
              </p>
            </div>

            {selected.id !== 'ollama' && (
              <div className="space-y-2">
                <Label htmlFor="api-key">API Key</Label>
                <div className="relative">
                  <Input
                    id="api-key"
                    name="provider-secret"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim()) { e.preventDefault(); void persistNow({ apiKey: apiKey.trim() }) } }}
                    placeholder={
                      selected.has_api_key
                        ? copy(`已配置 (${selected.masked_api_key})，留空不变`, `Configured (${selected.masked_api_key}); leave blank to keep it`)
                        : copy('sk-... 留空使用环境变量', 'sk-... leave blank to use an environment variable')
                    }
                    className="pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={showKey ? copy('隐藏 API Key', 'Hide API key') : copy('显示 API Key', 'Show API key')}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {selected.has_api_key && (
                  <p className="text-[11px] text-emerald-500">
                    {copy('当前已配置 Key', 'Configured key')} ({selected.masked_api_key}). {copy('输入新值将覆盖，留空则不变。', 'Enter a new value to replace it, or leave blank to keep it.')}
                  </p>
                )}
                {!selected.has_api_key && selected.masked_api_key === '<未设置环境变量>' && (
                  <p className="text-[11px] text-amber-500">
                    {copy('配置文件中存在', 'The config contains')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{'${VAR}'}</code> {copy('占位符但对应环境变量未设置。请在系统环境变量中设置该变量，或在下方直接输入 API Key。', 'but its environment variable is missing. Set it in the system environment or enter an API key below.')}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              {/* 手动保存：改动仅在本地，点击「保存」才落盘。空闲态不显示提示 */}
              {saveState !== 'idle' && (
                <span
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs transition-colors',
                    saveState === 'error'
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : saveState === 'saving'
                        ? 'border-border/60 bg-muted/30 text-muted-foreground'
                        : 'border-primary/30 bg-primary/10 text-primary',
                  )}
                  title={saveState === 'error' ? copy('点击重试保存', 'Click to retry') : undefined}
                >
                  {saveState === 'saving' ? (
                    <><Loader2 className="h-3 w-3 animate-spin" /> {copy('保存中…', 'Saving…')}</>
                  ) : saveState === 'error' ? (
                    <button type="button" onClick={() => void persistNow()} className="font-medium">{copy('保存失败，点击重试', 'Save failed — retry')}</button>
                  ) : savedAt ? (
                    <>{copy('已保存', 'Saved')} {savedAt.toLocaleTimeString()}</>
                  ) : null}
                </span>
              )}
              <Button size="sm" onClick={() => void persistNow()} disabled={saving}>
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                {copy('保存', 'Save')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => loadProviders()} disabled={saving}>{copy('刷新列表', 'Refresh')}</Button>
              {lastProviderRefresh && <span className="text-[10px] text-muted-foreground">{copy('已更新', 'Updated')} {lastProviderRefresh.toLocaleTimeString()}</span>}
            </div>

          </>
        )}
      </div>

      {/* === 获取模型列表对话框 === */}
      {/* === 获取模型列表对话框（多选 / 全选）=== */}
      <ModelPickerDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        providerLabel={selected?.display_name ?? ''}
        models={fetchedModels}
        knownIds={providerModels}
        loading={fetchingModels}
        onApply={(ids) => {
          if (ids.length === 0) return
          setProviderModels((current) => mergeModelIds(current, ids))
          // Keep the single-pick affordance the old dialog had: the first
          // newly added model also becomes the field's model name.
          if (!modelName.trim()) setModelName(ids[0])
          toast.info(copy(`已添加 ${ids.length} 个模型（记得点保存）`, `Added ${ids.length} model(s) — remember to save`))
        }}
        copy={copy}
      />

      {/* === 多 Key 管理对话框 === */}
      <Dialog open={keysDialogOpen} onOpenChange={setKeysDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{selected?.display_name} {copy('多 Key 管理', 'Manage API keys')}</DialogTitle>
            <DialogDescription>
              {copy('一个 provider 可配多个 Key。主 Key 在下方编辑表单中维护，这里管理额外 Key。', 'A provider can have multiple keys. Maintain the primary key in the form and manage additional keys here.')}
              <br />
              <span className="text-[11px] text-muted-foreground/70">
                {copy('当前仅使用主 Key，多 Key 轮换功能将在后续版本提供。', 'Only the primary key is used right now. Key rotation will arrive in a future version.')}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* 已有 Key 列表 */}
            <div className="space-y-1.5">
              {keysLoading ? (
                <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> {copy('加载中...', 'Loading...')}
                </div>
              ) : keyList.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  {copy('暂无 API Key', 'No API keys yet')}
                </div>
              ) : (
                keyList.map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12px]">{k.masked_key}</span>
                        {k.is_primary && (
                          <Badge variant="outline" className="border-primary/40 text-[9px] text-primary">
                            {copy('主 Key', 'Primary key')}
                          </Badge>
                        )}
                        {!k.enabled && (
                          <Badge variant="secondary" className="text-[9px]">{copy('已禁用', 'Disabled')}</Badge>
                        )}
                      </div>
                      {k.label && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{k.label}</div>
                      )}
                    </div>
                    {!k.is_primary && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteKey(k.id)}
                        className="h-7 text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>
            {/* 添加新 Key */}
            <Separator />
            <div className="space-y-2">
              <Label className="text-xs">{copy('添加新 Key', 'Add another key')}</Label>
              <Input
                name="provider-secret"
                autoComplete="new-password"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="sk-..."
                className="font-mono text-xs"
              />
              <Input
                autoComplete="off"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                placeholder={copy('标签 (可选, 例如: 主号 / 备用)', 'Label (optional, e.g. primary / backup)')}
                className="text-xs"
              />
              <Button
                size="sm"
                onClick={handleAddKey}
                disabled={!newKey.trim()}
                className="w-full"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" /> {copy('添加', 'Add')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* === 自定义 Header 对话框 === */}
      <Dialog open={headersDialogOpen} onOpenChange={setHeadersDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
          <DialogTitle>{selected?.display_name} {copy('自定义 HTTP Headers', 'Custom HTTP headers')}</DialogTitle>
            <DialogDescription>
              {copy('兼容第三方中转 (DMXAPI / OpenRouter / AiHubMix 等)。留空保存会清除所有 Header。', 'For third-party gateways such as DMXAPI, OpenRouter, or AiHubMix. Saving empty values clears all headers.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {headerEntries.map((entry, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  autoComplete="off"
                  value={entry.k}
                  onChange={(e) => {
                    const next = [...headerEntries]
                    next[i] = { ...next[i], k: e.target.value }
                    setHeaderEntries(next)
                  }}
                  placeholder={copy('Header 名 (如 X-API-Source)', 'Header name (e.g. X-API-Source)')}
                  className="flex-1 font-mono text-xs"
                />
                <Input
                  autoComplete="off"
                  value={entry.v}
                  onChange={(e) => {
                    const next = [...headerEntries]
                    next[i] = { ...next[i], v: e.target.value }
                    setHeaderEntries(next)
                  }}
                  placeholder={copy('Header 值', 'Header value')}
                  className="flex-1 font-mono text-xs"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHeaderEntries(headerEntries.filter((_, idx) => idx !== i))}
                  className="h-9 px-2 text-red-500 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHeaderEntries([...headerEntries, { k: '', v: '' }])}
              className="w-full"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> {copy('添加 Header', 'Add header')}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHeadersDialogOpen(false)}>{copy('取消', 'Cancel')}</Button>
            <Button onClick={handleSaveHeaders}>{copy('保存', 'Save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
