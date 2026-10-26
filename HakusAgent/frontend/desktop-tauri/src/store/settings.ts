/**
 * Settings store — persisted via electron-store (main process) when running in Electron,
 * with localStorage fallback for browser dev mode.
 */

import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings, type ProviderInfo } from '@/api/types'
import { applyTheme } from '@/lib/utils'
import { apiClient } from '@/api/client'
import { normalizeLanguage, useLocaleStore, type AppLanguage } from '@/lib/i18n'
import { isProviderConfigured } from '@/lib/providerState'

interface SettingsStore extends AppSettings {
  loaded: boolean
  // Provider 列表（与 server /api/config/providers 同步），供 TopBar 快速切换与 SettingsDialog 编辑共用
  providers: ProviderInfo[]
  defaultModel: string
  providersLoading: boolean
  // 保留 Error 对象本身（而不是 string），方便 UI 用 instanceof 判断 BackendOutdatedError
  providersError: Error | null
  // 上一次 loadProviders 开始的时间戳（ms），用于检测卡死的 loading 状态
  providersLoadingSince: number | null
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
  setServerUrl: (url: string) => Promise<void>
  setTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>
  loadProviders: () => Promise<void>
  /** 强制重置 provider 加载状态（用于从卡死的 loading 中恢复） */
  resetProvidersLoading: () => void
  setDefaultModel: (provider: string, model?: string) => Promise<void>
  // Phase 3 — tray + shortcuts (Electron-only; no-op in browser dev mode)
  setTrayEnabled: (enabled: boolean) => Promise<void>
  setMinimizeToTray: (enabled: boolean) => Promise<void>
  setToggleShortcut: (accelerator: string) => Promise<{ ok: boolean; error: string | null }>
}

