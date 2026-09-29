import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Command, Download, FolderOpen, Globe2, KeyRound, Monitor, Moon, Palette, Plus, RefreshCw, Server, Sun, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/store/settings'
import { useProjectsStore } from '@/store/projects'
import { apiClient } from '@/api/client'
import { confirmProjectAccess, pickProjectFolder } from '@/api/tauriBridge'
import { LANGUAGE_OPTIONS, languageOptionLabel, localeForRuntime, resolveLocale, useI18n, type AppLanguage } from '@/lib/i18n'
import type { ProviderInfo, ProviderModel } from '@/api/types'

type SetupStep = 'language' | 'provider' | 'key' | 'model' | 'workspace' | 'appearance' | 'ready'
const SETUP_STEPS: SetupStep[] = ['language', 'provider', 'key', 'model', 'workspace', 'appearance', 'ready']
type ThemeChoice = 'light' | 'dark' | 'system'
const DEFAULT_MODEL_HINTS: Record<string, string> = { deepseek: 'deepseek-chat', openai: 'gpt-4o', anthropic: 'claude-sonnet-4-20250514', qwen: 'qwen-plus', gemini: 'gemini-2.5-flash', ollama: 'qwen2.5:7b' }

interface FirstRunSetupProps { onComplete: () => void }

