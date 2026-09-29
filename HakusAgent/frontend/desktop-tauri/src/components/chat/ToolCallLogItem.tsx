import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Copy,
  CheckCheck,
  Terminal,
  FileText,
  FolderTree,
  Search,
  Globe,
  Wrench,
  ExternalLink,
  GitBranch,
  MessageSquarePlus,
  Send,
  ArrowRightLeft,
} from 'lucide-react'
import type { ToolCall } from '@/api/types'
import { cn, copyToClipboard } from '@/lib/utils'

export interface ToolCallLogItemProps {
  toolCall: ToolCall
  /** When true, renders as a self-contained bubble with left margin (inline mode). */
  standalone?: boolean
}

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

const RESULT_PREVIEW_CHARS = 500
const RESULT_DISPLAY_CHARS = 1200

function toolIcon(name: string) {
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

function formatLogTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function ToolCallLogItem({ toolCall, standalone = false }: ToolCallLogItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [showFullResult, setShowFullResult] = useState(false)
  const [copiedResult, setCopiedResult] = useState(false)
  const [copiedArgs, setCopiedArgs] = useState(false)
  const success = toolCall.success !== false
  const summary = describeToolCall(toolCall)
  const args = toolCall.arguments ?? {}
  const hasDetails = Object.keys(args).length > 0 || !!toolCall.result
  const resultLength = toolCall.result?.length ?? 0
  const resultTooLong = resultLength > RESULT_PREVIEW_CHARS
  const shouldCollapse = hasDetails && !expanded

  const handleCopyResult = async () => {
    const text = toolCall.result || ''
    if (await copyToClipboard(text)) {
      setCopiedResult(true)
      setTimeout(() => setCopiedResult(false), 1500)
    }
  }

  const handleCopyArgs = async () => {
    const text = JSON.stringify(args, null, 2)
    if (await copyToClipboard(text)) {
      setCopiedArgs(true)
      setTimeout(() => setCopiedArgs(false), 1500)
    }
  }

  const handleOpenFullResult = () => {
    if (!toolCall.result) return
    const blob = new Blob([toolCall.result], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  const header = (
    <div className="flex items-center gap-2">
      <span className={cn('font-medium', success ? 'text-primary' : 'text-destructive')}>
        {summary.title}
      </span>
      {summary.detail && (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {summary.detail}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatLogTime(toolCall.started_at)}
        </span>
        {toolCall.duration !== undefined && toolCall.duration > 0 && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            · {toolCall.duration.toFixed(2)}s
          </span>
        )}
        {success ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <X className="h-3 w-3 text-destructive" />
        )}
      </span>
    </div>
  )

  const preview = shouldCollapse && hasDetails && (
    <div
      onClick={(e) => {
        e.stopPropagation()
        setExpanded(true)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setExpanded(true)
        }
      }}
      className="mt-1 flex w-full cursor-pointer items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
    >
      <ChevronRight className="h-3 w-3" />
      <span className="truncate">
        {toolCall.result
          ? truncate(toolCall.result.replace(/\s+/g, ' '), 120)
          : `${Object.keys(args).length} 个参数`}
      </span>
    </div>
  )

  const details = expanded && hasDetails && (
    <div className="mt-2 space-y-2">
      {Object.keys(args).length > 0 && (
        <div className="relative">
          <button
            onClick={handleCopyArgs}
            className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
            title="复制参数"
          >
            {copiedArgs ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
            {copiedArgs ? '已复制' : '复制'}
          </button>
          <pre className="tool-log-pre max-h-[180px] overflow-auto rounded-md bg-muted/40 p-2 text-[10px] text-foreground/80">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
      {toolCall.result && (
        <div className="relative">
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
            {resultTooLong && (
              <button
                onClick={handleOpenFullResult}
                className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
                title="查看完整日志"
              >
                <ExternalLink className="h-2.5 w-2.5" />
                查看完整日志
              </button>
            )}
            <button
              onClick={handleCopyResult}
              className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
              title="复制结果"
            >
              {copiedResult ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
              {copiedResult ? '已复制' : '复制'}
            </button>
          </div>
          <pre
            className={cn(
              'tool-log-pre max-h-[260px] overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap',
              success ? 'bg-muted/40 text-foreground/90' : 'bg-destructive/10 text-destructive',
            )}
          >
            {showFullResult
              ? toolCall.result
              : truncate(toolCall.result, RESULT_DISPLAY_CHARS)}
          </pre>
        </div>
      )}
      {resultTooLong && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>结果过长 ({resultLength} 字符)</span>
          <button
            onClick={() => setShowFullResult(!showFullResult)}
            className="text-primary hover:underline"
          >
            {showFullResult ? '收起' : `展开全部`}
          </button>
          <button onClick={handleCopyResult} className="text-primary hover:underline">
            复制完整结果
          </button>
          <button onClick={handleOpenFullResult} className="text-primary hover:underline">
            新窗口打开
          </button>
        </div>
      )}
      <button
        onClick={() => setExpanded(false)}
        className="flex items-center gap-1 text-[11px] text-primary hover:underline"
      >
        <ChevronDown className="h-3 w-3" />
        折叠
      </button>
    </div>
  )

  if (standalone) {
    // Compact inline card. The whole header row is clickable to expand/collapse,
    // and the collapsed state is a single tight line (~28px) so multiple
    // finished tool calls don't eat vertical space between text bubbles.
    return (
      <div
        className={cn(
          'group w-full min-w-0 max-w-full overflow-hidden rounded-md text-xs transition-colors',
          success
            ? 'bg-muted/40 hover:bg-muted/60'
            : 'bg-destructive/5 hover:bg-destructive/10',
        )}
      >
        <div
          role="button"
          tabIndex={hasDetails ? 0 : -1}
          onClick={() => hasDetails && setExpanded(!expanded)}
          onKeyDown={(e) => {
            if (hasDetails && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              setExpanded(!expanded)
            }
          }}
          className={cn(
            'flex w-full min-w-0 items-center gap-1.5 overflow-hidden px-2.5 py-1 text-left',
            hasDetails ? 'cursor-pointer' : 'cursor-default',
          )}
        >
          <span
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center',
              success ? 'text-primary' : 'text-destructive',
            )}
          >
            {toolIcon(toolCall.name)}
          </span>
          <span className={cn('shrink-0 font-medium', success ? 'text-primary' : 'text-destructive')}>
            {summary.title}
          </span>
          {summary.detail && (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {summary.detail}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {toolCall.duration !== undefined && toolCall.duration > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {toolCall.duration.toFixed(2)}s
              </span>
            )}
            {success ? (
              <Check className="h-3 w-3 text-emerald-500" />
            ) : (
              <X className="h-3 w-3 text-destructive" />
            )}
            {hasDetails && (
              <ChevronRight
                className={cn(
                  'h-3 w-3 text-muted-foreground transition-transform',
                  expanded && 'rotate-90',
                )}
              />
            )}
          </span>
        </div>
        {expanded && hasDetails && (
          <div className="space-y-2 px-2.5 pb-2.5 pt-0">
            {Object.keys(args).length > 0 && (
              <div className="relative">
                <button
                  onClick={handleCopyArgs}
                  className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
                  title="复制参数"
                >
                  {copiedArgs ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                  {copiedArgs ? '已复制' : '复制'}
                </button>
                <pre className="tool-log-pre max-h-[180px] overflow-auto rounded-md bg-muted/40 p-2 text-[10px] text-foreground/80">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>
            )}
            {toolCall.result && (
              <div className="relative">
                <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
                  {resultTooLong && (
                    <button
                      onClick={handleOpenFullResult}
                      className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
                      title="查看完整日志"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                      完整日志
                    </button>
                  )}
                  <button
                    onClick={handleCopyResult}
                    className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
                    title="复制结果"
                  >
                    {copiedResult ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                    {copiedResult ? '已复制' : '复制'}
                  </button>
                </div>
                <pre
                  className={cn(
                    'tool-log-pre max-h-[260px] overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap',
                    success ? 'bg-muted/40 text-foreground/90' : 'bg-destructive/10 text-destructive',
                  )}
                >
                  {showFullResult
                    ? toolCall.result
                    : truncate(toolCall.result, RESULT_DISPLAY_CHARS)}
                </pre>
              </div>
            )}
            {resultTooLong && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>结果过长 ({resultLength} 字符)</span>
                <button
                  onClick={() => setShowFullResult(!showFullResult)}
                  className="text-primary hover:underline"
                >
                  {showFullResult ? '收起' : `展开全部`}
                </button>
                <button onClick={handleCopyResult} className="text-primary hover:underline">
                  复制完整结果
                </button>
                <button
                  onClick={() => setExpanded(false)}
                  className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className="h-3 w-3" />
                  折叠
                </button>
              </div>
            )}
            {!resultTooLong && (
              <button
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className="h-3 w-3" />
                折叠
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="group border-b border-border/40 last:border-b-0">
      <div
        role="button"
        tabIndex={hasDetails ? 0 : -1}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--cx-ghost-hover)]',
          !hasDetails && 'cursor-default',
        )}
        onClick={() => hasDetails && setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (hasDetails && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setExpanded(!expanded)
          }
        }}
      >
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
            success ? 'bg-primary/15 text-primary' : 'bg-destructive/15 text-destructive',
          )}
        >
          {toolIcon(toolCall.name)}
        </span>
        <div className="min-w-0 flex-1">
          {header}
          {preview}
        </div>
      </div>
      {details}
    </div>
  )
}
