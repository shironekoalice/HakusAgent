import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowRightLeft,
  Check,
  CheckCheck,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  Loader2,
  MessageSquarePlus,
  Search,
  Send,
  Terminal,
  Wrench,
  X,
} from 'lucide-react'
import type { ToolCall } from '@/api/types'
import { cn, copyToClipboard } from '@/lib/utils'

const RESULT_DISPLAY_CHARS = 1200
/** 一个堆叠组里最多直接显示几行；其余折叠成 "还有 N 个工具调用"。 */
const VISIBLE_ROWS = 3

const TOOL_LABELS: Record<string, string> = {
  bash: '执行命令',
  shell: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  append_file: '追加文件',
  multi_edit_file: '批量编辑',
  read_multiple_files: '读取多个文件',
  move_file: '移动文件',
  copy_file: '复制文件',
  delete_file: '删除文件',
  file_stat: '查看文件信息',
  create_directory: '创建目录',
  glob: '匹配文件',
  grep: '搜索内容',
  list_dir: '列出目录',
  tree: '查看目录树',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  task: '创建子任务',
  tool_search: '搜索工具',
  code_execution: '执行代码',
  // 线程即工具
  create_thread: '创建子会话',
  fork_thread: '派生会话',
  send_message_to_thread: '发送到子会话',
  handoff_thread: '移交会话',
}

function toolIcon(name: string): ReactNode {
  switch (name) {
    case 'bash':
    case 'shell':
      return <Terminal className="h-3.5 w-3.5" />
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'append_file':
    case 'read_multiple_files':
    case 'file_stat':
      return <FileText className="h-3.5 w-3.5" />
    case 'tree':
    case 'list_dir':
    case 'create_directory':
      return <FolderTree className="h-3.5 w-3.5" />
    case 'grep':
    case 'glob':
      return <Search className="h-3.5 w-3.5" />
    case 'create_thread':
      return <MessageSquarePlus className="h-3.5 w-3.5" />
    case 'fork_thread':
      return <GitBranch className="h-3.5 w-3.5" />
    case 'send_message_to_thread':
      return <Send className="h-3.5 w-3.5" />
    case 'handoff_thread':
      return <ArrowRightLeft className="h-3.5 w-3.5" />
    case 'web_search':
    case 'web_fetch':
      return <Globe className="h-3.5 w-3.5" />
    default:
      return <Wrench className="h-3.5 w-3.5" />
  }
}

function pathOf(args: Record<string, any>): string {
  return args.path || args.file_path || args.source || ''
}

function formatList(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(', ')
  if (typeof v === 'string') return v
  return ''
}

function firstLine(v: unknown): string {
  if (typeof v !== 'string') return ''
  const nl = v.indexOf('\n')
  return nl >= 0 ? v.slice(0, nl) : v
}

function humanizeName(name: string): string {
  return name
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** 一行参数摘要（截断），折叠态绝不展示整段 raw JSON。 */
function describeToolCall(tc: ToolCall): { title: string; detail: string } {
  const label = TOOL_LABELS[tc.name] || humanizeName(tc.name)
  const args = tc.arguments ?? {}

  switch (tc.name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'append_file':
    case 'file_stat':
    case 'move_file':
    case 'copy_file':
    case 'delete_file':
      return { title: label, detail: pathOf(args) }
    case 'read_multiple_files':
      return { title: label, detail: formatList(args.paths) }
    case 'multi_edit_file':
      return { title: label, detail: pathOf(args) }
    case 'bash':
    case 'shell':
      return { title: label, detail: firstLine(args.command) }
    case 'web_search':
      return { title: label, detail: args.query ? `"${args.query}"` : '' }
    case 'web_fetch':
      return { title: label, detail: args.url || '' }
    case 'create_directory':
      return { title: label, detail: args.path || args.dir || '' }
    case 'grep':
      return {
        title: label,
        detail: args.pattern ? `"${args.pattern}" in ${args.path || ''}` : args.path || '',
      }
    case 'glob':
      return { title: label, detail: args.pattern || '' }
    case 'list_dir':
    case 'tree':
      return { title: label, detail: args.path || args.directory || '' }
    case 'task':
      return { title: label, detail: firstLine(args.task) }
    default: {
      const firstStr = Object.values(args).find((v) => typeof v === 'string' && v.length > 0)
      return { title: label, detail: firstStr ? truncate(String(firstStr), 60) : '' }
    }
  }
}

/**
 * 结果格式化：若结果是 JSON 则重新缩进为可读的多行格式；
 * 否则原样返回文本。彻底避免一行平铺的 raw JSON。
 */
function formatResult(result: string): { text: string; isJson: boolean } {
  const trimmed = result.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), isJson: true }
    } catch {
      // 不是合法 JSON，按原始文本展示
    }
  }
  return { text: result, isJson: false }
}

