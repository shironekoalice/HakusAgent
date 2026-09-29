import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  House,
  Loader2,
  Plus,
  RotateCw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listen } from '@tauri-apps/api/event'
import {
  browserOs,
  embeddedBrowserAvailable,
  registerBrowserPanel,
  type BrowserAction,
  type BrowserBounds,
} from '@/lib/agentBrowser'
import { useAppStore } from '@/store/app'
import { useI18n } from '@/lib/i18n'
import { createBrowserTab, getBrowserTabTitle, normalizeBrowserAddress, type BrowserTab } from '@/lib/browserTabs'
import { useDragScroll } from './useDragScroll'

type BrowserLocationEvent = { tabId: string; url: string }
type BrowserTitleEvent = { tabId: string; title: string }
type BrowserPageEvent = { tabId: string; url: string; loading: boolean }
type BrowserNewTabEvent = { sourceTabId: string; url: string }

let sessionTabs = [createBrowserTab()]
let sessionActiveTabId = sessionTabs[0].id

export function BrowserPanel({ active = true }: { active?: boolean }) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const viewportRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const tabStrip = useDragScroll<HTMLDivElement>()
  const activeRef = useRef(active)
  const readyRef = useRef(false)
  const readyTabIdRef = useRef<string | null>(null)
  const tabsRef = useRef(sessionTabs)
  const activeTabIdRef = useRef(sessionActiveTabId)
  const [tabs, setTabs] = useState<BrowserTab[]>(() => sessionTabs)
  const [activeTabId, setActiveTabId] = useState(() => sessionActiveTabId)
  const [address, setAddress] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  activeRef.current = active

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs])
  const tabIdsKey = tabIds.join('|')
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]
  const activeHasPage = Boolean(activeTab?.url)

  const commitTabs = useCallback((next: BrowserTab[]) => {
    sessionTabs = next
    tabsRef.current = next
    setTabs(next)
  }, [])

  const selectTab = useCallback((tabId: string) => {
    sessionActiveTabId = tabId
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
  }, [])

  const updateTab = useCallback((tabId: string, update: Partial<BrowserTab>) => {
    const next = tabsRef.current.map((tab) => tab.id === tabId ? { ...tab, ...update } : tab)
    commitTabs(next)
  }, [commitTabs])

  const bounds = useCallback((): BrowserBounds => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : { x: 0, y: 0, width: 1, height: 1 }
  }, [])

  const createTab = useCallback((url = '') => {
    const tab = createBrowserTab(url)
    commitTabs([...tabsRef.current, tab])
    selectTab(tab.id)
    setAddress(url)
    setError('')
    return tab
  }, [commitTabs, selectTab])

  const closeTab = useCallback((tabId: string) => {
    const previous = tabsRef.current
    const index = previous.findIndex((tab) => tab.id === tabId)
    if (index < 0) return Promise.resolve()

    const next = previous.filter((tab) => tab.id !== tabId)
    const replacement = next.length
      ? next[Math.min(index, next.length - 1)]
      : createBrowserTab()
    if (!next.length) next.push(replacement)

    commitTabs(next)
    if (activeTabIdRef.current === tabId) {
      selectTab(replacement.id)
      setAddress(replacement.url)
    }
    return browserOs.closeTab(tabId).catch(() => undefined)
  }, [commitTabs, selectTab])

  const runAction = useCallback(async (action: BrowserAction) => {
    const tabId = activeTabIdRef.current
    setBusy(true)
    setError('')
    try {
      await browserOs.create(tabId, bounds())
      if (action.action === 'navigate') {
        await browserOs.select(tabId, tabsRef.current.map((tab) => tab.id), bounds(), false)
      }
      const result = await browserOs.action(tabId, action)
      if (action.action === 'clear') await browserOs.closeTab(tabId)
      if (typeof result.url === 'string') {
        const url = result.url === 'about:blank' ? '' : result.url
        updateTab(tabId, { url })
        if (document.activeElement !== addressRef.current) setAddress(url)
      }
      if (result.ok === false) throw new Error(String(result.error || 'Browser action failed'))
      return JSON.stringify(result)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw cause
    } finally {
      setBusy(false)
    }
  }, [bounds, updateTab])

  const navigate = useCallback(async (tabId: string, value: string) => {
    const url = normalizeBrowserAddress(value)
    if (!url) return
    setBusy(true)
    setError('')
    try {
      await browserOs.create(tabId, bounds())
      await browserOs.select(tabId, tabsRef.current.map((tab) => tab.id), bounds(), false)
      setAddress(url)
      const result = await browserOs.action(tabId, { action: 'navigate', url })
      if (result.ok === false) throw new Error(String(result.error || 'Navigation failed'))
      updateTab(tabId, { url, loading: true })
      if (document.activeElement === addressRef.current) addressRef.current?.blur()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      updateTab(tabId, { loading: false })
    } finally {
      setBusy(false)
    }
  }, [bounds, updateTab])

  const openRequestedTab = useCallback(async (url: string) => {
    const tab = createTab(url)
    if (!url) return tab
    try {
      await browserOs.create(tab.id, bounds())
      await browserOs.select(tab.id, tabsRef.current.map((item) => item.id), bounds(), Boolean(tab.url))
      await browserOs.action(tab.id, { action: 'navigate', url })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    return tab
  }, [bounds, createTab])

  useEffect(() => {
    const location = listen<BrowserLocationEvent>('browser-location-changed', ({ payload }) => {
      if (!payload || typeof payload !== 'object') return
      if (payload.url === 'about:blank') return
      const url = payload.url
      updateTab(payload.tabId, { url })
      if (payload.tabId === activeTabIdRef.current && document.activeElement !== addressRef.current) {
        setAddress(url)
      }
    })
    const title = listen<BrowserTitleEvent>('browser-title-changed', ({ payload }) => {
      if (payload && typeof payload === 'object') {
        if (payload.title.trim() === 'about:blank') return
        const current = tabsRef.current.find((tab) => tab.id === payload.tabId)
        if (payload.title || !current?.url) updateTab(payload.tabId, { title: payload.title })
      }
    })
    const page = listen<BrowserPageEvent>('browser-page-load', ({ payload }) => {
      if (payload && typeof payload === 'object') {
        if (payload.url !== 'about:blank') {
          updateTab(payload.tabId, { loading: payload.loading, url: payload.url })
        }
      }
    })
    const newTab = listen<BrowserNewTabEvent>('browser-new-tab-requested', ({ payload }) => {
      if (payload && typeof payload === 'object' && /^https?:\/\//i.test(payload.url)) {
        void openRequestedTab(payload.url)
      }
    })
    const unregister = registerBrowserPanel({
      execute: async (action) => {
        useAppStore.getState().setRightPanelTab('browser')
        const deadline = Date.now() + 15000
        while ((!readyRef.current || !activeRef.current || readyTabIdRef.current !== activeTabIdRef.current) && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 50))
        }
        if (!readyRef.current || !activeRef.current || readyTabIdRef.current !== activeTabIdRef.current) {
          throw new Error('Browser panel did not become ready')
        }

        if (action.action === 'list_tabs') {
          return JSON.stringify({
            ok: true,
            activeTabId: activeTabIdRef.current,
            tabs: tabsRef.current.map((tab) => ({ ...tab, active: tab.id === activeTabIdRef.current })),
          })
        }
        if (action.action === 'open_tab') {
          const url = action.url ? normalizeBrowserAddress(action.url) : ''
          const tab = await openRequestedTab(url)
          return JSON.stringify({ ok: true, tabId: tab.id, url: tab.url, active: true })
        }
        if (action.action === 'switch_tab') {
          const tab = tabsRef.current.find((item) => item.id === action.tabId)
          if (!tab) throw new Error('Browser tab was not found')
          selectTab(tab.id)
          setAddress(tab.url)
          await browserOs.create(tab.id, bounds())
          await browserOs.select(tab.id, tabsRef.current.map((item) => item.id), bounds(), Boolean(tab.url))
          return JSON.stringify({ ok: true, tabId: tab.id, url: tab.url, active: true })
        }
        if (action.action === 'close_tab') {
          const tabId = action.tabId || activeTabIdRef.current
          if (!tabsRef.current.some((tab) => tab.id === tabId)) throw new Error('Browser tab was not found')
          await closeTab(tabId)
          return JSON.stringify({ ok: true, activeTabId: activeTabIdRef.current })
        }
        return runAction(action)
      },
    })

    return () => {
      unregister()
      void Promise.all([location, title, page, newTab]).then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
      void browserOs.suspend(tabsRef.current.map((tab) => tab.id))
      readyRef.current = false
      readyTabIdRef.current = null
    }
  }, [bounds, closeTab, openRequestedTab, runAction, selectTab, updateTab])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable()) {
      readyRef.current = false
      readyTabIdRef.current = null
      setReady(false)
      void browserOs.suspend(tabIds)
      return
    }

    if (!activeHasPage) {
      readyRef.current = true
      readyTabIdRef.current = activeTabId
      setReady(true)
      setError('')
      void browserOs.closeTab(activeTabId).catch(() => undefined)
      void browserOs.hideTabs(tabIds.filter((tabId) => tabId !== activeTabId))
      return
    }

    let disposed = false
    let boundsFrame = 0
    const updateBounds = () => {
      if (boundsFrame) cancelAnimationFrame(boundsFrame)
      boundsFrame = requestAnimationFrame(() => {
        boundsFrame = 0
        if (!disposed && activeRef.current) {
          void browserOs.setBounds(activeTabId, bounds()).catch(() => undefined)
        }
      })
    }
    const observer = viewportRef.current ? new ResizeObserver(updateBounds) : null
    if (viewportRef.current) observer?.observe(viewportRef.current)
    window.addEventListener('resize', updateBounds)
    window.addEventListener('scroll', updateBounds, true)

    void (async () => {
      try {
        readyRef.current = false
        readyTabIdRef.current = null
        setReady(false)
        await browserOs.create(activeTabId, bounds())
        await browserOs.select(activeTabId, tabIds, bounds(), activeHasPage)
        await browserOs.setBounds(activeTabId, bounds())
        if (!disposed) {
          readyRef.current = true
          readyTabIdRef.current = activeTabId
          setReady(true)
        }
      } catch (cause) {
        if (!disposed) {
          readyRef.current = false
          readyTabIdRef.current = null
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()

    return () => {
      disposed = true
      if (readyTabIdRef.current === activeTabId) {
        readyRef.current = false
        readyTabIdRef.current = null
      }
      if (boundsFrame) cancelAnimationFrame(boundsFrame)
      observer?.disconnect()
      window.removeEventListener('resize', updateBounds)
      window.removeEventListener('scroll', updateBounds, true)
    }
  }, [active, activeTabId, activeHasPage, bounds, tabIdsKey])

  useEffect(() => {
    setAddress(activeTab?.url ?? '')
  }, [activeTab?.id])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'l') {
        event.preventDefault()
        addressRef.current?.focus()
        addressRef.current?.select()
      } else if (key === 't') {
        event.preventDefault()
        createTab()
      } else if (key === 'w') {
        event.preventDefault()
        closeTab(activeTabIdRef.current)
      } else if (key === 'tab') {
        event.preventDefault()
        const currentTabs = tabsRef.current
        if (currentTabs.length < 2) return
        const currentIndex = currentTabs.findIndex((tab) => tab.id === activeTabIdRef.current)
        const offset = event.shiftKey ? -1 : 1
        const nextIndex = (currentIndex + offset + currentTabs.length) % currentTabs.length
        selectTab(currentTabs[nextIndex].id)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, closeTab, createTab, selectTab])

  if (!embeddedBrowserAvailable()) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{copy('此平台暫不支持內置瀏覽器', 'The embedded browser is unavailable on this platform')}</div>
  }

  return (
    <div className="browser-panel flex h-full min-h-0 flex-col bg-background">
      <div className="browser-tab-strip flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2" role="tablist" aria-orientation="horizontal" aria-label={copy('瀏覽器標籤頁', 'Browser tabs')}>
        <div
          ref={tabStrip.ref}
          onPointerDown={tabStrip.onPointerDown}
          className="browser-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          data-drag-scrollable="false"
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId
            return (
              <div key={tab.id} role="presentation" className="browser-tab flex min-w-0 items-center" data-active={selected}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  id={`browser-tab-${tab.id}`}
                  aria-controls={selected ? `browser-view-${tab.id}` : undefined}
                  className="browser-tab-select flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs"
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    const current = tabsRef.current
                    const index = current.findIndex((item) => item.id === tab.id)
                    const delta = event.key === 'ArrowRight' ? 1 : -1
                    const next = current[(index + delta + current.length) % current.length]
                    selectTab(next.id)
                    requestAnimationFrame(() => document.getElementById(`browser-tab-${next.id}`)?.focus())
                  }}
                  title={getBrowserTabTitle(tab, copy('新标签页', 'New Tab'))}
                >
                  {tab.loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Globe className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{getBrowserTabTitle(tab, copy('新标签页', 'New Tab'))}</span>
                </button>
                <button
                  type="button"
                  className="browser-tab-close inline-flex h-6 w-6 shrink-0 items-center justify-center"
                  aria-label={copy(`关闭 ${getBrowserTabTitle(tab, '新标签页')}`, `Close ${getBrowserTabTitle(tab, 'New Tab')}`)}
                  title={copy('关闭标签页', 'Close tab')}
                  onClick={() => closeTab(tab.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" title={copy('新建标签页', 'New tab')} aria-label={copy('新建标签页', 'New tab')} onClick={() => createTab()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!ready || busy || !activeTab?.url} title={copy('后退', 'Back')} aria-label={copy('后退', 'Back')} onClick={() => void runAction({ action: 'back' }).catch(() => undefined)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!ready || busy || !activeTab?.url} title={copy('前进', 'Forward')} aria-label={copy('前进', 'Forward')} onClick={() => void runAction({ action: 'forward' }).catch(() => undefined)}>
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!ready || busy || !activeTab?.url} title={copy('刷新', 'Reload')} aria-label={copy('刷新', 'Reload')} onClick={() => void runAction({ action: 'reload' }).catch(() => undefined)}>
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <form
          className="flex min-w-0 flex-1 items-center"
          onSubmit={(event) => {
            event.preventDefault()
            if (activeTab) void navigate(activeTab.id, address)
          }}
        >
          <div className="browser-address-bar flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={addressRef}
              aria-label={copy('網址或搜索', 'Address or search')}
              name="browser-address"
              // This is an app-owned address field, not a credential/profile
              // field. Letting WebView2 treat it as a URL autofill target
              // opens the browser's saved-information popup on focus.
              autoComplete="off"
              inputMode="url"
              spellCheck={false}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder={copy('搜索或输入网址…', 'Search or enter address…')}
              className="browser-address-input min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70"
            />
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
        </form>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!ready} title={copy('新标签页', 'New Tab')} aria-label={copy('新标签页', 'New Tab')} onClick={() => {
          const tabId = activeTabIdRef.current
          void browserOs.action(tabId, { action: 'clear' })
            .then(() => browserOs.closeTab(tabId))
            .then(() => updateTab(tabId, { url: '', title: '', loading: false }))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          setAddress('')
        }}>
          <House className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && <div role="status" className="shrink-0 break-words border-b border-destructive/30 px-3 py-1.5 text-xs text-destructive">{error}</div>}
      <div ref={viewportRef} className="browser-viewport relative min-h-0 flex-1 bg-white" role="tabpanel" id={`browser-view-${activeTabId}`} aria-labelledby={`browser-tab-${activeTabId}`}>
        {!activeTab?.url && (
          <div className="browser-start-page absolute inset-0 flex flex-col items-center justify-center gap-3 px-5 text-center">
            <div className="browser-start-mark flex h-12 w-12 items-center justify-center rounded-xl border border-border/70 bg-muted/30">
              <Globe className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="text-sm font-medium text-foreground">{copy('新标签页', 'New Tab')}</h2>
            <button type="button" className="browser-start-search text-xs text-muted-foreground" onClick={() => addressRef.current?.focus()}>
              {copy('搜索或输入网址', 'Search or enter address')}
            </button>
          </div>
        )}
        {!ready && !error && (
          <div className="absolute inset-x-0 bottom-3 flex items-center justify-center text-[11px] text-muted-foreground">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            {copy('正在启动浏览器…', 'Starting browser…')}
          </div>
        )}
      </div>
    </div>
  )
}
