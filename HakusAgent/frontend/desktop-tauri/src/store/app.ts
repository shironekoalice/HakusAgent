/**
 * App-level store — non-persisted runtime state
 * (model info, sidebar visibility, settings dialog open state, etc.)
 */

import { create } from 'zustand'
import { apiClient } from '@/api/client'
import type { AgentMode } from '@/api/types'
import { AGENT_MODE_META, type ReasoningEffort } from '@/lib/agentModes'

interface ModelInfo {
  provider: string
  model_name: string
}

export type { AgentMode }
export type RightPanelTab =
  | 'review'
  | 'usage'
  | 'goal'
  | 'worktree'
  | 'files'
  | 'flow'
  | 'session_log'
  | 'terminal'
  | 'browser'
  | 'logs'
  | 'artifact'
export type SettingsCategory =
  | 'general'
  | 'character'
  | 'voice'
  | 'models'
  | 'workspace-data'
  | 'tools'
  | 'automations'
  | 'skills'
  | 'mcp'
  | 'wechat'
  | 'appearance'
  | 'tray'
  | 'about'

/** A document/artifact produced in AI output, opened in the right panel. */
export interface RightPanelArtifact {
  title: string
  content: string
  /** Fence language of the source block ('' for plain text). */
  language: string
}

interface AppStore {
  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebar: (open: boolean) => void
  /** Desktop-only preference for the narrow icon rail. Mobile keeps the full drawer. */
  sidebarCompact: boolean
  setSidebarCompact: (compact: boolean) => void

  // Right panel (review/terminal pane + opened artifacts)
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  /** Last artifact opened from AI output; shown in the 'artifact' tab. */
  rightPanelArtifact: RightPanelArtifact | null
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: RightPanelTab) => void
  openRightPanelArtifact: (artifact: RightPanelArtifact) => void

  // Agent mode (Work = swift, Code = deep. Fleet retired from UI but
  // type kept for backward compat with old session_log entries.)
  agentMode: AgentMode
  setAgentMode: (mode: AgentMode) => void

  // Per-mode reasoning effort override (DeepSeek thinking mode).
  // Keyed by agent mode so each mode remembers its own setting.
  // When undefined for a mode, the mode's default from
  // AGENT_MODE_META[mode].reasoningEffort is used.
  reasoningEfforts: Partial<Record<AgentMode, ReasoningEffort>>
  setReasoningEffort: (mode: AgentMode, effort: ReasoningEffort) => void
  /** Get the effective reasoning effort for a mode (override or default). */
  getReasoningEffort: (mode: AgentMode) => ReasoningEffort

  // Settings dialog
  settingsOpen: boolean
  settingsInitialCategory: SettingsCategory
  setSettingsOpen: (open: boolean) => void
  setSettingsInitialCategory: (category: SettingsCategory) => void

  // Server-side info
  model: ModelInfo | null
  characterName: string
  refreshServerInfo: () => Promise<void>

  // Token usage (session-wide totals)
  totalInputTokens: number
  totalOutputTokens: number
  addTokens: (input: number, output: number) => void
  resetTokens: () => void
}

const SIDEBAR_KEY = 'hakusai:sidebar-open'
const SIDEBAR_COMPACT_KEY = 'hakusai:sidebar-compact'
const RIGHT_PANEL_KEY = 'hakusai:right-panel-open'
const AGENT_MODE_KEY = 'hakusai:agent-mode'
const REASONING_EFFORTS_KEY = 'hakusai:reasoning-efforts'

function readSidebarOpen(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

function writeSidebarOpen(open: boolean) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SIDEBAR_KEY, String(open))
  } catch {
    /* ignore */
  }
}

function readSidebarCompact(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = localStorage.getItem(SIDEBAR_COMPACT_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

function writeSidebarCompact(compact: boolean) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SIDEBAR_COMPACT_KEY, String(compact))
  } catch {
    /* ignore */
  }
}

function readRightPanelOpen(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = localStorage.getItem(RIGHT_PANEL_KEY)
    return raw === null ? false : raw === 'true'
  } catch {
    return false
  }
}

