import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster, toastApi } from '@/components/ui/toast'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ChatView } from '@/components/chat/ChatView'
import { TopBar } from '@/components/layout/TopBar'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import { WindowResizeEdges } from '@/components/layout/WindowResizeEdges'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { FirstRunSetup } from '@/components/FirstRunSetup'
import { AwakeningSplash } from '@/components/AwakeningSplash'
import { RemoteProjectWizard } from '@/components/settings/panels/RemoteProjectWizard'
import { TextContextMenu } from '@/components/ui/TextContextMenu'

import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { IS_ANDROID } from '@/lib/platform'
import { useAppStore } from '@/store/app'
import { useConnectionStore } from '@/store/connection'
import { REMOTE_RECONNECT_EVENT, REMOTE_RUNTIME_CONNECTED_EVENT, useProjectsStore } from '@/store/projects'
import { assignSessionWorkspace } from '@/lib/sessionWorkspaces'
import type { Project } from '@/api/types'
import { apiClient } from '@/api/client'
import { isPhoneViewport, PHONE_VIEWPORT_QUERY } from '@/lib/responsive'
import { cn } from '@/lib/utils'
import { localeForRuntime, useI18n, useLocaleStore } from '@/lib/i18n'

const FlowWorkbench = lazy(() => import('@/components/flow/FlowWorkbench').then((module) => ({ default: module.FlowWorkbench })))
const RightPanel = lazy(() => import('@/components/review/RightPanel').then((module) => ({ default: module.RightPanel })))

const IS_TAURI = typeof __TAURI_INTERNALS__ !== 'undefined'
// IS_ANDROID comes from @/lib/platform (UA + ?platform=android preview flag).
const IS_RUST_PREVIEW = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('backend')?.toLowerCase() === 'rust'
// Minimum time between the frontend mounting and the native splash being
// dismissed. The Rust side enforces the full design timeline (~2.4s from
// process start); this only avoids a flash of the UI for instant boots.
const MIN_SPLASH_MS = 1500