export function FirstRunSetup({ onComplete }: FirstRunSetupProps) {
  const settings = useSettingsStore()
  const providers = useSettingsStore((state) => state.providers)
  const providersLoading = useSettingsStore((state) => state.providersLoading)
  const loadProviders = useSettingsStore((state) => state.loadProviders)
  const createProject = useProjectsStore((state) => state.create)
  const { locale, t } = useI18n()
  const [step, setStep] = useState<SetupStep>('language')
  const [language, setLanguage] = useState<AppLanguage>(settings.language)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [providerSearch, setProviderSearch] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeChoice>(settings.theme ?? 'system')
  const [customOpen, setCustomOpen] = useState(false)
  const [customId, setCustomId] = useState('')
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customModels, setCustomModels] = useState<string[]>([])
  const [customModel, setCustomModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearedKeysRef = useRef(false)

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase()
    return providers.filter((provider) => !query || `${provider.id} ${provider.display_name}`.toLowerCase().includes(query))
  }, [providerSearch, providers])
  const stepIndex = SETUP_STEPS.indexOf(step)

  useEffect(() => { void loadProviders() }, [loadProviders])

  useEffect(() => {
    if (!providers.length) return
    if (!selectedProviderId) {
      const current = providers.find((provider) => provider.is_default && provider.enabled !== false) || providers.find((provider) => provider.enabled !== false) || providers[0]
      setSelectedProviderId(current.id)
      setModel(current.configured_models?.[0] || '')
      setBaseUrl(current.base_url || '')
    }
    // A restored config may contain keys from before uninstall/backup. Clear
    // every persisted provider secret before the user reaches the key step,
    // while keeping provider/model metadata available for confirmation.
    if (!clearedKeysRef.current) {
      clearedKeysRef.current = true
      void apiClient.clearRuntimeCredentials().catch(() => undefined)
    }
  }, [providers, selectedProviderId])

  const selectProvider = (provider: ProviderInfo) => {
    setSelectedProviderId(provider.id)
    setModel(provider.configured_models?.[0] || '')
    setBaseUrl(provider.base_url || '')
    setApiKey('')
    setModels([])
    setError(null)
  }

  const addCustomProvider = async () => {
    const id = customId.trim()
    const url = customUrl.trim()
    if (!id || !url) { setError(locale === 'zh-CN' ? '请填写模型商 ID 和 Base URL。' : 'Enter a provider ID and Base URL.'); return }
    setSaving(true); setError(null)
    try {
      await apiClient.createCustomProvider({ id, display_name: customName.trim() || id, base_url: url, model: customModels[0] || undefined, models: customModels, enabled: true })
      await loadProviders()
      setSelectedProviderId(id); setModel(customModels[0] || ''); setBaseUrl(url); setCustomOpen(false)
      setCustomId(''); setCustomName(''); setCustomUrl(''); setCustomModel(''); setCustomModels([])
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
  }

  const fetchModels = async () => {
    if (!selectedProvider) return
    setModelsLoading(true); setError(null)
    try {
      const result = await apiClient.fetchProviderModels(selectedProvider.id, { api_key: apiKey.trim() || undefined, base_url: baseUrl.trim() || undefined })
      setModels(result.models)
      if (!model && result.models[0]) setModel(result.models[0].id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setModelsLoading(false) }
  }

  const chooseWorkspace = async () => {
    setError(null)
    const selection = await pickProjectFolder()
    if (!selection?.path || !(await confirmProjectAccess())) return
    try {
      const name = selection.name || selection.path.split(/[\\/]/).filter(Boolean).pop() || 'Workspace'
      const project = await createProject({ name, path: selection.path, source_uri: selection.sourceUri })
      useProjectsStore.getState().setActive(project.id)
      setWorkspace(selection.path)
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('projectCreateFailed')) }
  }

  const persistProvider = async () => {
    if (!selectedProvider) return
    const selectedModel = model.trim() || selectedProvider.configured_models?.[0] || ''
    if (selectedModel || apiKey.trim()) {
      await apiClient.updateProvider({ provider: selectedProvider.id, model_name: selectedModel || undefined, base_url: selectedProvider.has_url ? baseUrl.trim() : undefined, api_key: apiKey.trim() || undefined, models: Array.from(new Set([...(selectedProvider.configured_models || []), ...(selectedModel ? [selectedModel] : [])])), enabled: true })
    }
    if (selectedModel) await apiClient.setDefaultModel(selectedProvider.id, selectedModel)
    await loadProviders()
  }

  const next = async () => {
    setError(null)
    if (step === 'provider' && !selectedProvider) { setError(locale === 'zh-CN' ? '请选择或添加一个模型商。' : 'Choose or add a provider.'); return }
    if (step === 'key' || step === 'model') {
      setSaving(true)
      try { await persistProvider() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false); return }
      setSaving(false)
    }
    if (step === 'language') {
      try { await settings.update({ language }); await apiClient.setRuntimeConfig('locale', localeForRuntime(resolveLocale(language))) } catch { /* best effort */ }
    }
    if (step === 'appearance') {
      try { await settings.setTheme(theme) } catch { /* best effort */ }
    }
    setStep(SETUP_STEPS[Math.min(stepIndex + 1, SETUP_STEPS.length - 1)])
  }

  /** Skip everything except language — jump straight to ready. */
  const skipRest = async () => {
    setError(null)
    if (step === 'language') {
      try {
        await settings.update({ language })
        await apiClient.setRuntimeConfig('locale', localeForRuntime(resolveLocale(language)))
      } catch { /* best effort */ }
    }
    setStep('ready')
  }

  const canSkip = step !== 'language' && step !== 'ready'
  const skipLabel = locale === 'zh-CN' ? '跳过' : 'Skip'

  const finish = async () => { setSaving(true); try { await settings.setTheme(theme); await settings.update({ onboardingCompleted: true }); onComplete() } finally { setSaving(false) } }

  return (
    <div className="first-run-overlay" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div className="first-run-surface first-run-surface-expanded">
        <div className="first-run-mark" aria-hidden="true"><Command className="h-5 w-5" /></div>
        <div className="first-run-progress" aria-label={t('stepOf').replace('{step}', String(stepIndex + 1)).replace('{total}', String(SETUP_STEPS.length))}>{SETUP_STEPS.map((item, index) => <span key={item} className={cn('first-run-progress-dot', index <= stepIndex && 'is-active')} />)}</div>
        <h1 id="first-run-title">{t('firstRunTitle')}</h1>
        <p className="first-run-subtitle">{locale === 'zh-CN' ? '逐项确认你的环境。已有配置会预填，API Key 不会恢复。' : 'Confirm each part of your setup. Existing values are prefilled, but API keys are never restored.'}</p>

        {step === 'language' && <section className="first-run-step" aria-labelledby="first-run-language-title"><div className="first-run-step-icon"><Globe2 className="h-5 w-5" /></div><h2 id="first-run-language-title">{t('firstRunLanguageTitle')}</h2><p>{t('firstRunLanguageDescription')}</p><div className="first-run-language-options">{LANGUAGE_OPTIONS.map((option) => <button key={option.value} type="button" className={cn('first-run-language-option', language === option.value && 'is-selected')} onClick={() => setLanguage(option.value)}><span>{languageOptionLabel(option, locale)}</span>{language === option.value && <Check className="h-4 w-4" aria-hidden="true" />}</button>)}</div></section>}

        {step === 'provider' && <section className="first-run-step first-run-provider-step" aria-labelledby="first-run-provider-title"><div className="first-run-step-icon"><Server className="h-5 w-5" /></div><h2 id="first-run-provider-title">{locale === 'zh-CN' ? '选择模型商' : 'Choose a provider'}</h2><p>{locale === 'zh-CN' ? '只选择你准备使用的模型商，之后可以在设置中继续添加。' : 'Choose the provider you plan to use. You can add more later in Settings.'}</p><Input autoComplete="off" value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder={locale === 'zh-CN' ? '搜索模型商' : 'Search providers'} /><div className="first-run-provider-list">{providersLoading && !providers.length ? <div className="first-run-selection"><RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />{locale === 'zh-CN' ? '正在加载...' : 'Loading...'}</div> : filteredProviders.map((provider) => <button type="button" key={provider.id} className={cn('first-run-provider-option', selectedProviderId === provider.id && 'is-selected')} onClick={() => selectProvider(provider)}><span><strong>{provider.display_name}</strong><small>{provider.configured_models?.[0] || (locale === 'zh-CN' ? '尚未配置模型' : 'No model configured')}</small></span>{selectedProviderId === provider.id && <Check className="h-4 w-4" />}</button>)}</div><Button type="button" variant="outline" className="w-full" onClick={() => setCustomOpen((open) => !open)}><Plus className="mr-2 h-4 w-4" />{locale === 'zh-CN' ? '添加自定义模型商' : 'Add custom provider'}</Button>{customOpen && <div className="first-run-custom-form"><div className="grid grid-cols-2 gap-2"><Input autoComplete="off" value={customId} onChange={(event) => setCustomId(event.target.value)}  /><Input autoComplete="off" value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder={locale === 'zh-CN' ? '显示名称' : 'Display name'} /></div><Input autoComplete="off" value={customUrl} onChange={(event) => setCustomUrl(event.target.value)}  /><div className="space-y-1.5">{customModels.map((item, index) => <div key={item} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5"><span className="min-w-0 flex-1 truncate font-mono text-xs">{item}</span>{index === 0 && <small className="text-[10px] text-muted-foreground">{locale === 'zh-CN' ? '当前' : 'Current'}</small>}<button type="button" onClick={() => setCustomModels((prev) => prev.filter((m) => m !== item))} aria-label={locale === 'zh-CN' ? '移除模型' : 'Remove model'} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button></div>)}<div className="flex gap-2"><Input autoComplete="off" value={customModel} onChange={(event) => setCustomModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); const id = customModel.trim(); if (id && !customModels.some((m) => m.toLowerCase() === id.toLowerCase())) { setCustomModels((prev) => [...prev, id]); setCustomModel('') } } }} /></div><Button type="button" variant="outline" size="sm" className="w-full" disabled={!customModel.trim()} onClick={() => { const id = customModel.trim(); if (id && !customModels.some((m) => m.toLowerCase() === id.toLowerCase())) { setCustomModels((prev) => [...prev, id]); setCustomModel('') } }}><Plus className="mr-1 h-3.5 w-3.5" />{locale === 'zh-CN' ? '添加模型' : 'Add model'}</Button></div><Button type="button" onClick={() => void addCustomProvider()} disabled={saving}>{locale === 'zh-CN' ? '保存模型商' : 'Save provider'}</Button></div>}</section>}

        {step === 'key' && <section className="first-run-step" aria-labelledby="first-run-key-title"><div className="first-run-step-icon"><KeyRound className="h-5 w-5" /></div><h2 id="first-run-key-title">{locale === 'zh-CN' ? '填写 API Key' : 'Enter API key'}</h2><p>{selectedProvider?.display_name || ''} · {locale === 'zh-CN' ? '旧 Key 已清除，请重新输入。可以稍后在设置中添加。' : 'Any previous key was cleared. Enter it again, or add it later in Settings.'}</p><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}  autoComplete="new-password" />{selectedProvider?.auth_mode === 'none' && <p className="first-run-selection">{locale === 'zh-CN' ? '此模型商不需要 API Key。' : 'This provider does not require an API key.'}</p>}</section>}

        {step === 'model' && <section className="first-run-step" aria-labelledby="first-run-model-title"><div className="first-run-step-icon"><Download className="h-5 w-5" /></div><h2 id="first-run-model-title">{locale === 'zh-CN' ? '选择默认模型' : 'Choose a default model'}</h2><p>{locale === 'zh-CN' ? '一个模型商可以保存多个模型。没有模型也可以完成初始化，但发送会保持禁用。' : 'A provider can keep multiple models. You can finish without one, but sending stays disabled until a model is configured.'}</p><div className="flex gap-2"><Input autoComplete="off" value={model} onChange={(event) => setModel(event.target.value)}  /><Button type="button" variant="outline" size="icon" onClick={() => void fetchModels()} disabled={modelsLoading || !selectedProvider} title={locale === 'zh-CN' ? '获取模型列表' : 'Fetch models'} aria-label={locale === 'zh-CN' ? '获取模型列表' : 'Fetch models'}>{modelsLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</Button></div>{selectedProvider?.has_url && <Input autoComplete="off" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="Base URL" />}{models.length > 0 && <div className="first-run-model-list">{models.slice(0, 30).map((item) => <button type="button" key={item.id} className={cn('first-run-model-option', model === item.id && 'is-selected')} onClick={() => setModel(item.id)}><span>{item.name || item.id}</span>{model === item.id && <Check className="h-4 w-4" />}</button>)}</div>}</section>}

        {step === 'workspace' && <section className="first-run-step" aria-labelledby="first-run-workspace-title"><div className="first-run-step-icon"><FolderOpen className="h-5 w-5" /></div><h2 id="first-run-workspace-title">{t('firstRunWorkspaceTitle')}</h2><p>{t('firstRunWorkspaceDescription')}</p><Button type="button" variant="outline" className="first-run-folder-button" onClick={() => void chooseWorkspace()}><FolderOpen className="h-4 w-4" />{workspace ? t('changeFolder') : t('chooseFolder')}</Button><p className="first-run-selection">{workspace || t('workspaceNotSelected')}</p></section>}

        {step === 'appearance' && (
          <section className="first-run-step" aria-labelledby="first-run-appearance-title">
            <div className="first-run-step-icon"><Palette className="h-5 w-5" /></div>
            <h2 id="first-run-appearance-title">{locale === 'zh-CN' ? '外观' : 'Appearance'}</h2>
            <p>{locale === 'zh-CN' ? '选择界面主题，之后可在设置中修改。' : 'Pick a theme. You can change it later in Settings.'}</p>
            <div className="first-run-language-options">
              {([
                { value: 'light' as const, label: locale === 'zh-CN' ? '浅色' : 'Light', icon: Sun },
                { value: 'dark' as const, label: locale === 'zh-CN' ? '深色' : 'Dark', icon: Moon },
                { value: 'system' as const, label: locale === 'zh-CN' ? '跟随系统' : 'System', icon: Monitor },
              ]).map((option) => {
                const Icon = option.icon
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={cn('first-run-language-option', theme === option.value && 'is-selected')}
                    onClick={() => {
                      setTheme(option.value)
                      void settings.setTheme(option.value).catch(() => undefined)
                    }}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    <span>{option.label}</span>
                    {theme === option.value && <Check className="h-4 w-4" aria-hidden />}
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {step === 'ready' && <section className="first-run-step first-run-ready" aria-labelledby="first-run-ready-title"><div className="first-run-step-icon"><Check className="h-5 w-5" /></div><h2 id="first-run-ready-title">{t('readyTitle')}</h2><p>{t('readyDescription')}</p><p className="first-run-selection">{selectedProvider ? `${selectedProvider.display_name}${model ? ` / ${model}` : ''}` : (locale === 'zh-CN' ? '尚未配置模型' : 'No model configured')}</p></section>}

        {error && <p className="first-run-error" role="alert">{error}</p>}
        <div className="first-run-actions">
          <Button type="button" variant="ghost" onClick={() => setStep(SETUP_STEPS[Math.max(0, stepIndex - 1)])} disabled={stepIndex === 0 || saving}>
            <ChevronLeft className="mr-1 h-4 w-4" />
            {locale === 'zh-CN' ? '上一步' : 'Back'}
          </Button>
          <div className="flex items-center gap-2">
            {canSkip && (
              <Button type="button" variant="ghost" onClick={() => void skipRest()} disabled={saving}>
                {skipLabel}
              </Button>
            )}
            {step === 'ready' ? (
              <Button type="button" onClick={() => void finish()} disabled={saving}>
                {saving ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t('finish')}
              </Button>
            ) : (
              <Button type="button" onClick={() => void next()} disabled={saving}>
                {locale === 'zh-CN' ? '确认并继续' : 'Confirm and continue'}
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
