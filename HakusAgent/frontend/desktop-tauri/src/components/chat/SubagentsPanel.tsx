/**
 * SubagentsPanel — 「子代理」悬浮按钮 + 状态卡片流。
 *
 * 从会话事件日志（apiClient.getSessionLog）归纳子代理活动：
 *   - `subagent_spawned` 事件（Python sidecar / Deep 模式编排器）
 *   - 名为 `task` / `spawn_*` 的工具调用（Rust Runtime 将子代理
 *     作为工具项下发：started → running，finished → done/failed）
 *
 * 每张卡片：任务摘要 + agent id + 状态徽标（running/done/failed）。
 * 面板打开时拉取一次日志；无子代理活动时显示空态。
 */
import { useCallback, useEffect, useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { apiClient } from '@/api/client'
import type { SessionLogEvent } from '@/api/types'

interface SubagentsPanelProps {
  sessionId?: string
}

interface SubagentCard {
  key: string
  task: string
  agentId: string
  status: 'running' | 'done' | 'failed'
  turn: number
}

/** 工具名前缀/全名匹配，判定一个工具调用是否代表子代理派生。 */
function isSpawnTool(name: string): boolean {
  const n = (name || '').toLowerCase()
  return n === 'task' || n.startsWith('spawn') || n.includes('subagent')
}

function fmtTask(text: unknown): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '')
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean || '(无任务描述)'
}

export function SubagentsPanel({ sessionId }: SubagentsPanelProps) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cards, setCards] = useState<SubagentCard[]>([])
  const [error, setError] = useState('')

  const fetchCards = useCallback(async () => {
    if (!sessionId) {
      setCards([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const log = await apiClient.getSessionLog(sessionId)
      const events: SessionLogEvent[] = log.events || []
      const map = new Map<string, SubagentCard>()

      for (const ev of events) {
        if (ev.type === 'subagent_spawned') {
          const id = String(ev.sub_agent_id || ev.call_id || `turn${ev.turn}`)
          map.set(id, {
            key: id,
            task: fmtTask(ev.task),
            agentId: id,
            status: 'running',
            turn: ev.turn ?? 0,
          })
          continue
        }
        if ((ev.type === 'tool_call_started' || ev.type === 'tool_call_finished') && isSpawnTool(String(ev.name || ''))) {
          const id = String(ev.call_id || ev.sub_agent_id || `t${ev.ts}`)
          const prev = map.get(id)
          const task = fmtTask(ev.task ?? ev.arguments?.task ?? ev.arguments?.prompt ?? ev.arguments)
          map.set(id, {
            key: id,
            task: task !== '(无任务描述)' ? task : prev?.task || task,
            agentId: String(ev.sub_agent_id || prev?.agentId || id),
            status: ev.type === 'tool_call_finished' ? (ev.success === false ? 'failed' : 'done') : 'running',
            turn: ev.turn ?? 0,
          })
        }
      }

      // 旧事件（上一轮的 running 卡）收敛为 done，避免长期显示 running。
      const list = Array.from(map.values()).map((c) =>
        c.status === 'running' ? { ...c, status: 'done' as const } : c,
      )
      list.sort((a, b) => a.turn - b.turn)
      setCards(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (open) void fetchCards()
  }, [open, fetchCards])

  if (!sessionId) return null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={copy('子代理', 'Subagents')}
          aria-label={copy('子代理', 'Subagents')}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/80 text-foreground/80 shadow-sm backdrop-blur-md transition-colors',
            'hover:bg-[var(--cx-ghost-hover)] hover:text-foreground active:scale-95',
          )}
        >
          <Bot className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-[340px] p-1.5">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">{copy('子代理活动', 'Subagent activity')}</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {error && (
            <div className="px-2 py-3 text-center text-xs text-destructive">{error}</div>
          )}
          {!error && cards.length === 0 && !loading && (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {copy('本会话暂无子代理活动', 'No subagent activity in this session')}
            </div>
          )}
          {cards.map((c) => (
            <div
              key={c.key}
              className="flex items-start gap-2 rounded-lg border border-border/50 px-2.5 py-2"
            >
              <span
                className={cn(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                  c.status === 'running' && 'animate-pulse bg-[hsl(38_92%_50%)]',
                  c.status === 'done' && 'bg-[hsl(142_71%_45%)]',
                  c.status === 'failed' && 'bg-destructive',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground/90">{c.task}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-mono">{c.agentId}</span>
                  <span>
                    {c.status === 'running'
                      ? copy('运行中', 'running')
                      : c.status === 'done'
                        ? copy('已完成', 'done')
                        : copy('失败', 'failed')}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
