import { useEffect, useState, useCallback } from 'react'
import { ScrollText, RefreshCw, Trash2, Loader2, ChevronDown, ChevronRight, Wrench, MessageSquare, Zap, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'
import { apiClient } from '@/api/client'
import type { SessionLogEvent, SessionLogStats } from '@/api/types'
import { useSessionStore } from '@/store/session'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

/**
 * SessionLogTab — append-only JSONL event stream viewer.
 *
 * Shows the DeepSeek-Harness-style session log: every turn_start,
 * text_delta, tool_call_started/finished, token_usage, turn_completed/
 * failed/cancelled event. The log lives at
 * ~/.hakus/sessions/<id>/session_log.jsonl and auto-compacts at 5MB.
 *
 * Features:
 *  - Grouped by turn (collapsible)
 *  - Color-coded by event type
 *  - Tool call durations + result previews
 *  - Manual compaction + clear buttons
 *  - Auto-refresh while streaming
 */
export function SessionLogTab() {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const activeId = useSessionStore((s) => s.activeSessionId)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const [events, setEvents] = useState<SessionLogEvent[]>([])
  const [stats, setStats] = useState<SessionLogStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set())
  const [showArchived, setShowArchived] = useState(false)

  const fetchLog = useCallback(async () => {
    if (!activeId) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiClient.getSessionLog(activeId, { limit: 500 })
      setEvents(res.events)
      setStats(res.stats)
    } catch (e: any) {
      setError(e?.message || 'Failed to load session log')
    } finally {
      setLoading(false)
    }
  }, [activeId])

  // Initial load + refresh when session changes
  useEffect(() => {
    fetchLog()
  }, [fetchLog])

  // Auto-refresh every 2s while streaming
  useEffect(() => {
    if (!isStreaming) return
    const interval = setInterval(fetchLog, 2000)
    return () => clearInterval(interval)
  }, [isStreaming, fetchLog])

  const handleCompact = async () => {
    if (!activeId) return
    try {
      await apiClient.compactSessionLog(activeId)
      fetchLog()
    } catch (e: any) {
      setError(e?.message || 'Compaction failed')
    }
  }

  const handleClear = async () => {
    if (!activeId) return
    if (!confirm(copy('清空 session log? 这个操作不可撤销 (但不影响聊天记录).', 'Clear the session log? This cannot be undone (chat history is kept).'))) return
    try {
      await apiClient.clearSessionLog(activeId)
      fetchLog()
    } catch (e: any) {
      setError(e?.message || 'Clear failed')
    }
  }

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }

  if (!activeId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
        <ScrollText className="h-7 w-7 text-muted-foreground/40" />
        <p className="font-medium">{copy('会话日志', 'Session log')}</p>
        <p className="text-[11px]">{copy('选择一个会话查看 append-only 事件流', 'Select a conversation to view its append-only event stream')}</p>
      </div>
    )
  }

  // Group events by turn
  const turns = new Map<number, SessionLogEvent[]>()
  for (const ev of events) {
    const t = ev.turn || 0
    if (!turns.has(t)) turns.set(t, [])
    turns.get(t)!.push(ev)
  }
  const sortedTurns = Array.from(turns.keys()).sort((a, b) => a - b)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <ScrollText className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">Session Log</span>
          {stats && (
            <span className="text-muted-foreground">
              · {stats.event_count} events · {(stats.live_size_bytes / 1024).toFixed(1)} KB
              {stats.archive_size_bytes > 0 && ` + ${(stats.archive_size_bytes / 1024).toFixed(1)} KB archived`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchLog}
            disabled={loading}
            title={copy('刷新', 'Refresh')}
            className="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <button
            onClick={handleCompact}
            disabled={loading || !stats?.live_size_bytes}
            title={copy('压缩 (归档最旧的 50%)', 'Compact (archive the oldest 50%)')}
            className="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleClear}
            disabled={loading}
            title={copy('清空日志', 'Clear log')}
            className="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>turn: <span className="font-mono text-foreground">{stats.current_turn}</span></span>
          <span>·</span>
          <span>log: <span className="font-mono text-foreground">{stats.log_path}</span></span>
          {stats.archive_size_bytes > 0 && (
            <>
              <span>·</span>
              <span>archive: <span className="font-mono text-foreground">{stats.archive_path}</span></span>
            </>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      )}

      {/* Events list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <ScrollText className="h-7 w-7 text-muted-foreground/40" />
            <p className="font-medium">{copy('暂无事件', 'No events yet')}</p>
            <p className="text-[11px]">{copy('发条消息开始，每个 turn 的事件都会被记录', 'Send a message to record events for each turn')}</p>
          </div>
        ) : (
          <div className="py-2">
            {sortedTurns.map((turn) => {
              const turnEvents = turns.get(turn) || []
              const collapsed = collapsedTurns.has(turn)
              const turnStart = turnEvents.find((e) => e.type === 'turn_start')
              const hasError = turnEvents.some((e) => e.type === 'turn_failed')
              const isCancelled = turnEvents.some((e) => e.type === 'cancelled')
              return (
                <div key={turn} className="border-b border-border/30 last:border-0">
                  <button
                    onClick={() => toggleTurn(turn)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-foreground/[0.03]"
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="font-mono font-medium text-foreground">Turn {turn}</span>
                    {turnStart?.run_mode && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {turnStart.run_mode}
                      </span>
                    )}
                    {hasError && <XCircle className="h-3 w-3 text-destructive" />}
                    {isCancelled && <AlertCircle className="h-3 w-3 text-amber-500" />}
                    {!hasError && !isCancelled && turnEvents.some((e) => e.type === 'turn_completed') && (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {turnEvents.length} events
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="liquid-glass-disclosure mx-2 mb-2 px-3 pb-2 pl-8">
                      {turnEvents.map((ev, i) => (
                        <EventRow key={i} event={ev} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Event row renderer ──────────────────────────────────────────────

function EventRow({ event }: { event: SessionLogEvent }) {
  const icon = getEventIcon(event.type)
  const color = getEventColor(event.type)
  const ts = new Date((event.ts || 0) * 1000).toLocaleTimeString('zh-CN', { hour12: false })

  return (
    <div className="flex items-start gap-2 py-0.5 text-[11px]">
      <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">{ts}</span>
      <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center', color)}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 break-words font-mono text-foreground/90">
        <EventContent event={event} />
      </span>
    </div>
  )
}

function EventContent({ event }: { event: SessionLogEvent }) {
  switch (event.type) {
    case 'turn_start':
      return (
        <span>
          <span className="text-primary">turn_start</span>
          {event.run_mode && ` mode=${event.run_mode}`}
          {event.provider && ` provider=${event.provider}`}
          {event.model && ` model=${event.model}`}
          {event.user_message && (
            <span className="text-muted-foreground"> · "{event.user_message.slice(0, 80)}{event.user_message.length > 80 ? '…' : ''}"</span>
          )}
        </span>
      )
    case 'text_delta':
      return (
        <span className="text-foreground/70">
          +{event.text?.length || 0} chars
          {event.text && (
            <span className="text-muted-foreground"> "{event.text.slice(0, 40)}{event.text.length > 40 ? '…' : ''}"</span>
          )}
        </span>
      )
    case 'reasoning':
      return <span className="text-violet-600">reasoning +{event.text?.length || 0}</span>
    case 'tool_call_started':
      return (
        <span>
          <span className="text-primary">→ {event.name}</span>
          {event.arguments && Object.keys(event.arguments).length > 0 && (
            <span className="text-muted-foreground"> {JSON.stringify(event.arguments).slice(0, 100)}</span>
          )}
        </span>
      )
    case 'tool_call_finished':
      return (
        <span>
          <span className={event.success ? 'text-emerald-600' : 'text-destructive'}>
            ← {event.name} ({(event.duration_ms || 0).toFixed(0)}ms)
          </span>
          {event.result_preview && (
            <span className="text-muted-foreground">
              {' '}{event.result_preview.slice(0, 80)}
              {event.result_truncated ? '…' : ''}
            </span>
          )}
          {event.error && <span className="text-destructive"> err: {event.error}</span>}
        </span>
      )
    case 'token_usage':
      return (
        <span className="text-muted-foreground">
          tokens: in={event.input_tokens || 0} out={event.output_tokens || 0}
          {(event.cache_hit_tokens || 0) > 0 && ` cache_hit=${event.cache_hit_tokens}`}
        </span>
      )
    case 'turn_completed':
      return (
        <span className="text-emerald-600">
          turn_completed ({event.input_tokens || 0}+{event.output_tokens || 0} tokens)
        </span>
      )
    case 'turn_failed':
      return (
        <span className="text-destructive">
          turn_failed: {event.error} {event.code && `(${event.code})`}
        </span>
      )
    case 'cancelled':
      return <span className="text-amber-600">cancelled: {event.reason}</span>
    case 'compacted':
      return (
        <span className="text-muted-foreground">
          compacted: archived {event.events_archived} events → {event.archive_path}
        </span>
      )
    case 'subagent_spawned':
      return (
        <span className="text-violet-600">
          subagent: {event.sub_agent_id} task="{event.task?.slice(0, 60)}"
        </span>
      )
    default:
      return <span className="text-muted-foreground">{event.type}</span>
  }
}

function getEventIcon(type: string) {
  switch (type) {
    case 'turn_start':
    case 'turn_completed':
      return <MessageSquare className="h-3 w-3" />
    case 'text_delta':
      return <span className="text-[9px]">T</span>
    case 'reasoning':
      return <span className="text-[9px]">R</span>
    case 'tool_call_started':
    case 'tool_call_finished':
      return <Wrench className="h-3 w-3" />
    case 'token_usage':
      return <Zap className="h-3 w-3" />
    case 'turn_failed':
      return <XCircle className="h-3 w-3" />
    case 'cancelled':
      return <AlertCircle className="h-3 w-3" />
    case 'compacted':
      return <ChevronDown className="h-3 w-3" />
    case 'subagent_spawned':
      return <span className="text-[9px]">S</span>
    default:
      return <span className="text-[9px]">·</span>
  }
}

function getEventColor(type: string) {
  switch (type) {
    case 'turn_start':
      return 'text-primary'
    case 'turn_completed':
      return 'text-emerald-600'
    case 'turn_failed':
      return 'text-destructive'
    case 'cancelled':
      return 'text-amber-600'
    case 'tool_call_started':
    case 'tool_call_finished':
      return 'text-primary'
    case 'reasoning':
      return 'text-violet-600'
    default:
      return 'text-muted-foreground'
  }
}
