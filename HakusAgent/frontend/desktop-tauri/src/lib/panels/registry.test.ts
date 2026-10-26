import { describe, expect, it } from 'vitest'
import { PANEL_TABS, visiblePanelTabs } from './registry'
import { RESTORABLE_PANEL_TABS } from '@/store/app'

describe('workbench panel registry', () => {
  it('registers each tab exactly once with a component and label', () => {
    const ids = PANEL_TABS.map((tab) => tab.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tab of PANEL_TABS) {
      expect(tab.component, `panel ${tab.id} has a component`).toBeTruthy()
      expect(tab.labelKey, `panel ${tab.id} has a label`).toBeTruthy()
      expect(tab.icon, `panel ${tab.id} has an icon`).toBeTruthy()
    }
  })

  it('can restore every registered tab at launch (Slice D layout persistence)', () => {
    // The persisted-tab mirror in store/app must know every registry id,
    // or a panel the user was last on would silently fall back to review.
    for (const tab of PANEL_TABS) {
      expect(
        (RESTORABLE_PANEL_TABS as readonly string[]).includes(tab.id),
        `restorable tabs cover ${tab.id}`,
      ).toBe(true)
    }
    // 'artifact' is runtime-only and must never be persisted.
    expect((RESTORABLE_PANEL_TABS as readonly string[]).includes('artifact')).toBe(false)
  })

  it('covers the five workbench surfaces required by Phase 6', () => {
    const ids = new Set(PANEL_TABS.map((tab) => tab.id))
    // Chat lives outside the right panel (it is the primary surface); the
    // registry must still cover editor/flow, terminal, tasks (goal/plan
    // surface), review and the trajectory log for a single session.
    for (const required of ['review', 'terminal', 'goal', 'session_log', 'flow']) {
      expect(ids.has(required), `registry covers ${required}`).toBe(true)
    }
  })

  it('hides the browser tab when the embedded browser is unavailable', () => {
    const browser = PANEL_TABS.find((tab) => tab.id === 'browser')
    expect(browser).toBeDefined()
    expect(browser!.available).toBeDefined()
    expect(visiblePanelTabs().some((tab) => tab.id === 'browser')).toBe(
      browser!.available!(),
    )
  })

  it('keeps the embedded browser mounted across tab switches', () => {
    const browser = PANEL_TABS.find((tab) => tab.id === 'browser')
    expect(browser?.keepMounted).toBe(true)
  })
})