interface ToolRowProps {
  toolCall: ToolCall
  inGroup: boolean
}

/** 单行工具摘要（ZCode ToolSummaryRow 模式）：紧凑、可展开、状态在右。 */
const ToolRow = memo(function ToolRow({ toolCall, inGroup }: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [showFullResult, setShowFullResult] = useState(false)
  const [copiedArgs, setCopiedArgs] = useState(false)
  const [copiedResult, setCopiedResult] = useState(false)

  const success = toolCall.success !== false
  // started 事件先到、finished 未到时 success 为 undefined 且无结果 → 运行中
  const pending = toolCall.success === undefined && !toolCall.result
  const summary = describeToolCall(toolCall)
  const args = toolCall.arguments ?? {}
  const hasArgs = Object.keys(args).length > 0
  const hasDetails = hasArgs || !!toolCall.result
  const resultLength = toolCall.result?.length ?? 0
  const resultTooLong = resultLength > RESULT_DISPLAY_CHARS

  const handleCopyArgs = async () => {
    const text = JSON.stringify(args, null, 2)
    if (await copyToClipboard(text)) {
      setCopiedArgs(true)
      setTimeout(() => setCopiedArgs(false), 1500)
    }
  }

  const handleCopyResult = async () => {
    const text = toolCall.result || ''
    if (await copyToClipboard(text)) {
      setCopiedResult(true)
      setTimeout(() => setCopiedResult(false), 1500)
    }
  }

  const handleOpenFullResult = () => {
    if (!toolCall.result) return
    const blob = new Blob([toolCall.result], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  const pretty = toolCall.result ? formatResult(toolCall.result) : null
  const resultText = pretty
    ? pretty.isJson || showFullResult
      ? pretty.text
      : truncate(pretty.text, RESULT_DISPLAY_CHARS)
    : ''

  return (
    <div className="min-w-0" data-tool-call={toolCall.call_id}>
      {/* 折叠态：单行紧凑摘要（ZCode ToolSummaryRow：图标 + 类别 + 参数摘要 + 状态 + chevron） */}
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
        aria-expanded={expanded}
        className={cn(
          'group/tool-row flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 text-left transition-colors',
          inGroup ? 'px-2' : 'pl-2 pr-1.5',
          hasDetails ? 'cursor-pointer hover:bg-[var(--cx-ghost-hover)]' : 'cursor-default',
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : toolIcon(toolCall.name)}
        </span>
        <span
          className={cn(
            'shrink-0 text-xs font-medium',
            success && !pending ? 'text-foreground/85' : success ? 'text-foreground/60' : 'text-destructive',
          )}
        >
          {summary.title}
        </span>
        {summary.detail && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary.detail}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/80">
          {toolCall.duration !== undefined && toolCall.duration > 0 && (
            <span>{toolCall.duration.toFixed(2)}s</span>
          )}
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
          ) : success ? (
            <Check className="h-3 w-3 text-emerald-500" />
          ) : (
            <X className="h-3 w-3 text-destructive" />
          )}
          {hasDetails && (
            <ChevronRight
              className={cn(
                'h-3 w-3 text-muted-foreground transition-transform duration-200',
                expanded && 'rotate-90',
              )}
            />
          )}
        </span>
      </button>

      {/* 展开态：参数 + 结果的格式化 JSON，左侧缩进对齐父行（ZCode NESTED_TOOLCALL_CONTAINER 模式） */}
      {expanded && hasDetails && (
        <div className={cn('mb-1.5 space-y-2', inGroup ? 'ml-4 border-l border-border/60 pl-3' : 'ml-2 mr-1 mt-0.5 pl-5')}>
          {hasArgs && (
            <div className="group/block relative">
              <button
                onClick={handleCopyArgs}
                className="absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/block:opacity-100"
                title="复制参数"
              >
                {copiedArgs ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                {copiedArgs ? '已复制' : '复制'}
              </button>
              <pre className="tool-log-pre max-h-56 overflow-auto rounded-xl border border-border/40 bg-foreground/[0.04] p-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {pretty && (
            <div className="group/block relative">
              <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/block:opacity-100">
                {!pretty.isJson && resultTooLong && (
                  <button
                    onClick={handleOpenFullResult}
                    className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm hover:text-foreground"
                    title="查看完整日志"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    新窗口打开
                  </button>
                )}
                <button
                  onClick={handleCopyResult}
                  className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm hover:text-foreground"
                  title="复制结果"
                >
                  {copiedResult ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                  {copiedResult ? '已复制' : '复制'}
                </button>
              </div>
              <pre
                className={cn(
                  'tool-log-pre max-h-72 overflow-auto rounded-xl border p-2.5 font-mono text-[11px] leading-relaxed',
                  success
                    ? 'border-border/40 bg-foreground/[0.04] text-foreground/85'
                    : 'border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {resultText}
              </pre>
            </div>
          )}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {!pretty?.isJson && resultTooLong && (
              <>
                <span>结果过长（{resultLength} 字符）</span>
                <button onClick={() => setShowFullResult((v) => !v)} className="text-primary hover:underline">
                  {showFullResult ? '收起' : '展开全部'}
                </button>
                <button onClick={handleCopyResult} className="text-primary hover:underline">
                  复制完整结果
                </button>
              </>
            )}
            <button
              onClick={() => setExpanded(false)}
              className="ml-auto inline-flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <ChevronRight className="h-3 w-3 rotate-90" />
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

interface InlineToolCallBubbleProps {
  toolCall: ToolCall
  /** 同一组连续工具调用（父组件把相邻的 tool_call 聚合成组传入）。 */
  siblings?: ToolCall[]
}

/**
 * 折叠时选择可见行：优先保留失败行（用户最需要排查的），其余按执行
 * 顺序取前 N 个。
 */
function pickVisibleRows(group: ToolCall[], count: number): ToolCall[] {
  const failed = group.filter((tc) => tc.success === false)
  const rest = group.filter((tc) => tc.success !== false)
  const picked = new Set([...failed.slice(0, count), ...rest].slice(0, count))
  // 保持原有执行顺序
  return group.filter((tc) => picked.has(tc))
}

/**
 * InlineToolCallBubble — 连续工具调用的折叠堆叠组。
 *
 * 学习 ZCode/Codex 的 transcript 模式：相邻的已完成工具调用合并进一个
 * 视觉容器（左侧竖线 + 每行一条紧凑摘要 + 默认只显示前 VISIBLE_ROWS 行），
 * 其余折叠为「还有 N 个工具调用」；任意一行可单独展开参数/结果。
 * 组内任一行运行中/失败时不折叠（运行态需要始终可见，失败需要被看见）。
 */
export const InlineToolCallBubble = memo(function InlineToolCallBubble({
  toolCall,
  siblings,
}: InlineToolCallBubbleProps) {
  const [showAll, setShowAll] = useState(false)

  const group = useMemo(() => {
    if (!siblings || siblings.length === 0) return [toolCall]
    return siblings
  }, [siblings, toolCall])

  // 折叠条件：组内没有运行中的调用即可折叠。失败/被拒的调用保持为
  // 组内紧凑行（红 ✗ 可见），但不阻止折叠——否则一次大量拒绝会让
  // 整条消息膨胀成数千像素（DSH/ZCode 同样把失败行折进组里）。
  const hasPending = group.some((tc) => tc.success === undefined && !tc.result)
  const collapsible = group.length > VISIBLE_ROWS && !hasPending && !showAll
  // 折叠时优先展示失败行（用户最需要看到的），其余按执行顺序。
  const visible = collapsible ? pickVisibleRows(group, VISIBLE_ROWS) : group
  const hiddenCount = group.length - visible.length
  const hiddenFailures = collapsible
    ? group.filter((tc) => tc.success === false && !visible.includes(tc)).length
    : 0
  const inGroup = group.length > 1

  if (group.length === 1) {
    return <ToolRow toolCall={group[0]} inGroup={false} />
  }

  return (
    <div
      className={cn(
        'chat-tool-call-group w-full min-w-0 py-0.5',
        'rounded-xl border border-border/40 bg-foreground/[0.02]',
      )}
      data-tool-call={toolCall.call_id}
    >
      <div className="space-y-0.5 p-1">
        {visible.map((tc) => (
          <ToolRow key={tc.call_id} toolCall={tc} inGroup={inGroup} />
        ))}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex w-full items-center gap-2 rounded-b-xl px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-[var(--cx-ghost-hover)] hover:text-foreground"
        >
          <ChevronRight className="h-3 w-3" />
          还有 {hiddenCount} 个工具调用{hiddenFailures > 0 ? `（${hiddenFailures} 个失败）` : ''}
        </button>
      )}
      {showAll && group.length > VISIBLE_ROWS && !hasPending && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="flex w-full items-center gap-2 rounded-b-xl px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-[var(--cx-ghost-hover)] hover:text-foreground"
        >
          <ChevronRight className="h-3 w-3 rotate-90" />
          收起工具调用
        </button>
      )}
    </div>
  )
})
