import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeEvent, ClipboardEvent, CSSProperties, DragEvent, KeyboardEvent } from 'react'
import {
  ArrowUp,
  Puzzle,
  AtSign,
  ArrowLeft,
  Bot,
  GitCompareArrows,
  MessageSquarePlus,
  ScrollText,
  Settings,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Code2,
  FileText,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Loader2,
  Mic,
  MoreHorizontal,
  Paperclip,
  PhoneCall,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Eye,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { apiClient } from '@/api/client'
import { confirmProjectAccess, pickProjectFolder } from '@/api/tauriBridge'
import type { AgentMode, PermissionMode, ProviderInfo, ProviderModel, TaskProgressAttachment, ThreadGoal } from '@/api/types'
import {
  getReasoningEffortMeta,
} from '@/lib/agentModes'
import { PHONE_VIEWPORT_QUERY } from '@/lib/responsive'
import { cn, displayPath, generateId } from '@/lib/utils'
import { IS_ANDROID } from '@/lib/platform'
import { AndroidModelGlass, LIQUID_GLASS_CLASS } from './AndroidModelGlass'
import type { ConversationState } from '@/lib/voiceConversation'
import { useAppStore } from '@/store/app'
import { useProjectsStore } from '@/store/projects'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { LongRunningTaskVisual } from './LongRunningTaskVisual'
import { ContextUsageMeter } from './ContextUsageMeter'
import { useToast } from '@/components/ui/toast'
import { ProviderLogo } from '@/components/ui/provider-logo'
import { LiquidGlassSurface } from '@/components/ui/liquid-glass-surface'
import { isProviderConfigured, getHiddenProviders } from '@/lib/providerState'
import { ProjectSourceDialog } from '@/components/projects/ProjectSourceDialog'
import { RemoteProjectWizard } from '@/components/settings/panels/RemoteProjectWizard'
import { useI18n } from '@/lib/i18n'

interface Attachment {
  id: string
  file: File
  name: string
  size: number
  type: string
  kind: 'image' | 'file'
  previewUrl?: string
}

interface ComposerProps {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  disabled?: boolean
  placeholder?: string
  /** External value override, used by rewind to refill the composer. */
  draftValue?: string
  /** Called when the external draftValue has been consumed. */
  onDraftConsumed?: () => void
  /** Current session id, used to keep per-session input drafts. */
  sessionId?: string
  pendingQueue?: QueuedComposerMessage[]
  onRemoveQueued?: (id: string) => void
  taskProgress?: TaskProgressAttachment
  isVoiceCallActive?: boolean
  voiceCallLoading?: boolean
  voiceAudioLevel?: number
  onToggleVoiceCall?: () => void
  conversationState?: ConversationState
  goal?: ThreadGoal | null
  longRunningArmed?: boolean
  onToggleLongRunning?: () => void
  onGoalAction?: (action: 'pause' | 'resume' | 'complete' | 'block') => Promise<void>
}

interface MentionItem {
  label: string
  insert: string
  hint: string
  icon: LucideIcon
}

export interface QueuedComposerMessage {
  id: string
  text: string
  createdAt: number
}

type MobileSettingsSection = 'root' | 'project' | 'model' | 'reasoning' | 'permission'

const MOBILE_SETTINGS_LABELS: Record<Exclude<MobileSettingsSection, 'root'>, string> = {
  project: '项目',
  model: '模型',
  reasoning: '思考强度',
  permission: '权限',
}

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  svg: 'xml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gradle: 'gradle',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  pm: 'perl',
  scala: 'scala',
  clj: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  ml: 'ocaml',
  fs: 'fsharp',
  ps1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  log: 'text',
  csv: 'text',
  env: 'ini',
  gitattributes: 'text',
  editorconfig: 'ini',
}

const PERMISSION_META: Partial<
  Record<PermissionMode, { label: string; hint: string; icon: LucideIcon; tone: string }>
> = {
  read_only: {
    label: '只读',
    hint: '仅允许读取类工具',
    icon: Eye,
    tone: 'text-sky-500',
  },
  auto: {
    label: '自动',
    hint: 'Run safe tools directly',
    icon: ShieldCheck,
    tone: 'text-emerald-500',
  },
  granular: {
    label: '规则',
    hint: '按细粒度规则放行',
    icon: SlidersHorizontal,
    tone: 'text-violet-500',
  },
  guardian: {
    label: '守卫',
    hint: '危险操作逐项审批',
    icon: Sparkles,
    tone: 'text-amber-500',
  },
  full_access: {
    label: '完全',
    hint: '跳过所有权限检查',
    icon: ShieldOff,
    tone: 'text-red-500',
  },
  ask: {
    label: '询问',
    hint: "危险操作前确认",
    icon: ShieldAlert,
    tone: 'text-amber-500',
  },
  bypass: {
    label: '跳过',
    hint: "跳过所有权限检查",
    icon: ShieldOff,
    tone: 'text-red-500',
  },
}

const BASE_MENTION_ITEMS: MentionItem[] = [
  { label: "当前会话", insert: "@current-session", hint: "引用本轮上下文", icon: Clipboard },
  { label: "工作区", insert: "@workspace", hint: "引用项目结构", icon: FolderOpen },
  { label: 'Selection', insert: '@selection', hint: 'Use the current selection', icon: Clipboard },
  { label: "最近变更", insert: "@changes", hint: "引用 Git diff", icon: Code2 },
  { label: 'Terminal', insert: '@terminal', hint: 'Use recent terminal output', icon: Terminal },
]

/**
 * Slash commands — typed as the very first thing in the input
 * ("/rev…" filters). Pure UI actions: they never reach the model.
 */