function DeferredSurface({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center" role="status" aria-busy="true">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  )
}

function App() {
  const mountedAt = useRef(Date.now())
  const splashFinishedRef = useRef(false)
  const [appReady, setAppReady] = useState(!IS_TAURI || IS_ANDROID)
  const [awakeningDone, setAwakeningDone] = useState(!IS_TAURI || IS_ANDROID)
  const [showFirstRun, setShowFirstRun] = useState(false)
  const [remoteReconnectProject, setRemoteReconnectProject] = useState<Project | null>(null)

  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarCompact = useAppStore((s) => s.sidebarCompact)
  const storedAgentMode = useAppStore((s) => s.agentMode)
  // Android ships a single surface: Code mode only, no Work/Code/Flow switch.
  const agentMode = IS_ANDROID ? 'code' : storedAgentMode
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const setSidebar = useAppStore((s) => s.setSidebar)
  const setSidebarCompact = useAppStore((s) => s.setSidebarCompact)
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const refreshServerInfo = useAppStore((s) => s.refreshServerInfo)
  const [rightPanelMounted, setRightPanelMounted] = useState(rightPanelOpen)

  useEffect(() => {
    if (rightPanelOpen) setRightPanelMounted(true)
  }, [rightPanelOpen])

  // Flow mode is a full-window workbench: it ships its own left (workflow
  // list) and right (inspector) rails, so the chat sidebar and the review
  // panel must get out of the way entirely.
  const isFlow = agentMode === 'flow'

  const toggleSidebar = () => {
    const state = useAppStore.getState()
    if (isPhoneViewport()) {
      const next = !state.sidebarOpen
      setSidebar(next)
      if (next) setRightPanelOpen(false)
      return
    }

    // Desktop: the button cycles hidden -> full -> compact rail -> full.
    // The compact rail is the resting state; clicking expands to the full
    // sidebar, clicking again shrinks back to the rail.
    if (!state.sidebarOpen) {
      setSidebar(true)
      return
    }
    setSidebarCompact(!state.sidebarCompact)
  }

  const toggleRightPanel = () => {
    const next = !useAppStore.getState().rightPanelOpen
    setRightPanelOpen(next)
    if (next && isPhoneViewport()) setSidebar(false)
  }

  const compactSidebarActive = sidebarCompact && !isPhoneViewport()

  // Global keyboard shortcuts. Meta on macOS, Ctrl elsewhere.
  // Esc interrupts the in-flight turn (same key the composer uses to close
  // its mention menu — that path stopPropagation()s, and Esc here is
  // ignored while the user is typing in an editable field).
  useEffect(() => {
    if (IS_ANDROID) return
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && key === 'j') {
        e.preventDefault()
        toggleRightPanel()
      } else if (mod && key === ',') {
        e.preventDefault()
        useAppStore.getState().setSettingsOpen(!useAppStore.getState().settingsOpen)
      } else if (mod && key === 'o') {
        e.preventDefault()
        void useSessionStore.getState().createSession()
      } else if (key === 'escape' && !mod && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
        if (useAppStore.getState().settingsOpen) return
        const { streamingAbort } = useSessionStore.getState()
        if (streamingAbort) {
          e.preventDefault()
          streamingAbort.abort()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const loadSessions = useSessionStore((s) => s.loadFromServer)
  const migrateSessions = useSessionStore((s) => s.migrateFromLocalStorage)
  const loadSettings = useSettingsStore((s) => s.load)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted)
  const locale = useLocaleStore((s) => s.locale)
  const languagePreference = useLocaleStore((s) => s.language)
  const { t } = useI18n()
  const loadProviders = useSettingsStore((s) => s.loadProviders)
  const serverUrl = useSettingsStore((s) => s.connection.serverUrl)
  const connState = useConnectionStore((s) => s.state)
  const loadProjects = useProjectsStore((s) => s.load)

  useEffect(() => {
    const handleRemoteReconnect = (event: Event) => {
      const project = (event as CustomEvent<Project>).detail
      if (project?.kind === 'remote') setRemoteReconnectProject(project)
    }
    window.addEventListener(REMOTE_RECONNECT_EVENT, handleRemoteReconnect)
    return () => window.removeEventListener(REMOTE_RECONNECT_EVENT, handleRemoteReconnect)
  }, [])

  const completeRemoteReconnect = useCallback(async (project: Project) => {
    if (!useProjectsStore.getState().setActive(project.id)) return
    const sessionId = await useSessionStore.getState().createSession('New Chat')
    assignSessionWorkspace(sessionId, project.id)
    setRemoteReconnectProject(null)
  }, [])

  useEffect(() => {
    const handleRemoteRuntimeConnected = (event: Event) => {
      const project = (event as CustomEvent<Project>).detail
      if (project?.kind === 'remote') void completeRemoteReconnect(project)
    }
    window.addEventListener(REMOTE_RUNTIME_CONNECTED_EVENT, handleRemoteRuntimeConnected)
    return () => window.removeEventListener(REMOTE_RUNTIME_CONNECTED_EVENT, handleRemoteRuntimeConnected)
  }, [completeRemoteReconnect])

  // Desktop first launch gets a short, optional setup after the runtime and
  // initial shell are ready. Android now runs the same welcome flow, minus
  // the desktop workspace-folder step, so a fresh install on either platform
  // always surfaces the initialization wizard.
  useEffect(() => {
    // Browser Rust preview participates in onboarding too, which keeps the
    // preview and packaged Tauri clients on the same state machine.
    if (!(IS_TAURI || IS_RUST_PREVIEW) || !appReady || !settingsLoaded) return
    setShowFirstRun(!onboardingCompleted)
  }, [appReady, onboardingCompleted, settingsLoaded])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
  }, [locale])

  // Keep system-language mode live on Android/WebView. WebViews can emit a
  // languagechange event when the device locale changes while the app remains
  // open; explicit user choices stay untouched.
  useEffect(() => {
    if (typeof window === 'undefined' || languagePreference !== 'system') return
    const handleLanguageChange = () => useLocaleStore.getState().initialize('system')
    window.addEventListener('languagechange', handleLanguageChange)
    return () => window.removeEventListener('languagechange', handleLanguageChange)
  }, [languagePreference])

  // The UI and embedded Rust Runtime share the same resolved locale. This is
  // best-effort so browser preview and older remote runtimes remain usable.
  useEffect(() => {
    if (connState !== 'connected') return
    void apiClient.setRuntimeConfig('locale', localeForRuntime(locale)).catch(() => undefined)
  }, [connState, locale])

  // ── Dismiss the NATIVE splash window ─────────────────────────────
  // Desktop shows a real OS-level splash (public/splash.html in its own
  // window) created at process start. When the runtime is connected we
  // reveal the main window and let Rust fade the splash away; it enforces
  // the full ~2.4s design timeline there.
  const notifySplashFinish = useCallback(() => {
    if (!IS_TAURI || IS_ANDROID) return
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('finish_splash').catch(() => undefined))
      .catch(() => undefined)
  }, [])

  const tryDismissSplash = useCallback(() => {
    if (splashFinishedRef.current) return
    splashFinishedRef.current = true
    const elapsed = Date.now() - mountedAt.current
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed)
    setTimeout(() => {
      // Reveal main shell under the in-window AWAKENING overlay; overlay
      // itself fades out via AwakeningSplash leaving prop / timer.
      setAppReady(true)
      notifySplashFinish()
    }, remaining)
  }, [notifySplashFinish])

  // ── Backend readiness: aggressive health poll ──────────────────────
  const checkBackend = useCallback(() => {
    useConnectionStore.getState().check()
  }, [])

  useEffect(() => {
    if (!IS_TAURI || IS_ANDROID) return

    // 1. Listen for the backend:port event. NOTE: the embedded Rust runtime
    //    uses a fixed port (see src-tauri/src/embedded_backend.rs) and this
    //    build does NOT emit the event, so the listener alone used to leave
    //    the window permanently transparent. The port is therefore also
    //    probed directly below.
    let unlisten: (() => void) | undefined
    ;(async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        unlisten = await listen<number>("backend:port", (event) => {
          apiClient.setBaseUrl(`http://127.0.0.1:${event.payload}`)
          checkBackend()
        })
      } catch { /* ignore */ }
    })()

    // 1b. Direct probe of the embedded runtime: the client already defaults to
    //     this URL, but a previously saved remote serverUrl would otherwise
    //     make every health check fail against a dead host.
    const embedded = 'http://127.0.0.1:48081'
    const probeEmbedded = () => {
      const current = useSettingsStore.getState().connection.serverUrl
      if (current.includes('127.0.0.1') || current.includes('localhost')) {
        apiClient.setBaseUrl(embedded)
      }
    }
    probeEmbedded()

    // 2. Poll health every 300ms for the first ~5s (fast detection when
    //    backend is already up). If still not connected after that, fall
    //    back to slow polling every 2s — keeps retrying until backend is
    //    ready, so a slow-booting backend will be picked up automatically.
    let attempts = 0
    let slowTimer: ReturnType<typeof setInterval> | undefined
    const fastTimer = setInterval(() => {
      const { state } = useConnectionStore.getState()
      if (state === 'connected') {
        clearInterval(fastTimer)
        return
      }
      if (++attempts >= 17) {
        clearInterval(fastTimer)
        // Slow polling: keep probing until connected (no give-up)
        slowTimer = setInterval(() => {
          const { state: s } = useConnectionStore.getState()
          if (s === 'connected') {
            clearInterval(slowTimer!)
            slowTimer = undefined
            return
          }
          probeEmbedded()
          checkBackend()
        }, 2000)
        return
      }
      probeEmbedded()
      checkBackend()
    }, 300)
    probeEmbedded()
    checkBackend() // immediate first check

    return () => {
      unlisten?.()
      clearInterval(fastTimer)
      if (slowTimer) clearInterval(slowTimer)
    }
  }, [checkBackend])

  // ── When connected → dismiss splash ────────────────────────────────
  // NOTE: We intentionally do NOT dismiss on connState === 'error'.
  // On a cold start the first few /health probes fail because the backend
  // hasn't bound its port yet; dismissing the splash on 'error' would let
  // loadSessions() run against a dead backend and silently leave the user
  // with an empty UI (the bug we're fixing).
  //
  // The slow poll (every 2s, no give-up) will eventually connect, and THEN
  // the splash dismisses + data loads in the same tick.
  useEffect(() => {
    if (!IS_TAURI || IS_ANDROID) return
    if (connState === 'connected') {
      tryDismissSplash()
    }
  }, [connState, IS_TAURI, tryDismissSplash])

  // ── Safety: if backend truly fails after 60s, dismiss splash anyway ─
  // This only fires if the backend hasn't connected after a full minute
  // (the Rust Runtime failed to start, antivirus blocked it, etc.). The user will see the
  // main UI with a "not connected" state and can open settings to debug.
  //
  // NOTE: this used to be 60s, which meant a transparent window for a full
  // minute whenever the runtime was unreachable — it reads as "the app is
  // broken". 6s is enough for a normal cold start on Windows.
  useEffect(() => {
    if (!IS_TAURI || IS_ANDROID) return
    const t = setTimeout(() => {
      tryDismissSplash()
    }, 6000)
    return () => clearTimeout(t)
  }, [IS_TAURI, tryDismissSplash])

  // Android/Tauri and the explicit browser preview use the Rust Runtime API.
  // Keep the loopback default pointed at that local service, while still
  // allowing a user-configured LAN URL to act as a remote server on Android.
  useEffect(() => {
    if (!IS_ANDROID && !IS_RUST_PREVIEW) return
    let cancelled = false
    void (async () => {
      await loadSettings()
      if (cancelled) return
      const url = useSettingsStore.getState().connection.serverUrl
      const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\/?$/i.test(url)
      for (let attempt = 0; attempt < (isLoopback ? 20 : 1) && !cancelled; attempt += 1) {
        if (await useConnectionStore.getState().check(url)) {
          // Composer can mount before the Rust port is known and cache the
          // legacy server's provider list. Refresh after the Runtime URL is
          // confirmed so every surface uses the same provider catalog.
          await loadProviders()
          return
        }
        if (isLoopback) await new Promise((resolve) => setTimeout(resolve, 300))
      }
      if (!isLoopback && !cancelled) setSettingsOpen(true)
    })()
    return () => { cancelled = true }
  }, [loadProviders, loadSettings, setSettingsOpen])

  // ── Initialize sessions AFTER backend is connected ─────────────────
  // Depends on both `appReady` (UI is visible) and `connState === 'connected'`
  // (backend is actually ready to serve /api/sessions). Without the
  // connState gate, a cold-start where the backend takes >5s to boot
  // would cause loadSessions() to fire against a dead backend, fail
  // silently, and leave the user with an empty UI until they manually
  // refresh — which is exactly the bug we're fixing.
  useEffect(() => {
    if (!appReady) return
    if (connState !== 'connected') return
    // If sessions are already loaded (e.g. transient connState flicker),
    // don't re-run — that would wipe in-memory state and re-fetch.
    if (useSessionStore.getState().loaded) return
    let cancelled = false
    ;(async () => {
      await loadSettings()
      if (cancelled) return
      void migrateSessions().catch((e) => console.warn('session migrate failed:', e))
      void loadProjects().catch((e) => console.warn('projects load failed:', e))
      await loadSessions()
      if (cancelled) return
      // Keep the first view session-free. Historical sessions remain
      // available in the sidebar, but the user explicitly starts a turn by
      // choosing one or pressing New chat.
    })()
    return () => { cancelled = true }
  }, [appReady, connState, loadSessions, loadSettings, loadProjects, migrateSessions])

  // ── Listen for "new chat" from Tauri tray ─────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined
    ;(async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        unlisten = await listen("tray:new-chat", () => {
          useSessionStore.getState().createSession("New Chat").catch((e: unknown) => {
            const detail = e instanceof Error ? e.message : String(e)
            console.error('[app] tray createSession failed:', detail)
            toastApi.error(`新建会话失败：${detail}`)
          })
        })
      } catch { /* ignore */ }
    })()
    return () => { unlisten?.() }
  }, [])

  // ── Refresh server info when connection is ready ───────────────────
  useEffect(() => {
    if (connState === 'connected') refreshServerInfo()
  }, [connState, refreshServerInfo])

  // ── Watch for server URL changes (settings panel) ──────────────────
  useEffect(() => {
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\/?$/i.test(serverUrl)
    if (serverUrl && appReady && (!IS_ANDROID || !isLoopback)) {
      useConnectionStore.getState().check(serverUrl)
    }
  }, [serverUrl, appReady])

  // A persisted desktop panel state should never cover the first mobile view.
  // CSS handles the actual responsive layout; this only resets the initial
  // preference when the viewport enters the phone breakpoint.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    // A minimized desktop WebView reports a phone-sized viewport for a
    // moment. Do not persist a collapsed sidebar from that transient state;
    // desktop users can still resize or collapse it explicitly.
    if (typeof __TAURI_INTERNALS__ !== 'undefined' && !IS_ANDROID) return

    const phoneQuery = window.matchMedia(PHONE_VIEWPORT_QUERY)

    const closePhonePanels = () => {
      if (!isPhoneViewport()) return
      setSidebar(false)
      setRightPanelOpen(false)
    }
    closePhonePanels()
    phoneQuery.addEventListener?.('change', closePhonePanels)
    return () => phoneQuery.removeEventListener?.('change', closePhonePanels)
  }, [setRightPanelOpen, setSidebar])

  return (
    <>
      {/* In-window AWAKENING boot curtain (not a separate OS window). */}
      {!awakeningDone && (
        <AwakeningSplash
          leaving={appReady}
          onExit={() => setAwakeningDone(true)}
          minMs={3200}
        />
      )}

      {/* Main UI — invisible until appReady, then fades in under the overlay. */}
      <TooltipProvider delayDuration={300}>
        <div
          data-testid="app-shell"
          className="app-shell relative flex h-screen w-full max-w-full flex-col overflow-hidden bg-background text-foreground"
          style={{
            opacity: appReady ? 1 : 0,
            transition: 'opacity 0.3s ease-in',
            // Keep layout space but invisible, so there's no layout jump
            visibility: appReady ? 'visible' : 'hidden',
          }}
        >
          {/* Global title bar — spans the full window width and always sits
              ABOVE the side panes, so the window controls (min/max/close),
              settings and right-panel buttons can never be covered by the
              right panel. On Android there is no bar: the controls float as
              glass islands over the content instead. */}
          {IS_ANDROID ? (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-start justify-between gap-2 p-2"
              data-testid="floating-topbar"
            >
              <TopBar
                floating
                onToggleSidebar={toggleSidebar}
                onToggleRightPanel={toggleRightPanel}
                showSidebarToggle={!isFlow}
                flowMode={isFlow}
              />
            </div>
          ) : (
            <TopBar
              onToggleSidebar={toggleSidebar}
              onToggleRightPanel={toggleRightPanel}
              showSidebarToggle={!isFlow}
              flowMode={isFlow}
            />
          )}

          <div className={cn('app-main relative flex min-h-0 flex-1', IS_ANDROID && 'pt-12')}>
            {!isFlow && (sidebarOpen || rightPanelOpen) && (
              <button
                type="button"
                className="app-panel-scrim fixed inset-0 z-20 bg-black/25 backdrop-blur-[1px]"
                data-sidebar-open={sidebarOpen}
                data-right-panel-open={rightPanelOpen}
                aria-label={t('closeSidebar')}
                onClick={() => {
                  setSidebar(false)
                  setRightPanelOpen(false)
                }}
              />
            )}
            {!isFlow && (
              <div
                data-testid="sidebar-wrapper"
                data-panel-open={sidebarOpen}
                data-sidebar-compact={compactSidebarActive ? 'true' : 'false'}
                className={cn(
                  'sidebar-wrapper relative z-30 shrink-0 transition-[width,transform] duration-200 ease-out',
                  sidebarOpen ? 'w-[var(--sidebar-width)]' : 'w-0',
                  'overflow-hidden',
                )}
              >
                <Sidebar />
              </div>
            )}

            {/* Sidebar resize handle — auto-collapses when dragged narrow */}
            {!isFlow && sidebarOpen && !isPhoneViewport() && (
              <ResizeHandle
                className="panel-resize-handle panel-resize-handle-left"
                cssVar="--sidebar-width"
                side="left"
                minPx={160}
                maxPx={compactSidebarActive ? 360 : 420}
                startWidthPx={compactSidebarActive ? 68 : undefined}
                expandThreshold={compactSidebarActive ? 144 : undefined}
                onExpand={compactSidebarActive ? (width) => {
                  setSidebarCompact(false)
                  setSidebar(true)
                  document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
                } : undefined}
                collapseThreshold={compactSidebarActive ? undefined : 120}
                // Dragging the expanded sidebar narrow shrinks it into the
                // compact rail (same resting state as the toggle cycle).
                onCollapse={() => {
                  setSidebarCompact(true)
                  setSidebar(true)
                }}
              />
            )}

            <div className="app-content flex min-h-0 min-w-0 flex-1 flex-col">
              {agentMode === 'flow' ? (
                <Suspense fallback={<DeferredSurface label={locale === 'zh-CN' ? '正在加载' : 'Loading'} />}>
                  <FlowWorkbench />
                </Suspense>
              ) : <ChatView />}
            </div>

            {/* Right panel resize handle */}
            {!isFlow && rightPanelOpen && (
              <ResizeHandle
                className="panel-resize-handle panel-resize-handle-right"
                cssVar="--right-panel-width"
                side="right"
                minPx={240}
                maxPx={720}
              />
            )}

            {!isFlow && (
              <div
                data-testid="right-panel-wrapper"
                data-panel-open={rightPanelOpen}
                className={cn(
                  'right-panel-wrapper relative z-30 shrink-0 transition-[width,transform] duration-200 ease-out',
                  rightPanelOpen ? 'w-[var(--right-panel-width)]' : 'w-0',
                  'overflow-hidden',
                )}
              >
                {rightPanelMounted && (
                  <Suspense fallback={<DeferredSurface label={locale === 'zh-CN' ? '正在加载' : 'Loading'} />}>
                    <RightPanel />
                  </Suspense>
                )}
              </div>
            )}
          </div>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
          <RemoteProjectWizard
            open={Boolean(remoteReconnectProject)}
            initialProject={remoteReconnectProject}
            onOpenChange={(open) => { if (!open) setRemoteReconnectProject(null) }}
            onConnected={(project) => { void completeRemoteReconnect(project) }}
          />
          <TextContextMenu />
          {showFirstRun && <FirstRunSetup onComplete={() => setShowFirstRun(false)} />}
          <Toaster />
          <WindowResizeEdges />
        </div>
      </TooltipProvider>
    </>
  )
}

export default App