function writeRightPanelOpen(open: boolean) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(RIGHT_PANEL_KEY, String(open))
  } catch {
    /* ignore */
  }
}

function readAgentMode(): AgentMode {
  if (typeof window === 'undefined') return 'swift'
  try {
    const raw = localStorage.getItem(AGENT_MODE_KEY) as AgentMode | null
    // 'fleet' is retired from the UI; normalize legacy persisted value.
    if (raw === 'swift' || raw === 'deep' || raw === 'flow') return raw
    return 'swift'
  } catch {
    return 'swift'
  }
}

function writeAgentMode(mode: AgentMode) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(AGENT_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

function readReasoningEfforts(): Partial<Record<AgentMode, ReasoningEffort>> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(REASONING_EFFORTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    // Validate keys and values. 'fleet' key is legacy but harmless — kept
    // so users who previously tuned fleet's reasoning don't lose data
    // if fleet mode is ever re-enabled.
    const valid: Partial<Record<AgentMode, ReasoningEffort>> = {}
    for (const k of ['swift', 'deep', 'fleet'] as AgentMode[]) {
      const v = parsed[k]
      if (typeof v === 'string' && /^(auto|off|minimal|low|medium|high|xhigh|ultra|max)$/i.test(v)) {
        valid[k] = v.toLowerCase()
      }
    }
    return valid
  } catch {
    return {}
  }
}

function writeReasoningEfforts(efforts: Partial<Record<AgentMode, ReasoningEffort>>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(REASONING_EFFORTS_KEY, JSON.stringify(efforts))
  } catch {
    /* ignore */
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  sidebarOpen: readSidebarOpen(),
  toggleSidebar: () => {
    const next = !get().sidebarOpen
    writeSidebarOpen(next)
    set({ sidebarOpen: next })
  },
  setSidebar: (open) => {
    writeSidebarOpen(open)
    set({ sidebarOpen: open })
  },
  sidebarCompact: readSidebarCompact(),
  setSidebarCompact: (compact) => {
    writeSidebarCompact(compact)
    set({ sidebarCompact: compact })
  },

  rightPanelOpen: readRightPanelOpen(),
  rightPanelTab: 'review',
  rightPanelArtifact: null,
  toggleRightPanel: () => {
    const next = !get().rightPanelOpen
    writeRightPanelOpen(next)
    set({ rightPanelOpen: next })
  },
  setRightPanelOpen: (open) => {
    writeRightPanelOpen(open)
    set({ rightPanelOpen: open })
  },
  setRightPanelTab: (tab) => set({ rightPanelTab: tab, rightPanelOpen: true }),
  openRightPanelArtifact: (artifact) =>
    set({ rightPanelArtifact: artifact, rightPanelTab: 'artifact', rightPanelOpen: true }),

  agentMode: readAgentMode(),
  setAgentMode: (mode) => {
    writeAgentMode(mode)
    set({ agentMode: mode })
  },

  reasoningEfforts: readReasoningEfforts(),
  setReasoningEffort: (mode, effort) => {
    const next = { ...get().reasoningEfforts, [mode]: effort }
    writeReasoningEfforts(next)
    set({ reasoningEfforts: next })
  },
  getReasoningEffort: (mode) => {
    const override = get().reasoningEfforts[mode]
    return override ?? AGENT_MODE_META[mode].reasoningEffort
  },

  settingsOpen: false,
  settingsInitialCategory: 'models',
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsInitialCategory: (category) => set({ settingsInitialCategory: category }),

  model: null,
  characterName: 'HakusAI',
  refreshServerInfo: async () => {
    try {
      const config = await apiClient.getConfig()
      set({
        model: {
          provider: config.model.provider,
          model_name: config.model.model_name,
        },
        characterName: config.character.name || 'HakusAI',
      })
    } catch (e) {
      // ignore — server may be unreachable
    }
  },

  totalInputTokens: 0,
  totalOutputTokens: 0,
  addTokens: (input, output) =>
    set({
      totalInputTokens: get().totalInputTokens + input,
      totalOutputTokens: get().totalOutputTokens + output,
    }),
  resetTokens: () => set({ totalInputTokens: 0, totalOutputTokens: 0 }),
}))
