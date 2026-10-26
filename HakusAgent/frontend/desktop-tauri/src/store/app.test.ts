import { describe, expect, it, vi } from 'vitest'

/**
 * Slice D (Phase 6): layout state survives restart without storing
 * transcript data. The app store reads persisted layout at creation time,
 * so each case stubs window/localStorage first and re-imports the module.
 */

const backing = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
}

async function loadAppStore() {
  vi.resetModules()
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: localStorageStub,
    location: { search: '' },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = localStorageStub
  const mod = await import('./app')
  return mod.useAppStore
}

async function loadWithSeed(key: string, value: string) {
  backing.set(key, value)
  try {
    return await loadAppStore()
  } finally {
    backing.delete(key)
  }
}

const RIGHT_PANEL_TAB_KEY = 'hakusai:right-panel-tab'

describe('app store layout persistence (Slice D)', () => {
  it('restores the last active panel tab at creation', async () => {
    const useAppStore = await loadWithSeed(RIGHT_PANEL_TAB_KEY, 'terminal')
    expect(useAppStore.getState().rightPanelTab).toBe('terminal')
  })

  it('falls back to review for unknown, artifact, or corrupt values', async () => {
    for (const bad of ['artifact', 'garbage', '{"transcript":"..."}']) {
      const useAppStore = await loadWithSeed(RIGHT_PANEL_TAB_KEY, bad)
      expect(useAppStore.getState().rightPanelTab).toBe('review')
    }
  })

  it('persists tab switches to the layout key', async () => {
    const useAppStore = await loadAppStore()
    useAppStore.getState().setRightPanelTab('session_log')
    expect(useAppStore.getState().rightPanelTab).toBe('session_log')
    expect(backing.get(RIGHT_PANEL_TAB_KEY)).toBe('session_log')
  })

  it("never persists the artifact pseudo-tab (its content isn't layout state)", async () => {
    const useAppStore = await loadAppStore()
    useAppStore.getState().setRightPanelTab('goal')
    useAppStore.getState().openRightPanelArtifact({ title: 't', content: 'x'.repeat(5000), language: 'md' })
    expect(useAppStore.getState().rightPanelTab).toBe('artifact')
    // The restorable layout stays the last real panel; no artifact content
    // or any transcript-shaped data may land in storage.
    expect(backing.get(RIGHT_PANEL_TAB_KEY)).toBe('goal')
    for (const value of backing.values()) {
      expect(value.length).toBeLessThan(64)
    }
  })

  it('stores only short enum-shaped keys/values — no transcript data in localStorage', async () => {
    const useAppStore = await loadAppStore()
    useAppStore.getState().setRightPanelTab('usage')
    useAppStore.getState().setSidebarCompact(true)
    useAppStore.getState().setAgentMode('deep')
    useAppStore.getState().setReasoningEffort('deep', 'high')
    const layoutKeys = Array.from(backing.keys())
    expect(layoutKeys).toContain(RIGHT_PANEL_TAB_KEY)
    for (const [key, value] of backing) {
      expect(key.startsWith('hakusai:'), `layout key ${key} is namespaced`).toBe(true)
      expect(value.length, `layout value for ${key} is a short enum, not data`).toBeLessThan(256)
    }
  })
})
