/**
 * Settings Dialog — 左侧分类列表 + 右侧表单的现代留白布局.
 *
 * Each category owns one page. Workspace & data is intentionally the only
 * composite page because its project, memory, and local-data controls are
 * closely related. Keeping every other panel on its own page avoids the
 * previous long stack of unrelated cards and repeated headings.
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Puzzle,
  Info,
  Bot,
  User,
  MessageSquare,
  Volume2,
  Shield,
  Palette,
  LayoutGrid,
  Plug,
  Timer,
  FolderOpen,
  ArrowLeft,
  Loader2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { GlassSelect } from '@/components/ui/glass-select'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { useAppStore, type SettingsCategory } from '@/store/app'

type CategoryId = SettingsCategory

const ModelPanel = lazy(() => import('./panels/ModelPanel').then((module) => ({ default: module.ModelPanel })))
const CharacterPanel = lazy(() => import('./panels/CharacterPanel').then((module) => ({ default: module.CharacterPanel })))
const ChatPanel = lazy(() => import('./panels/ChatPanel').then((module) => ({ default: module.ChatPanel })))
const TtsPanel = lazy(() => import('./panels/TtsPanel').then((module) => ({ default: module.TtsPanel })))
const MemoryPanel = lazy(() => import('./panels/MemoryPanel').then((module) => ({ default: module.MemoryPanel })))
const ToolsPanel = lazy(() => import('./panels/ToolsPanel').then((module) => ({ default: module.ToolsPanel })))
const AppearancePanel = lazy(() => import('./panels/AppearancePanel').then((module) => ({ default: module.AppearancePanel })))
const TrayPanel = lazy(() => import('./panels/TrayPanel').then((module) => ({ default: module.TrayPanel })))
const McpPanel = lazy(() => import('./panels/McpPanel').then((module) => ({ default: module.McpPanel })))
const AdvancedPanel = lazy(() => import('./panels/AdvancedPanel').then((module) => ({ default: module.AdvancedPanel })))
const AboutPanel = lazy(() => import('./panels/AboutPanel').then((module) => ({ default: module.AboutPanel })))
const ProjectsPanel = lazy(() => import('./panels/ProjectsPanel').then((module) => ({ default: module.ProjectsPanel })))
const SkillsPanel = lazy(() => import('./panels/SkillsPanel').then((module) => ({ default: module.SkillsPanel })))
const AutomationsPanel = lazy(() => import('./panels/AutomationsPanel').then((module) => ({ default: module.AutomationsPanel })))
const WeChatPanel = lazy(() => import('./panels/WeChatPanel').then((module) => ({ default: module.WeChatPanel })))

interface Category {
  id: CategoryId
  labelKey: MessageKey
  descKey: MessageKey
  icon: typeof Bot
}

const CATEGORIES: Category[] = [
  { id: 'general', labelKey: 'chat', descKey: 'chatDesc', icon: MessageSquare },
  { id: 'character', labelKey: 'character', descKey: 'characterDesc', icon: User },
  { id: 'voice', labelKey: 'voice', descKey: 'voiceDesc', icon: Volume2 },
  { id: 'models', labelKey: 'settingsModels', descKey: 'modelDesc', icon: Bot },
  { id: 'workspace-data', labelKey: 'settingsWorkspaceData', descKey: 'projectsDesc', icon: FolderOpen },
  { id: 'tools', labelKey: 'tools', descKey: 'toolsDesc', icon: Shield },
  { id: 'automations', labelKey: 'automations', descKey: 'automationsDesc', icon: Timer },
  { id: 'skills', labelKey: 'skills', descKey: 'skillsDesc', icon: Puzzle },
  { id: 'mcp', labelKey: 'mcp', descKey: 'mcpDesc', icon: Plug },
  { id: 'wechat', labelKey: 'wechat', descKey: 'wechatDesc', icon: MessageSquare },
  { id: 'appearance', labelKey: 'appearance', descKey: 'appearanceDesc', icon: Palette },
  { id: 'tray', labelKey: 'tray', descKey: 'trayDesc', icon: LayoutGrid },
  { id: 'about', labelKey: 'about', descKey: 'aboutDesc', icon: Info },
]

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function SettingsPanelLoading({ locale }: { locale: string }) {
  return (
    <div className="flex min-h-[20rem] items-center justify-center" role="status" aria-busy="true">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">{locale === 'zh-CN' ? '正在加载' : 'Loading'}</span>
    </div>
  )
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t, locale } = useI18n()
  const initialCategory = useAppStore((state) => state.settingsInitialCategory)
  const [active, setActive] = useState<CategoryId>(initialCategory)
  useEffect(() => {
    if (open) setActive(initialCategory)
  }, [initialCategory, open])
  const categoryGroups = [
    {
      label: { zh: '常用', en: 'General' },
      ids: ['general', 'appearance'] as CategoryId[],
    },
    {
      label: { zh: '个性化', en: 'Personalization' },
      ids: ['character', 'voice'] as CategoryId[],
    },
    {
      label: { zh: '工作区', en: 'Workspace' },
      ids: ['workspace-data', 'models'] as CategoryId[],
    },
    {
      label: { zh: '工具与服务', en: 'Tools & services' },
      ids: ['tools', 'automations', 'skills', 'mcp', 'wechat'] as CategoryId[],
    },
    {
      label: { zh: '系统', en: 'System' },
      ids: ['tray', 'about'] as CategoryId[],
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        fullscreen
        // Owns the whole viewport on desktop AND mobile (Electron behaviour):
        // `fullscreen` applies inline geometry that no stylesheet can shift,
        // so the panel can never drift to a corner again.
        className="settings-dialog-content flex flex-col gap-0 overflow-hidden border-border/80 bg-card shadow-none"
      >
        <DialogHeader className="settings-dialog-header shrink-0 border-b border-border/70 bg-card px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="settings-dialog-back inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
              onClick={() => onOpenChange(false)}
              aria-label={t('backToChat')}
              title={t('backToChat')}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="settings-dialog-heading min-w-0">
              <DialogTitle>{t('settings')}</DialogTitle>
              <DialogDescription>
                {locale === 'zh-CN' ? '偏好设置与工作区选项' : 'Preferences and workspace options'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <label className="settings-dialog-mobile-picker">
          <span>{t('settingsCategory')}</span>
          <GlassSelect
            value={active}
            onChange={(value) => setActive(value as CategoryId)}
            ariaLabel={t('settingsCategory')}
            options={CATEGORIES.map((category) => ({ value: category.id, label: t(category.labelKey) }))}
          />
        </label>

        {/* Main area: left nav + right panel, flex-1 so it fills available
            space between header and footer. min-h-0 is critical — without
            it, flex children won't shrink below their content's natural
            height, causing overflow into the footer (Issue 4). */}
        <div className="settings-dialog-body flex min-h-0 flex-1">
          {/* Left: categories */}
          <nav
            className="settings-dialog-nav shrink-0 overflow-y-auto border-r border-border/70 bg-muted/35 p-2"
            aria-label={t('settingsCategory')}
          >
            {categoryGroups.map((group) => (
              <section className="settings-nav-group" key={group.label.en}>
                <h2 className="settings-nav-group-title">
                  {locale === 'zh-CN' ? group.label.zh : group.label.en}
                </h2>
                <ul>
                  {group.ids.map((id) => {
                    const c = CATEGORIES.find((category) => category.id === id)!
                    const Icon = c.icon
                    const isActive = c.id === active
                    return (
                      <li key={c.id}>
                        <button
                          onClick={() => setActive(c.id)}
                          className={cn(
                            'settings-nav-item flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-150',
                            isActive ? 'font-medium' : 'text-foreground/80',
                          )}
                          aria-current={isActive ? 'page' : undefined}
                        >
                          <Icon
                            className={cn(
                              'h-4 w-4 shrink-0',
                              isActive ? 'text-primary' : 'text-muted-foreground',
                            )}
                          />
                          <span className="truncate">{t(c.labelKey)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </nav>

          {/* Right: panel — flex-1 + min-h-0 so it shrinks; ScrollArea
              with h-full so it actually scrolls when content overflows. */}
          <div
            className={cn(
              'settings-dialog-panel min-h-0 flex-1 overflow-hidden',
              active === 'models' && 'settings-dialog-model-panel',
            )}
          >
            <ScrollArea type="always" className="settings-content-scroll-area h-full">
              <div className="p-6">
                <Suspense fallback={<SettingsPanelLoading locale={locale} />}>
                  {active === 'general' && <div className="settings-page settings-page-single"><ChatPanel /></div>}
                  {active === 'character' && <div className="settings-page settings-page-single"><CharacterPanel /></div>}
                  {active === 'voice' && <div className="settings-page settings-page-single"><TtsPanel /></div>}
                  {active === 'models' && <div className="settings-page settings-page-models"><ModelPanel /></div>}
                  {active === 'workspace-data' && <div className="settings-group-stack"><ProjectsPanel /><MemoryPanel /><AdvancedPanel /></div>}
                  {active === 'tools' && <div className="settings-page settings-page-single"><ToolsPanel /></div>}
                  {active === 'automations' && <div className="settings-page settings-page-single"><AutomationsPanel /></div>}
                  {active === 'skills' && <div className="settings-page settings-page-single"><SkillsPanel /></div>}
                  {active === 'mcp' && <div className="settings-page settings-page-single"><McpPanel /></div>}
                  {active === 'wechat' && <div className="settings-page settings-page-single"><WeChatPanel /></div>}
                  {active === 'appearance' && <div className="settings-page settings-page-single"><AppearancePanel /></div>}
                  {active === 'tray' && <div className="settings-page settings-page-single"><TrayPanel /></div>}
                  {active === 'about' && <div className="settings-page settings-page-single"><AboutPanel /></div>}
                </Suspense>
              </div>
            </ScrollArea>
          </div>
        </div>

      </DialogContent>
    </Dialog>
  )
}
