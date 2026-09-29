import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  FileClock,
  FileText,
  FolderTree,
  Globe,
  GitCompareArrows,
  ScrollText,
  Target,
  TerminalSquare,
  Waypoints,
  X,
  Coins,
  Workflow,
} from 'lucide-react'
import { useAppStore, type RightPanelTab } from '@/store/app'
import { cn, copyToClipboard } from '@/lib/utils'
import { DiffReview } from './DiffReview'
import { TerminalPanel } from './TerminalPanel'
import { BrowserPanel } from './BrowserPanel'
import { LogsPanel } from './LogsPanel'
import { SessionLogTab } from './SessionLogTab'
import { UsageCostPanel } from './UsageCostPanel'
import { GoalPanel } from './GoalPanel'
import { WorktreePanel } from './WorktreePanel'
import { FilesPanel } from './FilesPanel'
import { FlowRunPanel } from '@/components/flow/FlowRunPanel'
import { RpEmpty, RpHeader, RpIconButton } from './PanelChrome'
import { useDragScroll } from './useDragScroll'
import { useI18n } from '@/lib/i18n'
import { embeddedBrowserAvailable } from '@/lib/agentBrowser'

type TabDef = {
  id: Exclude<RightPanelTab, 'artifact'>
  labelKey: 'reviewTab' | 'usageTab' | 'goalTab' | 'worktreeTab' | 'filesTab' | 'flowRunTab' | 'trajectoryTab' | 'terminalTab' | 'browserTab' | 'logsTab'
  icon: typeof GitCompareArrows
}

const TABS: TabDef[] = [
  { id: 'review', labelKey: 'reviewTab', icon: GitCompareArrows },
  { id: 'usage', labelKey: 'usageTab', icon: Coins },
  { id: 'goal', labelKey: 'goalTab', icon: Target },
  { id: 'worktree', labelKey: 'worktreeTab', icon: Waypoints },
  { id: 'files', labelKey: 'filesTab', icon: FolderTree },
  { id: 'flow', labelKey: 'flowRunTab', icon: Workflow },
  { id: 'session_log', labelKey: 'trajectoryTab', icon: FileClock },
  { id: 'terminal', labelKey: 'terminalTab', icon: TerminalSquare },
  { id: 'browser', labelKey: 'browserTab', icon: Globe },
  { id: 'logs', labelKey: 'logsTab', icon: ScrollText },
]

const DOC_LANGS = new Set(['markdown', 'md', 'mdx', 'text', 'txt', 'plaintext'])

function ArtifactView() {
  const { t } = useI18n()
  const artifact = useAppStore((s) => s.rightPanelArtifact)
  const [copied, setCopied] = useState(false)

  if (!artifact) {
    return (
      <div className="rp-shell">
        <RpEmpty icon={FileText} title={t('openInPanel')} />
      </div>
    )
  }

  const isDoc = DOC_LANGS.has(artifact.language.toLowerCase())

  const handleCopy = async () => {
    const ok = await copyToClipboard(artifact.content)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="rp-shell">
      <RpHeader
        icon={FileText}
        title={artifact.title}
        meta={
          artifact.language && !isDoc ? (
            <span className="rp-chip rp-chip-muted font-mono">{artifact.language}</span>
          ) : null
        }
        actions={
          <RpIconButton
            icon={copied ? Check : Copy}
            title={t('copyLabel')}
            onClick={handleCopy}
            className={copied ? 'text-emerald-500' : undefined}
          />
        }
      />
      <div className="rp-body">
        {isDoc ? (
          <div className="rp-pad text-[13px] leading-relaxed [&_h1,&_h2,&_h3]:mb-2 [&_h1,&_h2,&_h3]:mt-4 [&_h1,&_h2,&_h3]:text-[13px] [&_h1,&_h2,&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted/50 [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[11px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
            {artifact.content}
          </pre>
        )}
      </div>
    </div>
  )
}

export function RightPanel() {
  const { t } = useI18n()
  const tab = useAppStore((s) => s.rightPanelTab)
  const setTab = useAppStore((s) => s.setRightPanelTab)
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen)
  const artifact = useAppStore((s) => s.rightPanelArtifact)
  // The embedded browser is a native child webview that renders above all
  // DOM — including the fullscreen settings dialog. Treat settings as
  // "not active" so the native views get suspended while it's open.
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // 标签多于面板宽度时，允许按住鼠标左右拖动平移这一排标签。
  const tabStrip = useDragScroll<HTMLDivElement>()

  return (
    <aside className="right-panel flex h-full w-full min-w-0 shrink-0 flex-col">
      <div className="right-panel-mobile-header">
        <span>{t('workbench')}</span>
        <button
          type="button"
          className="right-panel-mobile-close"
          onClick={() => setRightPanelOpen(false)}
          aria-label={t('reviewPanel')}
          title={t('reviewPanel')}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Workbench tab strip */}
      <div
        ref={tabStrip.ref}
        onPointerDown={tabStrip.onPointerDown}
        className="right-panel-tabs flex shrink-0 items-center overflow-x-auto"
        role="tablist"
        aria-label={t('workbench')}
      >
        {TABS.filter((tabDef) => tabDef.id !== 'browser' || embeddedBrowserAvailable()).map((tabDef) => {
          const Icon = tabDef.icon
          const active = tab === tabDef.id
          return (
            <button
              key={tabDef.id}
              role="tab"
              aria-selected={active}
              data-active={active}
              onClick={() => setTab(tabDef.id)}
              className={cn('inline-flex shrink-0 items-center gap-1.5', active && 'border-primary')}
              title={t(tabDef.labelKey)}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="rp-tab-label">{t(tabDef.labelKey)}</span>
            </button>
          )
        })}
        {artifact && (
          <button
            role="tab"
            aria-selected={tab === 'artifact'}
            data-active={tab === 'artifact'}
            onClick={() => setTab('artifact')}
            className={cn('inline-flex shrink-0 items-center gap-1.5', tab === 'artifact' && 'border-primary')}
            title={artifact.title}
          >
            <FileText className="h-3.5 w-3.5" />
            <span className="rp-tab-label max-w-[7rem] truncate">{artifact.title}</span>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'review' && <DiffReview />}
        {tab === 'usage' && <UsageCostPanel />}
        {tab === 'goal' && <GoalPanel />}
        {tab === 'worktree' && <WorktreePanel />}
        {tab === 'files' && <FilesPanel />}
        {tab === 'flow' && <FlowRunPanel />}
        {tab === 'session_log' && <SessionLogTab />}
        {tab === 'terminal' && <TerminalPanel />}
        {tab === 'logs' && <LogsPanel />}
        {tab === 'artifact' && <ArtifactView />}
        <div className={cn('h-full min-h-0', tab !== 'browser' && 'hidden')}>
          {embeddedBrowserAvailable() && <BrowserPanel active={tab === 'browser' && !settingsOpen} />}
        </div>
      </div>
    </aside>
  )
}