// Persistence layer
async function loadSettings(): Promise<Partial<AppSettings>> {
  const isAndroidRuntime = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  // Try Electron store first
  if (typeof window !== 'undefined' && (window as any).electron?.store) {
    const all = await (window as any).electron.store.getAll()
    return {
      connection: {
        ...DEFAULT_SETTINGS.connection,
        serverUrl: migrateUrl(all?.serverUrl || DEFAULT_SETTINGS.connection.serverUrl),
        useWebSocket: all?.useWebSocket ?? DEFAULT_SETTINGS.connection.useWebSocket,
        timeout: all?.timeout ?? DEFAULT_SETTINGS.connection.timeout,
      },
      theme: all?.theme || DEFAULT_SETTINGS.theme,
      // Android follows the device/WebView locale. Desktop persists the
      // explicit choice made in the first-run flow or Appearance settings.
      language: isAndroidRuntime ? 'system' : normalizeLanguage(all?.language),
      // Only an EXPLICIT `onboardingCompleted: true` marks onboarding done.
      // The previous `?? hasSavedSettings` fallback treated ANY leftover key
      // from an old install (uninstall residue in the store file) as "setup
      // already done", so freshly installed clients never showed the
      // initialization wizard.
      onboardingCompleted: all?.onboardingCompleted === true,
      defaultSessionName: all?.defaultSessionName || DEFAULT_SETTINGS.defaultSessionName,
      sendOnEnter: all?.sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter,
      showReasoning: all?.showReasoning ?? DEFAULT_SETTINGS.showReasoning,
      autoScroll: all?.autoScroll ?? DEFAULT_SETTINGS.autoScroll,
      fontSize: all?.fontSize ?? DEFAULT_SETTINGS.fontSize,
      ttsEnabled: all?.ttsEnabled ?? DEFAULT_SETTINGS.ttsEnabled,
      ttsProvider: all?.ttsProvider || DEFAULT_SETTINGS.ttsProvider,
      ttsVoice: all?.ttsVoice || DEFAULT_SETTINGS.ttsVoice,
      ttsSpeed: all?.ttsSpeed ?? DEFAULT_SETTINGS.ttsSpeed,
      voiceMode: all?.voiceMode || DEFAULT_SETTINGS.voiceMode,
      dashscopeApiKey: all?.dashscopeApiKey || DEFAULT_SETTINGS.dashscopeApiKey,
      voiceCallEnabled: all?.voiceCallEnabled ?? DEFAULT_SETTINGS.voiceCallEnabled,
      voiceCallBackend: all?.voiceCallBackend || DEFAULT_SETTINGS.voiceCallBackend,
      celiaPath: all?.celiaPath || DEFAULT_SETTINGS.celiaPath,
      celiaConfigPath: all?.celiaConfigPath || DEFAULT_SETTINGS.celiaConfigPath,
      celiaPythonCommand: all?.celiaPythonCommand || DEFAULT_SETTINGS.celiaPythonCommand,
      celiaOpenInTerminal: all?.celiaOpenInTerminal ?? DEFAULT_SETTINGS.celiaOpenInTerminal,
      asrProvider: all?.asrProvider || DEFAULT_SETTINGS.asrProvider,
      asrLanguage: all?.asrLanguage || DEFAULT_SETTINGS.asrLanguage,
      vadThreshold: all?.vadThreshold ?? DEFAULT_SETTINGS.vadThreshold,
      vadSilenceEndFrames: all?.vadSilenceEndFrames ?? DEFAULT_SETTINGS.vadSilenceEndFrames,
      voiceBroadcastEnabled: all?.voiceBroadcastEnabled ?? DEFAULT_SETTINGS.voiceBroadcastEnabled,
      voiceBroadcastMode: all?.voiceBroadcastMode || DEFAULT_SETTINGS.voiceBroadcastMode,
      voiceBroadcastChime: all?.voiceBroadcastChime || DEFAULT_SETTINGS.voiceBroadcastChime,
      trayEnabled: all?.trayEnabled ?? DEFAULT_SETTINGS.trayEnabled,
      minimizeToTray: all?.minimizeToTray ?? DEFAULT_SETTINGS.minimizeToTray,
      toggleShortcut: all?.toggleShortcut || all?.shortcutAccelerator || DEFAULT_SETTINGS.toggleShortcut,
    }
  }
  // Browser dev fallback — localStorage
  const raw = localStorage.getItem('hakusai-settings')
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      // Migrate old localhost URLs to 127.0.0.1 (IPv6 resolution causes ERR_EMPTY_RESPONSE)
      if (parsed?.connection?.serverUrl) {
        parsed.connection.serverUrl = migrateUrl(parsed.connection.serverUrl)
      }
      return {
        ...parsed,
        language: isAndroidRuntime ? 'system' : normalizeLanguage(parsed?.language),
        // Strict flag — residue without an explicit true shows the wizard.
        onboardingCompleted: parsed?.onboardingCompleted === true,
      }
    } catch {
      /* ignore */
    }
  }
  return {}
}

/** Replace localhost with 127.0.0.1 to avoid IPv6 resolution issues. */
function migrateUrl(url: string): string {
  if (!url) return url
  return url.replace('://localhost:', '://127.0.0.1:').replace('://localhost/', '://127.0.0.1/')
}

