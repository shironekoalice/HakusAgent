import type { ComponentType } from 'react'
import {
  Coins,
  FolderTree,
  GitCompareArrows,
  Globe,
  ScrollText,
  Target,
  TerminalSquare,
  Waypoints,
  Workflow,
  FileClock,
} from 'lucide-react'
import type { RightPanelTab } from '@/store/app'
import { DiffReview } from '@/components/review/DiffReview'
import { TerminalPanel } from '@/components/review/TerminalPanel'
import { BrowserPanel } from '@/components/review/BrowserPanel'
import { LogsPanel } from '@/components/review/LogsPanel'
import { SessionLogTab } from '@/components/review/SessionLogTab'
import { UsageCostPanel } from '@/components/review/UsageCostPanel'
import { GoalPanel } from '@/components/review/GoalPanel'
import { WorktreePanel } from '@/components/review/WorktreePanel'
import { FilesPanel } from '@/components/review/FilesPanel'
import { FlowRunPanel } from '@/components/flow/FlowRunPanel'
import { embeddedBrowserAvailable } from '@/lib/agentBrowser'

/**
 * Workbench panel registry (Phase 6: unified desktop workbench).
 *
 * Replaces RightPanel's hardcoded TABS array: a panel is registered here
 * once with its id, label, icon, availability and component; the tab strip
 * and the body renderer both derive from this list. `artifact` remains a
 * runtime-only pseudo-tab outside the registry (it exists only when an
 * artifact is opened).
 */

export interface PanelTabDef {
  id: Exclude<RightPanelTab, 'artifact'>
  labelKey:
    | 'reviewTab'
    | 'usageTab'
    | 'goalTab'
    | 'worktreeTab'
    | 'filesTab'
    | 'flowRunTab'
    | 'trajectoryTab'
    | 'terminalTab'
    | 'browserTab'
    | 'logsTab'
  icon: typeof GitCompareArrows
  /** Panels without extra props. BrowserPanel receives `active`. */
  component: ComponentType<{ active?: boolean }>
  /** Return false to hide the tab entirely (e.g. no embedded browser). */
  available?: () => boolean
  /** Rendered permanently (hidden via CSS) so its state survives tab switches. */
  keepMounted?: boolean
}

export const PANEL_TABS: PanelTabDef[] = [
  { id: 'review', labelKey: 'reviewTab', icon: GitCompareArrows, component: DiffReview },
  { id: 'usage', labelKey: 'usageTab', icon: Coins, component: UsageCostPanel },
  { id: 'goal', labelKey: 'goalTab', icon: Target, component: GoalPanel },
  { id: 'worktree', labelKey: 'worktreeTab', icon: Waypoints, component: WorktreePanel },
  { id: 'files', labelKey: 'filesTab', icon: FolderTree, component: FilesPanel },
  { id: 'flow', labelKey: 'flowRunTab', icon: Workflow, component: FlowRunPanel },
  { id: 'session_log', labelKey: 'trajectoryTab', icon: FileClock, component: SessionLogTab },
  { id: 'terminal', labelKey: 'terminalTab', icon: TerminalSquare, component: TerminalPanel },
  {
    id: 'browser',
    labelKey: 'browserTab',
    icon: Globe,
    component: BrowserPanel,
    available: embeddedBrowserAvailable,
    // The embedded browser is a native child webview: remounting it on every
    // tab switch would reload the page, so it stays mounted and is hidden.
    keepMounted: true,
  },
  { id: 'logs', labelKey: 'logsTab', icon: ScrollText, component: LogsPanel },
]

export function visiblePanelTabs(): PanelTabDef[] {
  return PANEL_TABS.filter((tab) => !tab.available || tab.available())
}
