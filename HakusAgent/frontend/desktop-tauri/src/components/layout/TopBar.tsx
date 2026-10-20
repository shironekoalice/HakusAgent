import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import {
  Briefcase,
  Code2,
  Workflow,
  Minus,
  PanelLeft,
  PanelRight,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { ProviderLogo } from '@/components/ui/provider-logo'
import { useSessionStore } from '@/store/session'
import { useConnectionStore } from '@/store/connection'
import { useSettingsStore } from '@/store/settings'
import { useAppStore } from '@/store/app'
import { useFlowStore } from '@/store/flow'
import type { AgentMode } from '@/api/types'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { isProviderConfigured } from '@/lib/providerState'

interface TopBarProps {
  onToggleSidebar: () => void
  onToggleRightPanel: () => void
  showSidebarToggle?: boolean
  /** Flow mode owns the whole window: no chat sidebar / review panel. */
  flowMode?: boolean
  /**
   * Android layout: no bar at all — the title and actions render as
   * floating glass islands (iOS-26 style) hovering over the content.
   * There is also no mode selector: Android runs Code mode only.
   */
  floating?: boolean
}

// Mode segments — Work / Code. Binds to agentMode (not the legacy runMode).
// Work = swift (daily chat + tools, no browser), Code = deep (full power).
const MODE_SEGMENTS: { id: AgentMode; label: string; icon: typeof Briefcase }[] = [
  { id: 'swift', label: 'Work', icon: Briefcase },
  { id: 'deep', label: 'Code', icon: Code2 },
  { id: 'flow', label: 'Flow', icon: Workflow },
]

type WindowAction = 'minimize' | 'toggleMaximize' | 'close'

function WindowButtons() {
  const { t } = useI18n()
  const invokedAtRef = useRef(0)

  const invoke = (action: WindowAction, event?: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    event?.stopPropagation()
    const now = Date.now()
    if (now - invokedAtRef.current < 250) return
    invokedAtRef.current = now
    const api = window.electron?.window
    if (!api) {
      console.warn(`[window-controls] Electron window API is unavailable for ${action}`)
      return
    }
    void api[action]().catch((error) => {
      console.error(`[window-controls] ${action} failed`, error)
    })
  }

  return (
    <div className="app-region-no-drag flex items-center gap-0.5 pl-1.5">
      <button
        type="button"
        className="cx-tb-btn cx-win-btn"
        draggable={false}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerUp={(event) => invoke('minimize', event)}
        onClick={(event) => invoke('minimize', event)}
        aria-label={t('minimize')}
        title={t('minimize')}
      >
        <Minus className="h-4 w-4" strokeWidth={2.5} />
      </button>

      <button
        type="button"
        className="cx-tb-btn cx-win-btn"
        draggable={false}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerUp={(event) => invoke('toggleMaximize', event)}
        onClick={(event) => invoke('toggleMaximize', event)}
        aria-label={t('maximize')}
        title={t('maximize')}
      >
        <Square className="h-3.5 w-3.5" strokeWidth={2.2} />
      </button>

      <button
        type="button"
        className="cx-tb-btn cx-win-btn cx-win-close"
        draggable={false}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerUp={(event) => invoke('close', event)}
        onClick={(event) => invoke('close', event)}
        aria-label={t('close')}
        title={t('close')}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.4} />
      </button>
    </div>
  )
}

const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const HAS_NATIVE_WINDOW_CHROME = typeof window !== 'undefined'
  && typeof __TAURI_INTERNALS__ !== 'undefined'
  && !IS_ANDROID