async function saveSettings(settings: AppSettings): Promise<void> {
  if (typeof window !== 'undefined' && (window as any).electron?.store) {
    const api = (window as any).electron.store
    await api.set('serverUrl', settings.connection.serverUrl)
    await api.set('useWebSocket', settings.connection.useWebSocket)
    await api.set('timeout', settings.connection.timeout)
    await api.set('theme', settings.theme)
    await api.set('language', settings.language)
    await api.set('onboardingCompleted', settings.onboardingCompleted)
    await api.set('defaultSessionName', settings.defaultSessionName)
    await api.set('sendOnEnter', settings.sendOnEnter)
    await api.set('showReasoning', settings.showReasoning)
    await api.set('autoScroll', settings.autoScroll)
    await api.set('fontSize', settings.fontSize)
    await api.set('ttsEnabled', settings.ttsEnabled)
    await api.set('ttsProvider', settings.ttsProvider)
    await api.set('ttsVoice', settings.ttsVoice)
    await api.set('ttsSpeed', settings.ttsSpeed)
    await api.set('voiceMode', settings.voiceMode)
    await api.set('dashscopeApiKey', settings.dashscopeApiKey)
    await api.set('voiceCallEnabled', settings.voiceCallEnabled)
    await api.set('voiceCallBackend', settings.voiceCallBackend)
    await api.set('celiaPath', settings.celiaPath)
    await api.set('celiaConfigPath', settings.celiaConfigPath)
    await api.set('celiaPythonCommand', settings.celiaPythonCommand)
    await api.set('celiaOpenInTerminal', settings.celiaOpenInTerminal)
    await api.set('asrProvider', settings.asrProvider)
    await api.set('asrLanguage', settings.asrLanguage)
    await api.set('vadThreshold', settings.vadThreshold)
    await api.set('vadSilenceEndFrames', settings.vadSilenceEndFrames)
    await api.set('voiceBroadcastEnabled', settings.voiceBroadcastEnabled)
    await api.set('voiceBroadcastMode', settings.voiceBroadcastMode)
    await api.set('voiceBroadcastChime', settings.voiceBroadcastChime)
    await api.set('trayEnabled', settings.trayEnabled)
    await api.set('minimizeToTray', settings.minimizeToTray)
    await api.set('toggleShortcut', settings.toggleShortcut)
    return
  }
  localStorage.setItem('hakusai-settings', JSON.stringify(settings))
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  providers: [],
  defaultModel: '',
  providersLoading: false,
  providersError: null,
  providersLoadingSince: null,

  load: async () => {
    let loaded: Partial<AppSettings> = {}
    try {
      loaded = await loadSettings()
    } catch (e) {
      // If the persistence layer (electron.store / localStorage) is
      // unavailable or throws, we MUST still apply a theme — otherwise
      // the hardcoded `class="dark"` from index.html survives forever
      // and light-mode users see white-on-white text in the settings dialog.
      console.error('[settings] loadSettings() failed, falling back to defaults:', e)
    }
    const isAndroidRuntime = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
    const merged = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      ...(isAndroidRuntime ? { language: 'system' as const } : {}),
    } as AppSettings
    set({ ...merged, loaded: true })
    useLocaleStore.getState().initialize(merged.language)
    // Always run applyTheme, even on error, so <html> reflects the resolved
    // theme (default 'system' if loading failed) instead of staying stuck on
    // whatever class index.html's inline script set.
    applyTheme(merged.theme)
  },

  update: async (patch) => {
    const isAndroidRuntime = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
    const safePatch = isAndroidRuntime && patch.language
      ? { ...patch, language: 'system' as const }
      : patch
    const next = { ...get(), ...safePatch } as AppSettings
    set(next)
    await saveSettings(next)
    if (safePatch.theme) applyTheme(safePatch.theme)
    if (safePatch.language) useLocaleStore.getState().setLanguage(safePatch.language as AppLanguage)
  },

  setServerUrl: async (url) => {
    const next = {
      ...get(),
      connection: { ...get().connection, serverUrl: url },
    } as AppSettings
    set(next)
    await saveSettings(next)
  },

  setTheme: async (theme) => {
    const next = { ...get(), theme } as AppSettings
    set(next)
    await saveSettings(next)
    applyTheme(theme)
  },

  resetProvidersLoading: () => {
    set({ providersLoading: false, providersError: null, providersLoadingSince: null })
  },

  loadProviders: async () => {
    // A Rust browser preview owns its loopback endpoint. Keep provider reads
    // on that Runtime even if an older browser session persisted another URL.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('backend')?.toLowerCase() === 'rust') {
      apiClient.setBaseUrl('http://127.0.0.1:48081')
    }
    // 防止重复调用：如果已经在 loading 且不超过 15s，跳过
    const state = get()
    if (state.providersLoading && state.providersLoadingSince) {
      const elapsed = Date.now() - state.providersLoadingSince
      if (elapsed < 15000) {
        return // 另一个调用正在进行
      }
      // 超过 15s 视为卡死，继续重新加载
      console.warn(`[settings] providers loading stuck for ${elapsed}ms, force-reloading`)
    }
    set({ providersLoading: true, providersError: null, providersLoadingSince: Date.now() })
    try {
      const resp = await apiClient.getProviders()
      const nextProviders = resp.providers || []
      // Rust exposes the whole built-in catalog. Do not persist its current
      // pointer as a usable provider when that route is disabled/unconfigured.
      const selectedDefault = nextProviders.some((provider) =>
        provider.id === resp.default_model && isProviderConfigured(provider),
      ) ? resp.default_model : ''
      set({
        providers: nextProviders,
        defaultModel: selectedDefault,
        providersLoading: false,
        providersLoadingSince: null,
      })
    } catch (e: any) {
      // 后端不可用或 /api/config/providers 端点缺失是预期情况（如 backend 过旧），
      // 错误状态已存入 store 供 UI 提示，无需输出控制台错误。
      set({
        providersLoading: false,
        // 保留 Error 对象本身，UI 用 instanceof BackendOutdatedError 判断
        providersError: e instanceof Error ? e : new Error(String(e?.message || e)),
        providersLoadingSince: null,
      })
    }
  },

  setDefaultModel: async (provider, model) => {
    // optimistic update
    const prev = get().providers
    set({
      defaultModel: provider,
      providers: prev.map((p) => ({ ...p, is_default: p.id === provider })),
    })
    try {
      await apiClient.setDefaultModel(provider, model)
      // reload providers to confirm
      await get().loadProviders()
    } catch (e: any) {
      // rollback
      set({ providers: prev, defaultModel: get().defaultModel })
      throw e
    }
  },

  // ─── Phase 3: tray + shortcuts ───────────────────────────────────────────
  // These call the dedicated IPC handlers in main.ts which both persist
  // the new value AND apply it at runtime (no app restart required).
  // In browser dev mode (no window.electron), they fall back to plain
  // store updates so the UI still reflects the user's intent.

  setTrayEnabled: async (enabled) => {
    set({ trayEnabled: enabled })
    const electron = (window as any).electron
    if (electron?.tray) {
      try {
        const cfg = await electron.tray.setEnabled(enabled)
        // Reconcile state with the authoritative response from main.
        // (main may flip minimizeToTray if tray was disabled.)
        set({ trayEnabled: cfg.enabled, minimizeToTray: cfg.minimizeToTray })
      } catch (e) {
        console.error('[settings] tray.setEnabled failed:', e)
      }
    } else {
      await saveSettings(get() as any)
    }
  },

  setMinimizeToTray: async (enabled) => {
    set({ minimizeToTray: enabled })
    const electron = (window as any).electron
    if (electron?.tray) {
      try {
        const cfg = await electron.tray.setMinimizeToTray(enabled)
        // If main auto-enabled tray, reflect that in our state.
        set({ trayEnabled: cfg.enabled, minimizeToTray: cfg.minimizeToTray })
      } catch (e) {
        console.error('[settings] tray.setMinimizeToTray failed:', e)
      }
    } else {
      await saveSettings(get() as any)
    }
  },

  setToggleShortcut: async (accelerator) => {
    const electron = (window as any).electron
    if (electron?.shortcuts) {
      const result = await electron.shortcuts.setAccelerator(accelerator)
      // Only update local state if registration succeeded — otherwise
      // keep the previous value so the UI doesn't show a broken shortcut.
      if (result.ok) {
        set({ toggleShortcut: accelerator || '' })
      }
      return { ok: result.ok, error: result.error }
    }
    // Browser dev fallback — just persist without real registration.
    set({ toggleShortcut: accelerator || '' })
    await saveSettings(get() as any)
    return { ok: true, error: null }
  },
}))