function slashQueryFrom(value: string): string | null {
  const m = value.match(/^\/([a-z0-9-]*)$/i)
  return m ? m[1].toLowerCase() : null
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getLanguage(filename: string): string | null {
  const lower = filename.toLowerCase()
  const base = lower.split('/').pop() || lower
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  const ext = base.split('.').pop() || ''
  return TEXT_EXTENSIONS[ext] || null
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (
    file.type === 'application/json' ||
    file.type === 'application/xml' ||
    file.type === 'application/javascript' ||
    file.type === 'application/x-yaml' ||
    file.type === 'application/x-sh'
  ) {
    return true
  }
  if (file.type === '' || file.type === 'application/octet-stream') {
    return getLanguage(file.name) !== null
  }
  return false
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function imageNameFromType(type: string): string {
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return `pasted-image-${stamp}.${ext}`
}

function isMultimodalProvider(provider: ProviderInfo | undefined, modelText: string | undefined): boolean {
  const haystack = `${provider?.id || ''} ${provider?.display_name || ''} ${provider?.model_name || ''} ${modelText || ''}`.toLowerCase()
  if (!haystack.trim()) return false
  return [
    /gpt-4o/,
    /gpt-4\.1/,
    /gpt-5/,
    /\bo3\b/,
    /\bo4\b/,
    /vision/,
    /visual/,
    /qwen[-_ ]?vl/,
    /\bvl\b/,
    /glm[-_ ]?4v/,
    /deepseek[-_ ]?vl/,
    /gemini/,
    /claude[-_ ]?3/,
    /claude.*sonnet/,
    /claude.*opus/,
    /claude.*haiku/,
    /doubao.*vision/,
  ].some((pattern) => pattern.test(haystack))
}

function mentionQueryFrom(value: string, cursor: number): { start: number; query: string } | null {
  const before = value.slice(0, cursor)
  const match = before.match(/(^|\s)@([^\s@]*)$/)
  if (!match) return null
  return {
    start: cursor - match[2].length - 1,
    query: match[2].toLowerCase(),
  }
}

export function Composer({
  onSend,
  onStop,
  isStreaming,
  disabled,
  placeholder,
  draftValue,
  onDraftConsumed,
  sessionId,
  pendingQueue = [],
  onRemoveQueued,
  taskProgress,
  isVoiceCallActive = false,
  voiceCallLoading = false,
  voiceAudioLevel = 0,
  onToggleVoiceCall,
  conversationState = 'idle',
  goal = null,
  longRunningArmed = false,
  onToggleLongRunning,
  onGoalAction,
}: ComposerProps) {
  const toast = useToast()
  const { t, locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const permissionLabel = (mode: PermissionMode) => mode === 'read_only'
    ? copy('只读', 'Read only')
    : mode === 'auto'
      ? copy('自动', 'Auto')
      : mode === 'granular'
        ? copy('规则', 'Granular')
        : mode === 'guardian'
          ? copy('守卫', 'Guardian')
          : mode === 'ask'
            ? copy('询问', 'Ask')
            : copy('跳过', 'Bypass')
  const reasoningLabel = (effort: string) => effort === 'auto'
    ? copy('自动', 'Auto')
    : getReasoningEffortMeta(effort).label
  const reasoningDescription = (effort: string) => {
    const meta = getReasoningEffortMeta(effort)
    if (locale === 'zh-CN') return meta.description
    const descriptions: Record<string, string> = {
      auto: 'Use the model and provider default strategy',
      off: 'Disable reasoning when supported by the model',
      low: 'Provider-native low effort',
      medium: 'Provider-native medium effort',
      high: 'Provider-native high effort',
      xhigh: 'Provider-native xhigh effort',
      max: 'Provider-native maximum effort',
    }
    return descriptions[effort] || `Provider-native ${effort} effort`
  }
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionItems, setMentionItems] = useState<MentionItem[]>(BASE_MENTION_ITEMS)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [isPhoneViewport, setIsPhoneViewport] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [permission, setPermission] = useState<PermissionMode>('ask')
  const [availablePermissions, setAvailablePermissions] = useState<PermissionMode[]>(
    apiClient.usesEmbeddedRuntime ? ['auto', 'ask', 'bypass'] : ['read_only', 'auto', 'granular', 'guardian', 'full_access'],
  )
  const [permissionLoading, setPermissionLoading] = useState(false)
  const [switchingProvider, setSwitchingProvider] = useState(false)
  // Model picker (provider → collapsible model list). Models are fetched
  // lazily per provider the first time the user expands it, and cached so
  // re-opening the dropdown is instant. keyed by provider id.
  const [modelsCache, setModelsCache] = useState<Record<string, ProviderModel[]>>({})
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const mentionPosRef = useRef<number>(-1)
  const composingRef = useRef(false)
  const prevSessionIdRef = useRef<string | undefined>(undefined)
  const attachmentsRef = useRef<Attachment[]>([])
  const mentionCacheRef = useRef<{ projectId: string | null; loadedAt: number; items: MentionItem[] } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const phoneQuery = window.matchMedia(PHONE_VIEWPORT_QUERY)
    const syncViewport = () => setIsPhoneViewport(phoneQuery.matches)
    syncViewport()
    phoneQuery.addEventListener?.('change', syncViewport)
    return () => phoneQuery.removeEventListener?.('change', syncViewport)
  }, [])

  const sendOnEnter = useSettingsStore((s) => s.sendOnEnter)
  const providers = useSettingsStore((s) => s.providers)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const providersLoading = useSettingsStore((s) => s.providersLoading)
  const loadProviders = useSettingsStore((s) => s.loadProviders)
  const refreshServerInfo = useAppStore((s) => s.refreshServerInfo)
  const model = useAppStore((s) => s.model)
  const agentMode = useAppStore((s) => s.agentMode)
  const setAgentMode = useAppStore((s) => s.setAgentMode)
  const reasoningEfforts = useAppStore((s) => s.reasoningEfforts)
  const setReasoningEffort = useAppStore((s) => s.setReasoningEffort)
  const getReasoningEffort = useAppStore((s) => s.getReasoningEffort)

  // Projects store — project picker
  const projects = useProjectsStore((s) => s.projects)
  const activeProject = useProjectsStore((s) => s.activeProject)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const setActiveProject = useProjectsStore((s) => s.setActive)
  const createProject = useProjectsStore((s) => s.create)
  const removeProject = useProjectsStore((s) => s.remove)
  // Lock project switching once the current session has any messages.
  // The agent's context (cwd, file scope, fleet sub_dirs) is bound to
  // the project at turn-start; switching mid-conversation would silently
  // desync the backend's working directory from what the user sees.
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessionMessages = useSessionStore((s) =>
    s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
  )
  const projectLocked = !!activeSessionId && (sessionMessages?.length ?? 0) > 0
  const [projectSearch, setProjectSearch] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [projectSourceOpen, setProjectSourceOpen] = useState(false)
  const [remoteWizardOpen, setRemoteWizardOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)
  // Android: the liquid-glass model picker opens from the top-bar title island.
  const [androidModelGlassOpen, setAndroidModelGlassOpen] = useState(false)
  // Android: the collapsed brain button expands into the reasoning slider.
  const [androidReasoningOpen, setAndroidReasoningOpen] = useState(false)
  useEffect(() => {
    if (!IS_ANDROID) return
    const open = () => setAndroidModelGlassOpen(true)
    window.addEventListener('hakus:android-model-picker', open)
    return () => window.removeEventListener('hakus:android-model-picker', open)
  }, [])
  useEffect(() => {
    if (!androidReasoningOpen) return
    const close = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return
      if (e.target.closest('[role="slider"]') || e.target.closest('[aria-label="思考强度"]')) return
      setAndroidReasoningOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [androidReasoningOpen])
  const [mobileSettingsSection, setMobileSettingsSection] = useState<MobileSettingsSection>('root')
  const [mobileModelProviderId, setMobileModelProviderId] = useState<string | null>(null)
  const [goalDialogOpen, setGoalDialogOpen] = useState(false)
  const [goalActionLoading, setGoalActionLoading] = useState(false)

  const currentProvider = useMemo(
    () => {
      // 必须与 usableProviders 使用同一套过滤规则：已"删除"的 provider
      // （内置目录被重置后进入 hidden 列表）即使仍带默认/密钥标记，
      // 也不能再作为当前模型展示。
      const hidden = new Set(getHiddenProviders())
      const configured = providers.filter((p) => !hidden.has(p.id) && isProviderConfigured(p))
      return configured.find((p) => p.is_default) || configured.find((p) => p.id === defaultModel)
    },
    [defaultModel, providers],
  )
  // The app store can briefly retain a model from a previous session while
  // the Rust provider catalog is loading (or after the user cleared data).
  // Never use that stale value to advertise capabilities when no configured
  // provider exists. Explicitly configured models remain the source of truth.
  const modelText = currentProvider
    ? (currentProvider.configured_models?.find((entry) => Boolean(entry?.trim())) || undefined)
    : undefined
  const canUseImages = Boolean(modelText) && isMultimodalProvider(currentProvider, modelText)
  const storedReasoningEffort = getReasoningEffort(agentMode)
  const activeReasoningOptions = useMemo(() => {
    const modelId = currentProvider?.model_name || model?.model_name
    const entries = currentProvider ? modelsCache[currentProvider.id] : undefined
    const selected = entries?.find((entry) => entry.id === modelId)
    const values = (selected?.reasoning_options || [])
      .filter((option) => !option.type || option.type.toLowerCase() === 'effort')
      .flatMap((option) => option.values || [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
    if (values.length > 0) {
      return ['auto', ...Array.from(new Set(values.filter((value) => value !== 'auto')))]
    }
    // Catalog miss fallback: proxy/aggregator models (e.g. gpt-5.6-luna on a
    // custom gateway) are absent from models.dev, so the bundled catalog has
    // no ladder even when the model supports reasoning. Offer the standard
    // OpenAI-compatible effort ladder instead of collapsing to "自动" only.
    if (selected?.supports_reasoning === true) {
      return ['auto', 'low', 'medium', 'high']
    }
    return ['auto']
  }, [currentProvider, model, modelsCache])
  const activeReasoningEffort = activeReasoningOptions.includes(storedReasoningEffort)
    ? storedReasoningEffort
    : 'auto'

  // Context-window usage: the latest assistant turn's input tokens against the
  // selected model's context_window. The ring lives next to the model picker.
  const selectedModelMeta = useMemo(() => {
    const modelId = currentProvider?.model_name || model?.model_name
    const entries = currentProvider ? modelsCache[currentProvider.id] : undefined
    return entries?.find((entry) => entry.id === modelId)
  }, [currentProvider, model, modelsCache])
  // Prefer the catalog value for the selected model; fall back to the
  // user-supplied per-route size. Aggregator/self-hosted routes are absent
  // from the built-in catalog, so without that fallback the ring can only
  // ever say "unknown" for them.
  const contextWindow = selectedModelMeta?.context_window ?? currentProvider?.context_window ?? null
  const contextUsed = useMemo(() => {
    const messages = sessionMessages || []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && typeof m.input_tokens === 'number' && m.input_tokens > 0) {
        return m.input_tokens
      }
    }
    return 0
  }, [sessionMessages])
  const goalStatusLabel = goal?.status === 'active'
    ? copy('进行中', 'Active')
    : goal?.status === 'paused'
      ? copy('已暂停', 'Paused')
      : goal?.status === 'blocked'
        ? copy('需处理', 'Needs attention')
        : goal?.status === 'usage_limited' || goal?.status === 'budget_limited'
          ? copy('需处理', 'Needs attention')
        : goal?.status === 'complete'
          ? copy('已完成', 'Complete')
          : ''
  const goalHasControls = !!goal && goal.status !== 'complete'
  const goalButtonLabel = goalHasControls
    ? `${copy('长程', 'Long-run')} · ${goalStatusLabel}`
    : goal?.status === 'complete'
      ? `${copy('长程', 'Long-run')} · ${copy('已完成', 'Complete')}`
      : copy('长程任务', 'Long-running task')
  const currentProviderLabel = currentProvider
    ? `${currentProvider.display_name}/${currentProvider.model_name || currentProvider.display_name}`
    : copy('未配置模型', 'No model configured')

  // Only providers the user actually set up (key saved, models chosen, or
  // currently default) belong in the pickers — the raw vendor catalog with
  // its dozens of untouched entries is noise.
  const usableProviders = useMemo(() => {
    const hidden = new Set(getHiddenProviders())
    return providers.filter((provider) => !hidden.has(provider.id) && isProviderConfigured(provider))
  }, [providers])

  const orderedProviderGroups = useMemo(() => {
    const preferred = ['国内服务', '国际服务', '聚合 / 中转', '本地 / 自托管', '自定义模型商', '自定义', '其他']
    const grouped = new Map<string, ProviderInfo[]>()
    usableProviders.forEach((provider) => {
      const group = provider.group || '其他'
      if (!grouped.has(group)) grouped.set(group, [])
      grouped.get(group)!.push(provider)
    })
    const order = [...preferred, ...Array.from(grouped.keys())]
      .filter((group, index, all) => all.indexOf(group) === index)
    return order.filter((group) => grouped.has(group)).map((group) => ({ group, items: grouped.get(group)! }))
  }, [usableProviders])
  const mobileModelProvider = mobileModelProviderId
    ? usableProviders.find((provider) => provider.id === mobileModelProviderId)
    : undefined
  const mobileModelOptions = mobileModelProviderId ? modelsCache[mobileModelProviderId] : undefined
  // Backend data (or a half-working mock) can yield a mode outside the
  // registry — fall back instead of white-screening the whole composer.
  const activePermissionMeta = PERMISSION_META[permission] ?? PERMISSION_META.ask
  const ActivePermissionIcon = activePermissionMeta.icon

  const filteredMentionItems = useMemo(() => {
    if (!mentionQuery) return mentionItems
    return mentionItems.filter((item) => {
      const text = `${item.label} ${item.insert} ${item.hint}`.toLowerCase()
      return text.includes(mentionQuery)
    })
  }, [mentionItems, mentionQuery])

  const slashCommands = useMemo(() => [
    { name: 'new', label: copy('新会话', 'New chat'), hint: copy('开始一个新的对话', 'Start a new chat'), icon: MessageSquarePlus, action: 'new' as const },
    { name: 'clear', label: copy('清空对话', 'Clear chat'), hint: copy('清空当前对话的所有消息', 'Clear all messages in this chat'), icon: Trash2, action: 'clear' as const },
    { name: 'review', label: copy('审阅', 'Review'), hint: copy('在右侧栏打开 Diff 审阅', 'Open diff review in the side panel'), icon: GitCompareArrows, action: 'review' as const },
    { name: 'terminal', label: copy('终端', 'Terminal'), hint: copy('在右侧栏打开终端', 'Open the terminal panel'), icon: Terminal, action: 'terminal' as const },
    { name: 'logs', label: copy('日志', 'Logs'), hint: copy('在右侧栏打开日志', 'Open the log viewer'), icon: ScrollText, action: 'logs' as const },
    { name: 'settings', label: copy('设置', 'Settings'), hint: copy('打开设置', 'Open settings'), icon: Settings, action: 'settings' as const },
  ], [locale]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredSlashCommands = useMemo(() => {
    if (!slashQuery) return slashCommands
    return slashCommands.filter((cmd) =>
      `${cmd.name} ${cmd.label} ${cmd.hint}`.toLowerCase().includes(slashQuery),
    )
  }, [slashCommands, slashQuery])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((att) => {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
      })
    }
  }, [])

  useEffect(() => {
    if (providers.length === 0 && !providersLoading) {
      void loadProviders()
    }
  }, [providers.length, providersLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    const loadPermission = async () => {
      setPermissionLoading(true)
      try {
        const info = await apiClient.getPermission()
        if (cancelled) return
        if (info.mode && PERMISSION_META[info.mode as PermissionMode]) setPermission(info.mode)
        const modes = info.available_modes.filter((mode): mode is PermissionMode =>
          mode === 'auto' || mode === 'ask' || mode === 'bypass',
        )
        if (modes.length > 0) setAvailablePermissions(modes)
      } catch {
        // Keep the local default if the backend is still starting.
      } finally {
        if (!cancelled) setPermissionLoading(false)
      }
    }
    void loadPermission()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (draftValue !== undefined) {
      setValue(draftValue)
      onDraftConsumed?.()
      setTimeout(() => taRef.current?.focus(), 0)
    }
  }, [draftValue]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId) return
    const prevId = prevSessionIdRef.current
    if (prevId && prevId !== sessionId) {
      setDrafts((d) => ({ ...d, [prevId]: value }))
    }
    prevSessionIdRef.current = sessionId
    setValue(drafts[sessionId] || '')
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const nextHeight = Math.min(ta.scrollHeight, 176)
    ta.style.height = `${nextHeight}px`
    ta.style.overflowY = ta.scrollHeight > 176 ? 'auto' : 'hidden'
  }, [value])

  useEffect(() => {
    if (!isStreaming) {
      setElapsed(0)
      return
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [isStreaming])

  useEffect(() => {
    if (!mentionOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMentionOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [mentionOpen])

  const saveDraft = (sid: string | undefined, text: string) => {
    if (!sid) return
    setDrafts((d) => ({ ...d, [sid]: text }))
  }

  const loadMentionItems = useCallback(async () => {
    const cached = mentionCacheRef.current
    if (
      cached &&
      cached.projectId === activeProjectId &&
      Date.now() - cached.loadedAt < 15_000
    ) {
      setMentionItems(cached.items)
      return
    }

    setMentionItems(BASE_MENTION_ITEMS)
    setMentionLoading(true)
    try {
      const [filesResult, skillsResult] = await Promise.allSettled([
        apiClient.listFiles(),
        apiClient.listSkills(activeProjectId || undefined),
      ])
      const files = filesResult.status === 'fulfilled' ? filesResult.value : []
      const fileItems: MentionItem[] = files.map((file) => ({
        label: file.filename,
        insert: `@file:${file.filename}`,
        hint: `${formatSize(file.size)} · ${file.is_text ? 'text' : 'file'}`,
        icon: file.content_type?.startsWith('image/') ? ImageIcon : FileText,
      }))
      const skills = skillsResult.status === 'fulfilled' ? skillsResult.value.skills : []
      const skillItems: MentionItem[] = skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          label: skill.name,
          insert: `@skill:${skill.name}`,
          hint: `Skill · ${skill.description}`,
          icon: Puzzle,
        }))
      const items = [...BASE_MENTION_ITEMS, ...skillItems, ...fileItems]
      mentionCacheRef.current = { projectId: activeProjectId, loadedAt: Date.now(), items }
      setMentionItems(items)
    } catch {
      setMentionItems(BASE_MENTION_ITEMS)
    } finally {
      setMentionLoading(false)
    }
  }, [activeProjectId])

  const updateMentionState = (nextValue: string, cursor: number) => {
    const mention = mentionQueryFrom(nextValue, cursor)
    if (!mention) {
      setMentionOpen(false)
      return
    }
    mentionPosRef.current = mention.start
    setMentionQuery(mention.query)
    setMentionIndex(0)
    setMentionOpen(true)
    void loadMentionItems()
  }

  const revokeAttachment = (att: Attachment) => {
    if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
  }

  const clearAttachments = () => {
    setAttachments((prev) => {
      prev.forEach(revokeAttachment)
      return []
    })
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((att) => att.id === id)
      if (target) revokeAttachment(target)
      return prev.filter((att) => att.id !== id)
    })
  }

  const addAttachments = (files: File[]) => {
    if (files.length === 0) return
    const accepted: Attachment[] = []
    let blockedImages = 0

    for (const file of files) {
      const image = isImageFile(file)
      if (image && !canUseImages) {
        blockedImages += 1
        continue
      }
      accepted.push({
        id: generateId('att_'),
        file,
        name: file.name,
        size: file.size,
        type: file.type,
        kind: image ? 'image' : 'file',
        previewUrl: image ? URL.createObjectURL(file) : undefined,
      })
    }

    if (blockedImages > 0) {
      toast.info("Images were skipped because the current model is not multimodal")
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted])
    }
  }

  const submit = async () => {
    const trimmed = value.trim()
    if ((!trimmed && attachments.length === 0) || disabled || uploading) return

    // A bare "/cmd" is a slash command, not a prompt — run it and return.
    const bareCommand = slashQueryFrom(trimmed)
    if (bareCommand !== null) {
      const cmd = slashCommands.find((c) => c.name === bareCommand)
      if (cmd) {
        executeSlash(cmd)
        return
      }
    }

    let finalText = trimmed

    if (attachments.length > 0) {
      setUploading(true)
      try {
        const uploaded = await apiClient.uploadFiles(attachments.map((att) => att.file))
        const names = uploaded.map((file) => file.filename).join(', ')
        const previews: Array<string | Promise<string>> = []

        attachments.forEach((att, index) => {
          const uploadedFile = uploaded[index]
          if (att.kind === 'image' && uploadedFile) {
            previews.push(
              `[Image: ${uploadedFile.filename}]\n` +
                `file_id: ${uploadedFile.file_id}\n` +
                `content_type: ${uploadedFile.content_type || att.type || 'image'}\n` +
                `[/Image]\n\n`,
            )
            return
          }

          if (isTextFile(att.file) && att.file.size < 100 * 1024) {
            const lang = getLanguage(att.name) || 'text'
            previews.push(
              att.file
                .text()
                .then((text) => `[File: ${att.name}]\n\`\`\`${lang}\n${text.slice(0, 2000)}\n\`\`\`\n[/File]\n\n`),
            )
          }
        })

        const resolvedPreviews = await Promise.all(previews)
        const prefix = `${resolvedPreviews.join('')}[Attached: ${names}]\n\n`
        finalText = prefix + trimmed
      } catch (e: any) {
        toast.error(`附件上传失败：${e?.message || e}`)
      } finally {
        setUploading(false)
      }
    }

    if (!finalText.trim()) return
    onSend(finalText)
    setValue('')
    clearAttachments()
    if (sessionId) {
      setDrafts((d) => {
        const next = { ...d }
        delete next[sessionId]
        return next
      })
    }
  }

  const insertMention = (item: MentionItem) => {
    const ta = taRef.current
    if (!ta) return
    const start = mentionPosRef.current
    if (start < 0) return
    const end = ta.selectionStart
    const insertion = `${item.insert} `
    const nextValue = value.slice(0, start) + insertion + value.slice(end)
    setValue(nextValue)
    saveDraft(sessionId, nextValue)
    setMentionOpen(false)
    const nextCursor = start + insertion.length
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const executeSlash = (cmd: (typeof slashCommands)[number]) => {
    setSlashOpen(false)
    setValue('')
    if (sessionId) saveDraft(sessionId, '')
    const app = useAppStore.getState()
    const session = useSessionStore.getState()
    switch (cmd.action) {
      case 'new':
        void session.createSession()
        break
      case 'clear':
        if (session.activeSessionId && confirm(copy('清空当前对话的所有消息？', 'Clear all messages in this chat?'))) {
          session.clearMessages(session.activeSessionId)
        }
        break
      case 'review':
        app.setRightPanelTab('review')
        break
      case 'terminal':
        app.setRightPanelTab('terminal')
        break
      case 'logs':
        app.setRightPanelTab('logs')
        break
      case 'settings':
        app.setSettingsOpen(true)
        break
    }
  }

  const triggerMention = () => {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const needsSpace = start > 0 && !/\s/.test(value[start - 1])
    const insert = `${needsSpace ? ' ' : ''}@`
    const mentionStart = start + (needsSpace ? 1 : 0)
    const nextValue = value.slice(0, start) + insert + value.slice(end)
    setValue(nextValue)
    saveDraft(sessionId, nextValue)
    mentionPosRef.current = mentionStart
    setMentionQuery('')
    setMentionIndex(0)
    setMentionOpen(true)
    void loadMentionItems()
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(mentionStart + 1, mentionStart + 1)
    })
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value
    const cursor = e.target.selectionStart
    setValue(nextValue)
    saveDraft(sessionId, nextValue)
    updateMentionState(nextValue, cursor)
    const query = slashQueryFrom(nextValue)
    if (query !== null) {
      setMentionOpen(false)
      setSlashQuery(query)
      setSlashIndex(0)
      setSlashOpen(true)
    } else {
      setSlashOpen(false)
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || [])
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map((file) => new File([file], file.name || imageNameFromType(file.type), { type: file.type }))

    if (imageFiles.length === 0) return
    e.preventDefault()
    addAttachments(imageFiles)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || composingRef.current) {
      if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
      return
    }

    if (slashOpen && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        executeSlash(filteredSlashCommands[slashIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }

    if (mentionOpen && filteredMentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % filteredMentionItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + filteredMentionItems.length) % filteredMentionItems.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredMentionItems[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionOpen(false)
        return
      }
    }

    if (e.key !== 'Enter') return
    if (sendOnEnter && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (!sendOnEnter && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    addAttachments(Array.from(e.dataTransfer.files))
  }

  const ensureProviderModels = async (providerId: string) => {
    if (modelsCache[providerId]) return
    const provider = providers.find((item) => item.id === providerId)
    // The user's 模型列表 (configured_models) is the source of truth. The
    // live catalog floods the picker with every model the vendor serves —
    // only hit the network when the user hasn't configured anything.
    const configured = (provider?.configured_models || []).filter(Boolean)
    if (configured.length > 0) {
      // Show configured models immediately, then enrich with catalog metadata
      // (context_window, reasoning_options) in the background.
      const baseModels: ProviderModel[] = Array.from(new Set(configured)).map((id) => ({
        id,
        name: id,
        owned_by: null,
      }))
      setModelsCache((prev) => ({ ...prev, [providerId]: baseModels }))
      try {
        const r = await apiClient.listProviderModels(providerId)
        if (r.ok && r.models?.length) {
          const catalogMap = new Map<string, ProviderModel>()
          for (const m of r.models) catalogMap.set(m.id, m)
          setModelsCache((prev) => {
            const existing = prev[providerId]
            if (!existing) return prev
            return {
              ...prev,
              [providerId]: existing.map((m) => {
                const catalog = catalogMap.get(m.id)
                if (!catalog) return m
                return {
                  ...m,
                  context_window: catalog.context_window ?? m.context_window,
                  reasoning_options: catalog.reasoning_options?.length
                    ? catalog.reasoning_options
                    : m.reasoning_options,
                  supports_reasoning: catalog.supports_reasoning ?? m.supports_reasoning,
                }
              }),
            }
          })
        }
      } catch {
        // Catalog fetch failed — keep the plain configured models.
      }
      return
    }
    setModelsLoading(true)
    try {
      const r = await apiClient.listProviderModels(providerId)
      const models = r.ok && r.models?.length
        ? r.models
        : provider?.models?.map((id) => ({ id, name: id, owned_by: null })) || []
      setModelsCache((prev) => ({ ...prev, [providerId]: models }))
      if (!models.length) toast.info('该 provider 未返回任何模型')
    } catch (e: any) {
      toast.error(`获取模型失败：${e?.message || e}`)
    } finally {
      setModelsLoading(false)
    }
  }

  // Load the selected model's authoritative reasoning ladder lazily. Until a
  // model publishes one, the only honest choice is provider-managed `auto`.
  useEffect(() => {
    if (currentProvider?.id && !modelsCache[currentProvider.id]) {
      void ensureProviderModels(currentProvider.id)
    }
  }, [currentProvider?.id])

  useEffect(() => {
    if (storedReasoningEffort !== activeReasoningEffort) {
      setReasoningEffort(agentMode, activeReasoningEffort)
    }
  }, [activeReasoningEffort, agentMode, setReasoningEffort, storedReasoningEffort])

  // Toggle a provider row in the desktop model picker. First expand fetches
  // its model list (cached from then on); collapsing just hides the list.
  const toggleProviderModels = async (providerId: string) => {
    if (expandedProvider === providerId) {
      setExpandedProvider(null)
      return
    }
    setExpandedProvider(providerId)
    await ensureProviderModels(providerId)
  }

  // Pick a specific model. Persists it as that provider's model_name and
  // makes the provider the default, so the composer reads like
  // "provider/model" (the screenshot behavior).
  const handleModelSelect = async (provider: ProviderInfo, modelId: string) => {
    if (isStreaming) return
    if (provider.model_name === modelId && provider.is_default) return
    setSwitchingProvider(true)
    try {
      await apiClient.setDefaultModel(provider.id, modelId)
      await loadProviders()
      await refreshServerInfo()
      toast.success(`Model switched to ${provider.display_name}/${modelId}`)
    } catch (e: any) {
      toast.error(`Model switch failed: ${e?.message || e}`)
    } finally {
      setSwitchingProvider(false)
    }
  }

  const handlePermissionSwitch = async (mode: PermissionMode) => {
    if (mode === permission) return
    const prev = permission
    setPermission(mode)
    setPermissionLoading(true)
    try {
      await apiClient.setPermission(mode)
      toast.success(`${copy('权限已切换为', 'Permission switched to')} ${permissionLabel(mode)}`)
    } catch (e: any) {
      setPermission(prev)
      toast.error(`Permission switch failed: ${e?.message || e}`)
    } finally {
      setPermissionLoading(false)
    }
  }

  const handleCreateProject = async () => {
    if (creatingProject) return
    setCreatingProject(true)
    try {
      const selected = await pickProjectFolder()
      if (!selected) return
      const allowed = await confirmProjectAccess()
      if (!allowed) return
      const name = selected.name || selected.path.split(/[\\/]/).filter(Boolean).pop() || 'Untitled'
      const created = await createProject({ name, path: selected.path, source_uri: selected.sourceUri })
      if (!projectLocked) {
        setActiveProject(created.id)
        toast.success(`已添加并切换到项目：${created.name}`)
      } else {
        toast.success(`已添加项目：${created.name}（当前会话已锁定，请新建会话后切换）`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`新建项目失败：${msg}`)
    } finally {
      setCreatingProject(false)
    }
  }

  const hasExpandedContent = attachments.length > 0 || Boolean(taskProgress) || pendingQueue.length > 0

  const mentionMenu = mentionOpen ? (
    <LiquidGlassSurface
      ref={menuRef}
      className="composer-mention-menu absolute bottom-full left-2 z-50 mb-2 max-h-72 overflow-auto"
      contentClassName="composer-mention-menu-content"
    >
      <div className="hakus-mobile-menu-header composer-mention-header">
        <span>{copy('@ 上下文与 Skills', '@ Context & skills')}</span>
        <button
          type="button"
          className="hakus-mobile-menu-close"
          onClick={() => setMentionOpen(false)}
          aria-label={copy('关闭上下文选择', 'Close context picker')}
        >
          <span>{copy('关闭', 'Close')}</span>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="composer-mention-body">
        <div className="composer-mention-desktop-heading">
          <span>{copy('@ 上下文与 Skills', '@ Context & skills')}</span>
          {mentionLoading && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
        {filteredMentionItems.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{copy('没有匹配的上下文', 'No matching context')}</div>
        ) : (
          filteredMentionItems.map((item, index) => {
            const Icon = item.icon
            return (
              <button
                key={`${item.insert}-${index}`}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => insertMention(item)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs transition-colors',
                  index === mentionIndex ? 'bg-foreground/[0.08] text-foreground' : 'hover:bg-[var(--cx-ghost-hover)]',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.label}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{item.hint}</span>
                </span>
                <span className="max-w-[116px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {item.insert}
                </span>
              </button>
            )
          })
        )}
      </div>
    </LiquidGlassSurface>
  ) : null

  const slashMenu = slashOpen ? (
    <LiquidGlassSurface
      className="composer-mention-menu absolute bottom-full left-2 z-50 mb-2 max-h-72 w-72 overflow-auto"
      contentClassName="composer-mention-menu-content"
    >
      <div className="composer-mention-desktop-heading">
        <span>{copy('命令', 'Commands')}</span>
      </div>
      {filteredSlashCommands.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">{copy('没有匹配的命令', 'No matching command')}</div>
      ) : (
        filteredSlashCommands.map((cmd, index) => {
          const Icon = cmd.icon
          return (
            <button
              key={cmd.name}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => executeSlash(cmd)}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs transition-colors',
                index === slashIndex ? 'bg-foreground/[0.08] text-foreground' : 'hover:bg-[var(--cx-ghost-hover)]',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{cmd.label}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{cmd.hint}</span>
              </span>
              <span className="max-w-[116px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                /{cmd.name}
              </span>
            </button>
          )
        })
      )}
    </LiquidGlassSurface>
  ) : null

  return (
      <>
      <div className="composer-shell bg-transparent px-4 pb-4 pt-2">
      {/* Android liquid-glass row: a collapsed brain icon that expands into
          the sliding reasoning-effort ladder, plus the context ring —
          floating just above the composer box (no bar attached). */}
      {IS_ANDROID && (
        <div className="relative mb-1.5 flex items-center gap-2 px-0.5">
          {androidReasoningOpen && (
            <LiquidGlassSurface
              className={cn(
                '!absolute bottom-11 left-0 z-50 w-[min(80vw,280px)]',
                'origin-bottom-left animate-in fade-in zoom-in-95 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
              )}
              contentClassName="android-reasoning-glass-content"
            >
              <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-wide text-foreground/85 dark:text-white/45">
                {copy('思考强度', 'Reasoning effort')}
              </div>
              <div
                role="slider"
                aria-label={copy('思考强度', 'Reasoning effort')}
                aria-valuetext={reasoningLabel(activeReasoningEffort)}
                aria-valuemin={0}
                aria-valuemax={Math.max(activeReasoningOptions.length - 1, 0)}
                aria-valuenow={Math.max(activeReasoningOptions.indexOf(activeReasoningEffort), 0)}
                tabIndex={0}
                className="relative flex h-10 touch-none select-none items-center rounded-full bg-black/[0.06] dark:bg-white/[0.06] px-1.5"
                onPointerDown={(e) => {
                  const track = e.currentTarget
                  track.setPointerCapture(e.pointerId)
                  const move = (clientX: number) => {
                    const rect = track.getBoundingClientRect()
                    const ratio = Math.min(Math.max((clientX - rect.left - 6) / (rect.width - 12), 0), 1)
                    const idx = Math.round(ratio * (activeReasoningOptions.length - 1))
                    const effort = activeReasoningOptions[idx]
                    if (effort && effort !== activeReasoningEffort) setReasoningEffort(agentMode, effort)
                  }
                  move(e.clientX)
                  const onMove = (ev: PointerEvent) => move(ev.clientX)
                  const onUp = () => {
                    track.removeEventListener('pointermove', onMove)
                    track.removeEventListener('pointerup', onUp)
                    track.removeEventListener('pointercancel', onUp)
                  }
                  track.addEventListener('pointermove', onMove)
                  track.addEventListener('pointerup', onUp)
                  track.addEventListener('pointercancel', onUp)
                }}
              >
                {/* Sliding thumb behind the labels */}
                <div
                  className="absolute inset-y-1 rounded-full bg-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_8px_rgba(0,0,0,0.12)] dark:bg-white/[0.14] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition-[left] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                  style={{
                    width: `calc((100% - 0.75rem) / ${activeReasoningOptions.length})`,
                    left: `calc(0.375rem + (100% - 0.75rem) / ${activeReasoningOptions.length} * ${Math.max(activeReasoningOptions.indexOf(activeReasoningEffort), 0)})`,
                  }}
                />
                {activeReasoningOptions.map((effort) => {
                  const isSelected = activeReasoningEffort === effort
                  return (
                    <span
                      key={effort}
                      className={cn(
                        'relative z-10 flex-1 cursor-pointer text-center text-[10px] font-medium transition-colors',
                        isSelected ? 'text-foreground font-bold dark:text-white' : 'text-foreground/75 dark:text-white/45',
                      )}
                      onClick={() => setReasoningEffort(agentMode, effort)}
                    >
                      {reasoningLabel(effort)}
                    </span>
                  )
                })}
              </div>
              <div className="mt-2 px-1 text-[10px] leading-relaxed text-foreground/55 dark:text-white/40">
                {copy('左右拖动或点按切换档位', 'Drag or tap to change the effort level')}
              </div>
            </LiquidGlassSurface>
          )}
          <button
            type="button"
            aria-label={copy('思考强度', 'Reasoning effort')}
            aria-expanded={androidReasoningOpen}
            onClick={() => setAndroidReasoningOpen((v) => !v)}
            className={cn(
              'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground/85 transition-transform active:scale-95',
              LIQUID_GLASS_CLASS,
              androidReasoningOpen && 'ring-1 ring-foreground/25 dark:ring-white/40',
            )}
          >
            <Brain className={cn('h-4 w-4', androidReasoningOpen && 'text-primary')} />
          </button>
          {/* Context usage ring — same meter as the desktop composer. */}
          <ContextUsageMeter
            used={contextUsed}
            total={contextWindow}
            messages={sessionMessages || []}
          />
        </div>
      )}
      {/* 宽度对齐聊天正文列（同一个 token），输入框与正文左右同边。 */}
      <div className="composer-inner mx-auto w-full max-w-[var(--thread-content-max-width)]">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'composer-box relative flex flex-col gap-1.5 rounded-[var(--composer-radius)] border border-border/75 bg-card/95 p-2.5 shadow-lg shadow-black/10 transition-colors',
            conversationState !== 'idle' && 'voice-composer-active',
            !hasExpandedContent && 'p-2',
            dragOver && 'border-primary/50 bg-accent/20 ring-1 ring-primary/25',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addAttachments(Array.from(e.target.files || []))
              e.target.value = ''
            }}
          />

          {/* Phone: portal the mention sheet to <body> so its viewport
              geometry is deterministic (no transformed ancestor can trap
              it); desktop keeps it inline inside the composer. */}
          {mentionOpen && isPhoneViewport
            ? createPortal(mentionMenu, document.body)
            : mentionMenu}
          {slashOpen && isPhoneViewport
            ? createPortal(slashMenu, document.body)
            : slashMenu}

          {attachments.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-0.5 pb-0.5">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="group relative flex h-20 min-w-[180px] max-w-[240px] items-center gap-2 rounded-2xl border border-border/75 bg-background/70 p-1.5"
                >
                  {att.kind === 'image' && att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-12 w-12 shrink-0 rounded-xl object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <FileText className="h-5 w-5" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{att.name}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{formatSize(att.size)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeAttachment(att.id)
                    }}
                    className="absolute right-1 top-1 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-destructive/10 hover:text-destructive md:h-8 md:w-8"
                    aria-label="移除附件"
                    title="移除附件"
                  >
                    <X className="h-4 w-4 md:h-3 md:w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {(taskProgress || pendingQueue.length > 0 || isStreaming) && (
            <div className="space-y-2 rounded-2xl border border-border/65 bg-background/60 px-2.5 py-2">
              {taskProgress && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium">
                      <ListChecks className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
                      <span className="truncate">{taskProgress.current_task || "Task running"}</span>
                    </span>
                    {taskProgress.total > 0 && (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {taskProgress.completed}/{taskProgress.total}
                      </span>
                    )}
                  </div>
                  {taskProgress.total > 0 && (
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.max(0, Math.min(100, (taskProgress.completed / taskProgress.total) * 100))}%` }}
                      />
                    </div>
                  )}
                  {taskProgress.tasks && taskProgress.tasks.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {taskProgress.tasks.slice(-4).map((task, index) => {
                        const absoluteIndex = Math.max(0, taskProgress.tasks!.length - 4) + index
                        const done = absoluteIndex < taskProgress.completed
                        const current = task === taskProgress.current_task
                        return (
                          <span
                            key={`${task}-${absoluteIndex}`}
                            className={cn(
                              "max-w-[180px] truncate rounded-full px-1.5 py-0.5 text-[10px]",
                              done ? "bg-emerald-500/10 text-emerald-500" : current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                            )}
                          >
                            {task}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {pendingQueue.length > 0 && (
                <div className="space-y-1.5 border-t border-border/60 pt-2 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Send queue</span>
                    <span>{pendingQueue.length} waiting</span>
                  </div>
                  <div className="space-y-1">
                    {pendingQueue.slice(0, 3).map((item, index) => (
                      <div key={item.id} className="flex items-center gap-2 rounded-xl bg-muted/60 px-2 py-1.5 text-xs">
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">#{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{item.text}</span>
                        {onRemoveQueued && (
                          <button type="button" onClick={() => onRemoveQueued(item.id)} className="shrink-0 text-muted-foreground hover:text-destructive" title="Remove from queue" aria-label="Remove from queue">
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                    {pendingQueue.length > 3 && <div className="px-2 text-[10px] text-muted-foreground">{pendingQueue.length - 3} more...</div>}
                  </div>
                </div>
              )}
              {isStreaming && !taskProgress && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Working {formatTime(elapsed)}</span>
                </div>
              )}
            </div>
          )}

          <Textarea
            ref={taRef}
            value={value}
            onChange={handleChange}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false
              setValue(e.currentTarget.value)
              saveDraft(sessionId, e.currentTarget.value)
            }}
            placeholder={placeholder || 'Message HakusAI'}
            disabled={disabled}
            rows={1}
            className={cn(
              'relative z-10 max-h-[176px] resize-none border-0 bg-transparent px-2 py-2 text-[14px] leading-6 shadow-none focus-visible:ring-0',
              hasExpandedContent ? 'min-h-[56px]' : 'min-h-[44px]',
            )}
          />

          <div
            className={cn('voice-waveform', conversationState !== 'idle' && 'voice-waveform-active')}
            style={{ '--wave-level': Math.max(0.12, Math.min(1, voiceAudioLevel)) } as CSSProperties}
            aria-hidden="true"
          >
            <svg viewBox="0 0 640 24" preserveAspectRatio="none" focusable="false">
              <defs>
                <linearGradient id="wave-gradient" x1="0" x2="1">
                  <stop offset="0" stopColor="#60a5fa" stopOpacity="0" />
                  <stop offset=".2" stopColor="#60a5fa" />
                  <stop offset=".55" stopColor="#60a5fa" />
                  <stop offset=".8" stopColor="#60a5fa" />
                  <stop offset="1" stopColor="#60a5fa" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path className="voice-waveform-path voice-waveform-path-back" d="M0 12 C40 12 48 12 72 12 S105 12 120 12 S150 12 168 12 S200 12 224 12 S256 12 280 12 S320 12 344 12 S376 12 400 12 S432 12 456 12 S488 12 512 12 S544 12 568 12 S608 12 640 12" />
              <path className="voice-waveform-path" d="M0 12 C24 12 28 6 48 6 S72 18 96 18 S120 4 144 4 S168 20 192 20 S216 7 240 7 S264 17 288 17 S312 3 336 3 S360 21 384 21 S408 8 432 8 S456 16 480 16 S504 5 528 5 S552 19 576 19 S600 10 640 12" />
            </svg>
          </div>

          <div className="composer-controls flex flex-wrap items-center justify-between gap-2 px-0.5 pt-1">
            <div className="composer-options flex min-w-0 flex-wrap items-center gap-1.5">
              <Button
                size="icon"
                variant="ghost"
                className="h-11 w-11 rounded-xl text-muted-foreground md:h-8 md:w-8"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                title={copy('添加文件', 'Add file')}
                aria-label={copy('添加文件', 'Add file')}
              >
                <Paperclip className="h-4 w-4" />
              </Button>

              <Button
                size="icon"
                variant="ghost"
                className={cn('h-11 w-11 rounded-xl text-muted-foreground md:h-8 md:w-8', mentionOpen && 'bg-accent text-foreground')}
                onClick={triggerMention}
                disabled={disabled}
                title={copy('@ 上下文', '@ Context')}
                aria-label={copy('@ 上下文', '@ Context')}
              >
                <AtSign className="h-4 w-4" />
              </Button>

              {/* Mobile work settings use a bottom sheet. Radix submenus open
                  sideways, which is reliable with a mouse but can be clipped
                  on narrow touch viewports. */}
              <Dialog
                open={mobileSettingsOpen}
                onOpenChange={(open) => {
                  setMobileSettingsOpen(open)
                  if (!open) {
                    setMobileSettingsSection('root')
                    setMobileModelProviderId(null)
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11 rounded-xl text-muted-foreground md:hidden"
                    disabled={disabled || isStreaming}
                    title={copy('更多选项', 'More options')}
                    aria-label={copy('更多选项', 'More options')}
                  >
                    <MoreHorizontal className="h-5 w-5" />
                  </Button>
                </DialogTrigger>
                <DialogContent
                  className="mobile-settings-sheet md:hidden"
                  style={{
                    // Keep this touch sheet viewport-anchored even when an
                    // Android WebView reports a stale layout viewport or
                    // Radix leaves its desktop centering styles inline.
                    position: 'fixed',
                    top: 'auto',
                    right: 0,
                    bottom: 0,
                    left: 0,
                    width: '100vw',
                    maxWidth: '100vw',
                    height: 'auto',
                    maxHeight: '82vh',
                    margin: 0,
                    transform: 'none',
                  }}
                >
                  <DialogHeader className="mobile-settings-header">
                    {mobileSettingsSection !== 'root' && (
                      <button
                        type="button"
                        className="mobile-settings-back"
                        onClick={() => {
                          if (mobileSettingsSection === 'model' && mobileModelProviderId) {
                            setMobileModelProviderId(null)
                          } else {
                            setMobileSettingsSection('root')
                          }
                        }}
                        aria-label={copy('返回工作设置', 'Back to work settings')}
                      >
                        <ArrowLeft className="h-4 w-4" />
                      </button>
                    )}
                    <DialogTitle>
                      {mobileSettingsSection === 'root' ? copy('工作设置', 'Work settings') : copy(MOBILE_SETTINGS_LABELS[mobileSettingsSection], ({ project: 'Project', model: 'Model', reasoning: 'Reasoning', permission: 'Permissions' } as Record<string, string>)[mobileSettingsSection])}
                    </DialogTitle>
                    <DialogDescription>
                      {mobileSettingsSection === 'root' ? copy('随时调整本次对话的工作上下文', 'Adjust this conversation\'s work context') : copy('选择后返回工作设置', 'Choose an option, then return to work settings')}
                    </DialogDescription>
                  </DialogHeader>

                  <div className="mobile-settings-body">
                    {mobileSettingsSection === 'root' && (
                      <div className="mobile-settings-list">
                        <button type="button" className="mobile-settings-row" onClick={() => setMobileSettingsSection('project')}>
                          <FolderOpen className="mobile-settings-row-icon text-muted-foreground" strokeWidth={1.75} />
                          <span className="mobile-settings-row-copy"><strong>{t('projects')}</strong><small>{activeProject?.name || t('currentDirectory')}</small></span>
                          <ChevronRight className="mobile-settings-row-chevron" />
                        </button>
                        <button type="button" className="mobile-settings-row" onClick={() => { setMobileSettingsSection('model'); setMobileModelProviderId(null) }}>
                          <Bot className="mobile-settings-row-icon text-muted-foreground" strokeWidth={1.75} />
                          <span className="mobile-settings-row-copy"><strong>{copy('模型', 'Model')}</strong><small>{currentProviderLabel}</small></span>
                          <ChevronRight className="mobile-settings-row-chevron" />
                        </button>
                        <button
                          type="button"
                          className="mobile-settings-row"
                          onClick={() => {
                            setMobileSettingsOpen(false)
                            window.setTimeout(() => {
                              if (goalHasControls) setGoalDialogOpen(true)
                              else onToggleLongRunning?.()
                            }, 0)
                          }}
                        >
                          <LoaderCircle className={cn('mobile-settings-row-icon', goalHasControls || longRunningArmed ? 'text-foreground' : 'text-muted-foreground')} />
                          <span className="mobile-settings-row-copy"><strong>{copy('长程任务', 'Long-running task')}</strong><small>{goalHasControls ? goalStatusLabel : longRunningArmed ? copy('发送一句话开始', 'Send one message to start') : goal?.status === 'complete' ? copy('已完成，可重新启用', 'Complete, ready to re-enable') : copy('点击后发送一句话开始', 'Click, then send one message to start')}</small></span>
                          <ChevronRight className="mobile-settings-row-chevron" />
                        </button>
                        <button type="button" className="mobile-settings-row" onClick={() => setMobileSettingsSection('reasoning')}>
                          <Brain className="mobile-settings-row-icon text-muted-foreground" strokeWidth={1.75} />
                          <span className="mobile-settings-row-copy"><strong>{copy('思考强度', 'Reasoning')}</strong><small>{reasoningLabel(activeReasoningEffort)}</small></span>
                          <ChevronRight className="mobile-settings-row-chevron" />
                        </button>
                        <button type="button" className="mobile-settings-row" onClick={() => setMobileSettingsSection('permission')}>
                          <ActivePermissionIcon className={cn('mobile-settings-row-icon', activePermissionMeta.tone)} />
                          <span className="mobile-settings-row-copy"><strong>{copy('权限', 'Permissions')}</strong><small>{permissionLabel(permission)}</small></span>
                          <ChevronRight className="mobile-settings-row-chevron" />
                        </button>
                      </div>
                    )}

                    {mobileSettingsSection === 'project' && (
                      <div className="mobile-settings-list">
                        {projects.slice(0, 12).map((project) => (
                          <button
                            type="button"
                            key={project.id}
                            className="mobile-settings-row"
                            disabled={projectLocked}
                            onClick={() => {
                              setActiveProject(project.id)
                              setMobileSettingsOpen(false)
                            }}
                          >
                            <FolderOpen className={cn('mobile-settings-row-icon', activeProjectId === project.id ? 'text-primary' : 'text-muted-foreground')} />
                            <span className="mobile-settings-row-copy"><strong>{project.name}</strong><small>{project.path}</small></span>
                            {activeProjectId === project.id ? <Check className="mobile-settings-row-check" /> : <ChevronRight className="mobile-settings-row-chevron" />}
                          </button>
                        ))}
                        <button type="button" className="mobile-settings-row" disabled={creatingProject} onClick={() => { setMobileSettingsOpen(false); setProjectSourceOpen(true) }}>
                          {creatingProject ? <Loader2 className="mobile-settings-row-icon animate-spin text-primary" /> : <FolderPlus className="mobile-settings-row-icon text-primary" />}
                          <span className="mobile-settings-row-copy"><strong>{copy('新建项目', 'New project')}</strong><small>{copy('选择一个文件夹作为工作区', 'Choose a folder as the workspace')}</small></span>
                          <ChevronRight className="mobile-settings-row-chevron" />
                        </button>
                        <button type="button" className="mobile-settings-row" disabled={projectLocked || !activeProjectId} onClick={() => { setActiveProject(null); setMobileSettingsOpen(false) }}>
                          <X className="mobile-settings-row-icon text-muted-foreground" />
                          <span className="mobile-settings-row-copy"><strong>{copy('不在项目中工作', 'No project')}</strong><small>{copy('使用当前应用目录', 'Use the current app directory')}</small></span>
                        </button>
                        {projectLocked && <p className="mobile-settings-note">{copy('当前会话已经开始，项目已锁定。请新建会话后切换工作区。', 'This conversation has started and its project is locked. Start a new conversation to switch workspaces.')}</p>}
                      </div>
                    )}

                    {mobileSettingsSection === 'model' && (
                      <div className="mobile-settings-list">
                        {!mobileModelProvider ? usableProviders.map((provider) => (
                          <button
                            type="button"
                            key={provider.id}
                            className="mobile-settings-row"
                            disabled={switchingProvider || !provider.model_name}
                            onClick={() => {
                              if (!provider.model_name) return
                              setMobileModelProviderId(provider.id)
                              void ensureProviderModels(provider.id)
                            }}
                          >
                            <ProviderLogo providerId={provider.id} size={20} />
                            <span className="mobile-settings-row-copy"><strong>{provider.display_name}</strong><small>{provider.model_name || copy('未配置模型', 'No model configured')}</small></span>
                            {provider.is_default ? <Check className="mobile-settings-row-check" /> : <ChevronRight className="mobile-settings-row-chevron" />}
                          </button>
                        )) : (
                          <>
                            <div className="mobile-settings-row mobile-settings-row-static">
                              <ProviderLogo providerId={mobileModelProvider.id} size={20} />
                              <span className="mobile-settings-row-copy"><strong>{mobileModelProvider.display_name}</strong><small>{copy('选择一个模型', 'Choose a model')}</small></span>
                            </div>
                            {modelsLoading && !mobileModelOptions ? (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">{copy('加载模型...', 'Loading models...')}</div>
                            ) : mobileModelOptions && mobileModelOptions.length > 0 ? (
                              mobileModelOptions.map((item) => (
                                <button
                                  type="button"
                                  key={item.id}
                                  className="mobile-settings-row pl-12"
                                  disabled={switchingProvider}
                                  onClick={() => {
                                    setMobileSettingsOpen(false)
                                    setMobileModelProviderId(null)
                                    void handleModelSelect(mobileModelProvider!, item.id)
                                  }}
                                >
                                  <span className="mobile-settings-row-copy"><strong>{item.name || item.id}</strong><small>{item.id}</small></span>
                                  {mobileModelProvider.is_default && mobileModelProvider.model_name === item.id
                                    ? <Check className="mobile-settings-row-check" />
                                    : <ChevronRight className="mobile-settings-row-chevron" />}
                                </button>
                              ))
                            ) : (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">{copy('该 Provider 没有可用模型', 'This provider has no available models')}</div>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {mobileSettingsSection === 'reasoning' && (
                      <div className="mobile-settings-list">
                        {activeReasoningOptions.map((effort) => (
                          <button type="button" key={effort} className="mobile-settings-row" onClick={() => { setReasoningEffort(agentMode, effort); setMobileSettingsOpen(false) }}>
                            <Brain className="mobile-settings-row-icon text-muted-foreground" />
                            <span className="mobile-settings-row-copy"><strong>{reasoningLabel(effort)}</strong><small>{reasoningDescription(effort)}</small></span>
                            {activeReasoningEffort === effort ? <Check className="mobile-settings-row-check" /> : <ChevronRight className="mobile-settings-row-chevron" />}
                          </button>
                        ))}
                      </div>
                    )}

                    {mobileSettingsSection === 'permission' && (
                      <div className="mobile-settings-list">
                        {availablePermissions.map((mode) => {
                          const meta = PERMISSION_META[mode] ?? PERMISSION_META.ask!
                          const Icon = meta.icon
                          return (
                            <button type="button" key={mode} className="mobile-settings-row" disabled={permissionLoading} onClick={() => { setMobileSettingsOpen(false); void handlePermissionSwitch(mode) }}>
                              <Icon className={cn('mobile-settings-row-icon', meta.tone)} />
                            <span className="mobile-settings-row-copy"><strong>{permissionLabel(mode)}</strong><small>{locale === 'zh-CN' ? meta.hint : permissionLabel(mode) + ' mode'}</small></span>
                              {permission === mode ? <Check className="mobile-settings-row-check" /> : <ChevronRight className="mobile-settings-row-chevron" />}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>

              <div className="composer-edge-controls" aria-label={copy('当前工作上下文', 'Current work context')}>
              <Dialog open={goalDialogOpen && goalHasControls} onOpenChange={setGoalDialogOpen}>
                <button
                  type="button"
                  disabled={isStreaming && !goal}
                  aria-pressed={longRunningArmed}
                  className={cn(
                    'composer-edge-trigger hidden h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-background/80 px-2 text-xs font-medium transition-colors hover:bg-[var(--cx-ghost-hover)] md:inline-flex',
                    (goalHasControls || longRunningArmed) && 'border-primary/20 bg-primary/[0.06]',
                    isStreaming && !goal && 'cursor-not-allowed opacity-60',
                  )}
                    title={goalHasControls ? copy('长程任务管理', 'Manage long-running task') : copy('点击启用长程模式，发送一句话开始', 'Enable long-running mode, then send one message to start')}
                  onClick={() => {
                    if (goalHasControls) setGoalDialogOpen(true)
                    else onToggleLongRunning?.()
                  }}
                >
                  <LongRunningTaskVisual active={goalHasControls} armed={longRunningArmed} />
                  <span>{goalButtonLabel}</span>
                </button>
                <DialogContent className="w-[min(440px,calc(100vw-32px))]">
                  <DialogHeader>
                    <DialogTitle>{copy('长程任务', 'Long-running task')}</DialogTitle>
                    <DialogDescription>{goal?.objective}</DialogDescription>
                  </DialogHeader>
                  {goal && (
                    <div className="rounded-xl bg-foreground/[0.04] px-3 py-2 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-3"><span>状态</span><strong className="font-medium text-foreground">{goalStatusLabel}</strong></div>
                      <div className="flex items-center justify-between gap-3"><span>连续回合</span><strong className="font-medium text-foreground">{goal.continuation_count}</strong></div>
                      <div className="mt-1 flex items-center justify-between gap-3"><span>已用 token</span><strong className="font-medium text-foreground">{(goal.tokens_used ?? 0).toLocaleString()}</strong></div>
                    </div>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    {goal?.status === 'active' && <button type="button" disabled={goalActionLoading || !onGoalAction} onClick={async () => { if (!onGoalAction) return; setGoalActionLoading(true); try { await onGoalAction('pause') } finally { setGoalActionLoading(false) } }} className="inline-flex h-8 items-center rounded-lg border border-border/70 px-3 text-xs font-medium hover:bg-[var(--cx-ghost-hover)] disabled:opacity-50">暂停</button>}
                    {(goal?.status === 'paused' || goal?.status === 'blocked') && <button type="button" disabled={goalActionLoading || !onGoalAction} onClick={async () => { if (!onGoalAction) return; setGoalActionLoading(true); try { await onGoalAction('resume'); setGoalDialogOpen(false) } finally { setGoalActionLoading(false) } }} className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">继续</button>}
                    {goal && goal.status !== 'complete' && <button type="button" disabled={goalActionLoading || !onGoalAction} onClick={async () => { if (!onGoalAction) return; setGoalActionLoading(true); try { await onGoalAction('complete'); setGoalDialogOpen(false) } finally { setGoalActionLoading(false) } }} className="inline-flex h-8 items-center rounded-lg border border-border/70 px-3 text-xs font-medium hover:bg-[var(--cx-ghost-hover)] disabled:opacity-50">标记完成</button>}
                  </div>
                </DialogContent>
              </Dialog>
              <DropdownMenu
                onOpenChange={(open) => {
                  // Reset the "删除?" confirm state whenever the
                  // dropdown closes, so the next time the user opens
                  // it they don't see a stale confirm button.
                  if (!open) setConfirmDeleteId(null)
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={isStreaming}
                    className={cn(
                      'composer-edge-trigger composer-project-trigger hidden h-8 max-w-[220px] items-center gap-1.5 rounded-xl border border-border/70 bg-background/80 px-2 text-xs font-medium transition-colors hover:bg-[var(--cx-ghost-hover)] md:inline-flex',
                      isStreaming && 'cursor-not-allowed opacity-60',
                    )}
                    title={activeProject ? displayPath(activeProject.path) : copy('不在项目中工作', 'No project')}
                  >
                    <FolderOpen className={cn('h-3.5 w-3.5 shrink-0', activeProject ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="truncate">{activeProject ? activeProject.name : copy('不在项目中工作', 'No project')}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" mobileTitle={copy('选择项目', 'Choose project')} className="w-[300px] p-1.5">
                  {/* Search box */}
                  <div className="search-composite mb-1 flex items-center gap-1.5 rounded-lg border border-transparent bg-foreground/[0.04] px-2 py-1.5">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      type="text"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                      placeholder={copy('搜索项目...', 'Search projects...')}
                      className="project-picker-search search-composite-input w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                    />
                  </div>
                  {/* Project list (filtered) */}
                  <div className="max-h-[260px] overflow-y-auto">
                    {projects.length === 0 && (
                      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {copy('暂无项目，点击下方「新建项目」', 'No projects yet. Create one below.')}
                      </div>
                    )}
                    {projects
                      .filter((p) => {
                        const q = projectSearch.trim().toLowerCase()
                        if (!q) return true
                        return (
                          p.name.toLowerCase().includes(q) ||
                          p.path.toLowerCase().includes(q)
                        )
                      })
                      .map((p) => {
                        const isActive = activeProjectId === p.id
                        const isConfirming = confirmDeleteId === p.id
                        return (
                          <div
                            key={p.id}
                            // Use a div instead of DropdownMenuItem so we can
                            // host a nested delete button with its own click
                            // handler without the menu item stealing the click.
                            // We replicate the DropdownMenuItem styles so the
                            // row looks identical to the other menu rows.
                            role="menuitem"
                            tabIndex={-1}
                            onClick={() => {
                              if (isConfirming) return
                              if (projectLocked) {
                                toast.info(copy('当前会话已有对话，无法切换项目。请新建会话后再切换。', 'This conversation already has messages. Start a new one before switching projects.'))
                                return
                              }
                              setActiveProject(p.id)
                            }}
                            className={cn(
                              'group relative flex cursor-pointer items-center gap-2 rounded-lg py-2 pl-2 pr-8 text-sm outline-none transition-colors hover:bg-[var(--cx-ghost-hover)] focus:bg-[var(--cx-ghost-hover)]',
                              isActive && 'bg-foreground/[0.04]',
                            )}
                          >
                            <FolderOpen className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{p.name}</div>
                              <div className="truncate text-[10px] text-muted-foreground">{displayPath(p.path)}</div>
                            </div>
                            {isActive && !isConfirming && (
                              <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                            )}
                            {/* Delete (X) button.
                                - Hidden by default; appears on row hover OR
                                  when active (so the user can see it next to
                                  the checkmark, matching the request).
                                - Two-step confirm: first click shows "确定?"，
                                  second click actually deletes. Prevents
                                  accidental removal of a pinned project.
                                - The folder on disk is NOT touched — only
                                  the registry entry is removed. */}
                            {isConfirming ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void removeProject(p.id)
                                  setConfirmDeleteId(null)
                                  toast.success(`已移除项目：${p.name}`)
                                }}
                                title={copy('再次点击以确认删除', 'Click again to confirm deletion')}
                                className="absolute right-1.5 inline-flex h-6 items-center rounded-md bg-destructive/10 px-1.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                              >
                                {copy('删除?', 'Delete?')}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setConfirmDeleteId(p.id)
                                  // Auto-cancel the confirm state after 3s
                                  // so the user doesn't end up with a
                                  // lingering "删除?" button if they
                                  // change their mind.
                                  setTimeout(() => {
                                    setConfirmDeleteId((cur) => (cur === p.id ? null : cur))
                                  }, 3000)
                                }}
                                title={copy('移除项目（不会删除文件夹）', 'Remove project (folder stays on disk)')}
                                className={cn(
                                  'absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive',
                                  // Always show on hover; only show on active
                                  // row when not currently confirming.
                                  isActive
                                    ? 'opacity-60'
                                    : 'opacity-0 group-hover:opacity-60',
                                )}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        )
                      })}
                  </div>
                  <DropdownMenuSeparator />
                  {/* New project — opens the source chooser.
                      Allowed even when projectLocked, because creating
                      a project doesn't switch the active one. But the
                      auto-setActiveProject(created.id) at the end is
                      gated — newly created project just joins the list,
                      user can switch to it in a fresh session. */}
                  <DropdownMenuItem
                    onClick={() => setProjectSourceOpen(true)}
                    disabled={creatingProject}
                    className="gap-2 py-2"
                  >
                    {creatingProject ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <FolderPlus className="h-4 w-4 shrink-0 text-primary" />
                    )}
                    <span className="text-sm font-medium">{copy('新建项目', 'New project')}</span>
                  </DropdownMenuItem>
                  {/* Not working in a project — clears the active project.
                      Locked when the session already has messages. */}
                  <DropdownMenuItem
                    onClick={() => {
                      if (projectLocked) {
                        toast.info(copy('当前会话已有对话，无法切换项目。请新建会话后再切换。', 'This conversation already has messages. Start a new one before switching projects.'))
                        return
                      }
                      setActiveProject(null)
                    }}
                    disabled={projectLocked}
                    className="gap-2 py-2"
                  >
                    <X className={cn('h-4 w-4 shrink-0', !activeProjectId ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="flex-1 text-sm">{copy('不在项目中工作', 'No project')}</span>
                    {!activeProjectId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={providersLoading || switchingProvider || isStreaming || usableProviders.length === 0}
                    className={cn(
                      'composer-edge-trigger composer-model-trigger hidden h-8 max-w-[220px] items-center gap-1.5 rounded-xl border border-border/70 bg-background/80 px-2 text-xs font-medium transition-colors hover:bg-[var(--cx-ghost-hover)] md:inline-flex',
                      (providersLoading || switchingProvider || isStreaming) && 'cursor-not-allowed opacity-60',
                    )}
                    title={copy('选择模型', 'Choose model')}
                  >
                    {providersLoading || switchingProvider ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <ProviderLogo providerId={currentProvider?.id || ''} size={14} />
                    )}
                    <span className="truncate">{currentProviderLabel}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" mobileTitle={copy('选择模型', 'Choose model')} className="w-[280px]">
                  {usableProviders.length === 0 && (
                    <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                      {providersLoading ? "加载中..." : "暂无 provider"}
                    </div>
                  )}
                  {orderedProviderGroups.map(({ group, items }) => (
                    <div key={group}>
                      <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{group}</div>
                      {items.map((provider) => {
                    const isExpanded = expandedProvider === provider.id
                    const models = modelsCache[provider.id]
                    const isCurrent = provider.is_default
                    return (
                      <div key={provider.id} className="p-0.5">
                        {/* Provider row — click toggles the model list; the
                            chevron/right arrow is the expand affordance. */}
                        <button
                          type="button"
                          onClick={() => void toggleProviderModels(provider.id)}
                          aria-current={isCurrent ? 'true' : undefined}
                          className={cn(
                            'flex w-full items-start gap-2 rounded-lg border border-transparent px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--cx-ghost-hover)]',
                            isCurrent && 'border-primary/15 bg-primary/[0.06]',
                            isExpanded && !isCurrent && 'bg-foreground/[0.04]',
                          )}
                        >
                          <ProviderLogo providerId={provider.id} size={16} className="mt-0.5 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="line-clamp-2 break-words text-sm leading-tight" title={provider.display_name}>{provider.display_name}</div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {provider.model_name || copy('未设置模型', 'No model set')}
                            </div>
                          </div>
                          {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                          <ChevronDown
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                              isExpanded && 'rotate-180',
                            )}
                          />
                        </button>

                        {/* Collapsible model list for this provider. */}
                        {isExpanded && (
                          <div className="ml-3 border-l border-border/60 pl-1.5">
                            {modelsLoading && !models ? (
                              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {copy('加载模型…', 'Loading models…')}
                              </div>
                            ) : models && models.length > 0 ? (
                              models.map((m) => {
                                const isSelected =
                                  isCurrent && provider.model_name === m.id
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => void handleModelSelect(provider, m.id)}
                                    className={cn(
                                      'flex w-full items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 text-left text-xs transition-colors hover:bg-[var(--cx-ghost-hover)]',
                                      isSelected && 'bg-primary/[0.06] text-foreground',
                                    )}
                                    aria-current={isSelected ? 'true' : undefined}
                                  >
                                    <span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
                                    {isSelected && <Check className="h-3 w-3 shrink-0 text-primary" />}
                                  </button>
                                )
                              })
                            ) : (
                              <div className="px-2 py-2 text-xs text-muted-foreground">
                                {copy('该 provider 无可用模型', 'This provider has no available models')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                      })}
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Context-window usage ring — sits right of the model picker. */}
              <ContextUsageMeter
                used={contextUsed}
                total={contextWindow}
                messages={sessionMessages || []}
              />

              </div>

              {/* Reasoning effort — independent dropdown. Three levels:
                  快速 / 深度 / 极致. Per-mode override stored in
                  reasoningEfforts[agentMode]. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={isStreaming}
                    className={cn(
                      'hidden h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-background/80 px-2 text-xs font-medium transition-colors hover:bg-[var(--cx-ghost-hover)] md:inline-flex',
                      isStreaming && 'cursor-not-allowed opacity-60',
                    )}
                    title={copy('思考强度', 'Reasoning')}
                  >
                    <Brain className="h-3.5 w-3.5 text-primary" />
                    <span>{reasoningLabel(activeReasoningEffort)}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" mobileTitle={copy('思考强度', 'Reasoning')} className="w-[180px]">
                  {activeReasoningOptions.map((effort) => {
                    const isSelected = activeReasoningEffort === effort
                    const meta = getReasoningEffortMeta(effort)
                    return (
                      <DropdownMenuItem
                        key={effort}
                        onClick={() => setReasoningEffort(agentMode, effort)}
                        className="items-center gap-2 py-1.5"
                      >
                        <Brain className={cn('h-3 w-3 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                        <span className="flex-1 text-xs font-medium">{reasoningLabel(effort)}</span>
                        {isSelected && <Check className="h-3 w-3 text-primary" />}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={permissionLoading}
                    className={cn(
                      'hidden h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-background/80 px-2 text-xs font-medium transition-colors hover:bg-[var(--cx-ghost-hover)] md:inline-flex',
                      permissionLoading && 'cursor-not-allowed opacity-60',
                    )}
                    title="Permission mode"
                  >
                    {permissionLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <ActivePermissionIcon className={cn('h-3.5 w-3.5', activePermissionMeta.tone)} />
                    )}
                    <span>{permissionLabel(permission)}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" mobileTitle={copy('权限模式', 'Permission mode')} className="w-[200px]">
                  {availablePermissions.map((mode) => {
                    const meta = PERMISSION_META[mode] ?? PERMISSION_META.ask!
                    const Icon = meta.icon
                    const active = mode === permission
                    return (
                      <DropdownMenuItem
                        key={mode}
                        onClick={() => handlePermissionSwitch(mode)}
                        className="gap-2 py-2"
                      >
                        <Icon className={cn('h-4 w-4', meta.tone)} />
                        <span className="flex-1 text-sm font-medium">{permissionLabel(mode)}</span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="composer-actions flex items-center gap-2">
              <span className="hidden text-[10px] text-muted-foreground/70 sm:inline">
                {sendOnEnter ? copy('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line') : copy('Ctrl/Cmd+Enter 发送', 'Ctrl/Cmd+Enter to send')}
              </span>
              {attachments.some((att) => att.kind === 'image') && (
                <span className="hidden items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground md:inline-flex">
                  <ImageIcon className="h-3 w-3" />
                  {copy('图片附件', 'Image attached')}
                </span>
              )}
              {onToggleVoiceCall && (
            <Button
                  size="icon"
                  variant={conversationState !== 'idle' ? 'destructive' : 'outline'}
                  className={cn(
                    'h-8 w-8 rounded-xl',
                    conversationState === 'connecting' && 'bg-primary text-white hover:bg-primary/90',
                    conversationState === 'listening' && 'bg-emerald-500 text-white hover:bg-emerald-600',
                    conversationState === 'speaking' && 'bg-blue-500 text-white hover:bg-blue-600',
                    (conversationState === 'transcribing' || conversationState === 'thinking') &&
                      'bg-amber-500 text-white hover:bg-amber-600',
                    (conversationState === 'listening' || conversationState === 'speaking') && 'animate-pulse',
                  )}
                  onClick={() => void onToggleVoiceCall()}
                  disabled={voiceCallLoading}
                  title={
                    conversationState === 'listening'
                      ? copy('聆听中…点击结束', 'Listening… click to stop')
                      : conversationState === 'transcribing'
                        ? copy('语音识别中…', 'Transcribing…')
                        : conversationState === 'thinking'
                          ? copy('AI 思考中…', 'AI is thinking…')
                          : conversationState === 'speaking'
                            ? copy('AI 播报中…点击打断', 'Speaking… click to interrupt')
                            : copy('开始语音对话', 'Start voice chat')
                  }
                >
                  {conversationState === 'connecting' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : conversationState === 'listening' ? (
                    <Mic className="h-3.5 w-3.5" />
                  ) : conversationState === 'transcribing' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : conversationState === 'thinking' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : conversationState === 'speaking' ? (
                    <Volume2 className="h-3.5 w-3.5" />
                  ) : (
                    <PhoneCall className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
              {/* 运行中且输入框为空时不显示发送按钮：此时它永远是灰的、
                  点不动，和旁边的停止按钮并排只是噪音。一旦有输入（含附件），
                  它才出现并提供「加入队列」的能力。 */}
              {(!isStreaming || value.trim() || attachments.length > 0) && (
                <Button
                  size="icon"
                  className={cn(
                    'h-8 w-8 rounded-full border border-border/40 transition-colors',
                    (!value.trim() && attachments.length === 0) || disabled || uploading
                      ? 'border-transparent bg-muted/40 text-muted-foreground/60'
                      : 'bg-foreground text-background hover:bg-foreground/85',
                  )}
                  onClick={() => void submit()}
                  disabled={(!value.trim() && attachments.length === 0) || disabled || uploading}
                  title={isStreaming ? copy('加入发送队列', 'Add to send queue') : copy('发送', 'Send')}
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
                </Button>
              )}
              {isStreaming && (
                <Button
                  size="icon"
                  variant="destructive"
                  className="h-8 w-8 rounded-xl"
                  onClick={onStop}
                  title={copy('停止', 'Stop')}
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="composer-tip mt-1.5 flex items-center justify-between px-2 text-[10px] text-muted-foreground/65">
          <span className="flex items-center gap-1.5">
            {canUseImages ? copy('可粘贴图片', 'Images can be pasted') : copy('当前模型仅文本', 'Current model accepts text only')}
          </span>
          <span>{value.length} chars</span>
        </div>
      </div>
    </div>
    <ProjectSourceDialog
      open={projectSourceOpen}
      onOpenChange={setProjectSourceOpen}
      onLocal={() => void handleCreateProject()}
      onRemote={() => { setProjectSourceOpen(false); setRemoteWizardOpen(true) }}
    />
    <RemoteProjectWizard open={remoteWizardOpen} onOpenChange={setRemoteWizardOpen} />
    <AndroidModelGlass open={androidModelGlassOpen} onClose={() => setAndroidModelGlassOpen(false)} />
    </>
  )
}