/** Glass-island pill shared by every floating control cluster (Android). */
function FloatingIsland({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'pointer-events-auto flex h-10 items-center gap-1 rounded-full border border-black/10 bg-white/55 px-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-xl backdrop-saturate-150 dark:border-white/15 dark:bg-card/50 dark:shadow-[0_8px_28px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.18)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function TopBar({ onToggleSidebar, onToggleRightPanel, showSidebarToggle = true, flowMode = false, floating = false }: TopBarProps) {
  const { t } = useI18n()
  const activeId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const flowGraphName = useFlowStore((s) => s.graph.name)
  const connState = useConnectionStore((s) => s.state)
  const serverUrl = useSettingsStore((s) => s.connection.serverUrl)
  const refreshServerInfo = useAppStore((s) => s.refreshServerInfo)
  const characterName = useAppStore((s) => s.characterName)
  const providers = useSettingsStore((s) => s.providers)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const configuredProviders = providers.filter(isProviderConfigured)
  const currentProvider = configuredProviders.find((p) => p.is_default) || configuredProviders.find((p) => p.id === defaultModel)
  const currentModelLabel = currentProvider
    ? `${currentProvider.display_name || currentProvider.id} · ${currentProvider.model_name || ''}`
    : t('awaitingModel')
  const agentMode = useAppStore((s) => s.agentMode)
  const setAgentMode = useAppStore((s) => s.setAgentMode)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)

  const activeSession = sessions.find((s) => s.id === activeId)
  const isMac = window.electron?.platform === 'darwin'

  // Mirror the OS maximize state onto <html> as `is-maximized` so the CSS
  // can drop the rounded window corners while maximized (OS convention)
  // and restore them on restore. Resize events fire on maximize/restore,
  // tile snapping and normal window resizing alike.
  useEffect(() => {
    if (IS_ANDROID) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = async () => {
      try {
        const maxed = await window.electron?.window?.isMaximized?.()
        if (!cancelled) document.documentElement.classList.toggle('is-maximized', Boolean(maxed))
      } catch {
        // Bridge unavailable (browser preview) — nothing to mirror.
      }
    }
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void sync(), 120)
    }
    void sync()
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (connState === 'connected') {
      refreshServerInfo()
    }
  }, [connState]) // eslint-disable-line react-hooks/exhaustive-deps

  const sessionTitle = flowMode ? flowGraphName : activeSession?.title || characterName

  // ── Android: floating glass islands, no bar, no mode selector ──
  // Android runs Code mode only, so the Work/Code/Flow segment is gone and
  // every control hovers over the content as an iOS-26-style island.
  if (floating) {
    return (
      <>
        {showSidebarToggle && (
          <FloatingIsland className="app-region-no-drag">
            <button
              type="button"
              className="cx-tb-btn"
              onClick={onToggleSidebar}
              title={t('toggleSidebar')}
              aria-label={t('toggleSidebar')}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          </FloatingIsland>
        )}

        <FloatingIsland className="mx-auto max-w-[60vw] px-4">
          <button
            type="button"
            className="flex min-w-0 flex-col items-center justify-center leading-tight"
            onClick={() => window.dispatchEvent(new CustomEvent('hakus:android-model-picker'))}
            title="点击选择模型"
            aria-label="选择模型"
          >
            <span className="cx-title-main max-w-full truncate text-[13px]">{sessionTitle}</span>
            {!flowMode && (
              <span className="flex max-w-full items-center gap-1 text-[10px] text-muted-foreground">
                {currentProvider && <ProviderLogo providerId={currentProvider.id} size={10} />}
                <span className="truncate">{currentModelLabel}</span>
              </span>
            )}
          </button>
        </FloatingIsland>

        <FloatingIsland className="app-region-no-drag">
          {!flowMode && (
            <button
              type="button"
              className="cx-tb-btn"
              data-panel-open={rightPanelOpen ? 'true' : undefined}
              onClick={onToggleRightPanel}
              title={t('reviewPanel')}
              aria-label={t('reviewPanel')}
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )}
          {!flowMode && activeId && (
            <button
              type="button"
              className="cx-tb-btn"
              onClick={() => {
                if (confirm(t('clearChat') + '?')) {
                  clearMessages(activeId)
                }
              }}
              title={t('clearChat')}
              aria-label={t('clearChat')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </FloatingIsland>
      </>
    )
  }

  return (
    <header
      className="titlebar cx-titlebar flex min-w-0 overflow-hidden"
      data-tauri-drag-region
    >
      {/* The leading strip drags the window too — only its buttons opt out.
          This satisfies "the drag region covers the whole top bar" without
          making the controls themselves grab windows.
          Phone: the strip collapses to just the sidebar toggle — the fixed
          312px width plus the mode segment control is what made narrow
          viewports render the desktop two-column header. */}
      <div className={cn('topbar-leading cx-leading relative z-10 flex w-[312px] shrink-0 items-center gap-1.5 pl-2', isMac && 'pl-[72px]')} data-tauri-drag-region>
        {showSidebarToggle && (
          <button
            type="button"
            className="cx-tb-btn app-region-no-drag"
            onClick={onToggleSidebar}
            title={t('toggleSidebar')}
            aria-label={t('toggleSidebar')}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        <div className="cx-segment app-region-no-drag" role="group" aria-label={t('workMode')}>
          {MODE_SEGMENTS.map((mode) => {
            const Icon = mode.icon
            const active = agentMode === mode.id
            return (
              <button
                key={mode.id}
                className={cn('cx-seg-btn', active && 'cx-seg-btn-active')}
                onClick={() => setAgentMode(mode.id)}
                aria-label={`${mode.id === 'swift' ? t('workMode') : mode.id === 'deep' ? t('codeMode') : t('flowMode')} mode`}
                aria-pressed={active}
                title={`${mode.id === 'swift' ? t('workMode') : mode.id === 'deep' ? t('codeMode') : t('flowMode')} mode${mode.id === 'flow' ? (t('experimentalSuffix') || '') : ''}`}
              >
                <Icon className="h-3 w-3" />
                <span className="hidden md:inline">{mode.id === 'swift' ? t('workMode') : mode.id === 'deep' ? t('codeMode') : t('flowMode')}</span>
                {mode.id === 'flow' && <span className="cx-seg-badge">{t('experimental')}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div
        className="topbar-session app-region-drag relative z-0 flex min-w-0 flex-1 flex-col items-center justify-center px-2"
        data-tauri-drag-region
      >
        <span className="cx-title-main max-w-full truncate" data-tauri-drag-region>
          {flowMode ? flowGraphName : activeSession?.title || characterName}
        </span>
        {!flowMode && (
          <span className="cx-title-sub" data-tauri-drag-region>
            {currentProvider && (
              <ProviderLogo providerId={currentProvider.id} size={11} />
            )}
            <span className="truncate">{currentModelLabel}</span>
          </span>
        )}
      </div>

      <div className="topbar-actions app-region-no-drag relative z-10 flex shrink-0 items-center justify-end gap-1 pr-2">
        {!flowMode && (
          <button
            type="button"
            className="cx-tb-btn"
            data-panel-open={rightPanelOpen ? 'true' : undefined}
            onClick={onToggleRightPanel}
            title={t('reviewPanel')}
            aria-label={t('reviewPanel')}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}

        {/* Flow mode has no chat: the clear-chat action belongs to the
            session views only. */}
        {!flowMode && activeId && (
          <button
            type="button"
            className="cx-tb-btn"
            onClick={() => {
              if (confirm(t('clearChat') + '?')) {
                clearMessages(activeId)
              }
            }}
            title={t('clearChat')}
            aria-label={t('clearChat')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}

        {!isMac && HAS_NATIVE_WINDOW_CHROME && <WindowButtons />}
      </div>
    </header>
  )
}
