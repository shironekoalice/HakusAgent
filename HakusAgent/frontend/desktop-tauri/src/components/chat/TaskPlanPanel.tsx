import { useState } from 'react'
import { Check, CheckCircle2, ChevronDown, ChevronUp, Circle, ListTodo } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskProgressAttachment } from '@/api/types'

/**
 * One row of the plan, with its own reported status.
 *
 * The row exists because the two transports disagree: the Rust Runtime sends
 * the whole list in one frame with a status per row, while legacy frames send
 * a growing array of names plus a `completed` count. Normalizing both into rows
 * here keeps the two guesses (prefix-count, `current_task` equality) in one
 * place instead of spread across two renderers.
 */
export interface PlanRow {
  content: string
  status: 'completed' | 'in_progress' | 'pending' | 'cancelled'
}

/**
 * Flatten a progress attachment into rows, preferring per-row status.
 *
 * `items` is authoritative when present — the legacy `tasks` array cannot
 * express a cancelled row, and a cancelled row is not a completed one, so the
 * prefix guess would render a struck-through row the Runtime never finished.
 */
export function planRows(progress: TaskProgressAttachment): PlanRow[] {
  if (progress.items?.length) {
    return progress.items.map((item) => ({
      content: item.content,
      status: normalizeStatus(item.status),
    }))
  }
  const tasks = progress.tasks ?? []
  const completed = Math.max(0, progress.completed || 0)
  return tasks.map((content, index) => {
    if (index < completed) return { content, status: 'completed' as const }
    if (content === progress.current_task) return { content, status: 'in_progress' as const }
    return { content, status: 'pending' as const }
  })
}

function normalizeStatus(status: string): PlanRow['status'] {
  switch (status) {
    case 'completed':
    case 'cancelled':
    case 'in_progress':
    case 'pending':
      return status
    default:
      return 'pending'
  }
}

/**
 * Header summary as `·`-joined per-status counts.
 *
 * Ported from DSH's `TodoPanel.progressLabel`: zero-count segments are dropped
 * so a three-item plan with nothing running reads `3 已完成` rather than
 * `3 已完成 · 0 进行中 · 0 待办`. The counts replace the previous `1/3` plus
 * full-width progress bar, which spent a whole row of height to say what three
 * numbers say inline.
 */
export function planSummary(rows: PlanRow[]): string {
  const count = (status: PlanRow['status']) => rows.filter((row) => row.status === status).length
  const done = count('completed')
  const active = count('in_progress')
  const cancelled = count('cancelled')
  const pending = count('pending')
  const parts: string[] = []
  if (done > 0) parts.push(`${done} 已完成`)
  if (active > 0) parts.push(`${active} 进行中`)
  if (pending > 0) parts.push(`${pending} 待办`)
  if (cancelled > 0) parts.push(`${cancelled} 已取消`)
  return parts.join(' · ')
}

/** The glyph for one row, matching DSH's three-state dot language. */
function RowGlyph({ status }: { status: PlanRow['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" strokeWidth={2} />
  }
  if (status === 'in_progress') {
    return (
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      </span>
    )
  }
  if (status === 'cancelled') {
    return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" strokeWidth={2} />
  }
  return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" strokeWidth={2} />
}

/**
 * The plan strip shown above the composer.
 *
 * Collapsed to a single summary line by default, which is the behaviour ported
 * from DSH's `TodoPanel` (`useState(true)`): the plan is context for what the
 * agent is doing, not the main content, and an expanded list above the input
 * pushes the input down and competes with the transcript. The one-line header
 * still carries the counts, so collapsing loses no information.
 *
 * Renders nothing when there is no plan, so it never occupies space it has not
 * earned.
 */
export function TaskPlanPanel({ progress }: { progress?: TaskProgressAttachment }) {
  const [collapsed, setCollapsed] = useState(true)
  if (!progress) return null

  const rows = planRows(progress)
  if (rows.length === 0) {
    // A frame with a current task but no list still has something to say.
    if (!progress.current_task) return null
    return (
      <section
        className="w-full overflow-hidden rounded-xl border border-border/60 bg-card/80 backdrop-blur"
        aria-label="执行计划"
        data-testid="task-plan-panel"
      >
        <div className="flex items-center gap-2.5 px-3 py-1.5">
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="shrink-0 text-[13px] font-medium text-foreground">执行计划</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {progress.current_task}
          </span>
        </div>
      </section>
    )
  }

  const summary = planSummary(rows)
  const settled = rows.filter((row) => row.status === 'completed' || row.status === 'cancelled').length
  const allSettled = settled === rows.length

  return (
    <section
      className="w-full overflow-hidden rounded-xl border border-border/60 bg-card/80 backdrop-blur"
      aria-label="执行计划"
      data-testid="task-plan-panel"
    >
      <div className="flex flex-col gap-1.5 px-3 py-1.5">
        <button
          type="button"
          className="flex w-full items-center gap-2.5 text-left"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ListTodo
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              allSettled ? 'text-emerald-500' : 'text-muted-foreground',
            )}
            strokeWidth={1.75}
          />
          <span className="shrink-0 text-[13px] font-medium text-foreground">执行计划</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{summary}</span>
          <span className="grid shrink-0 place-items-center text-muted-foreground" aria-hidden>
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
        </button>

        {!collapsed && (
          // Bounded so a long plan cannot push the composer off-screen; the
          // list scrolls instead. DSH caps its expanded list at 180px.
          <ul className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto pl-[22px]">
            {rows.map((row, index) => (
              <li
                key={`${row.content}-${index}`}
                className="flex min-w-0 items-center gap-2.5 text-[13px] leading-5"
                data-status={row.status}
              >
                <RowGlyph status={row.status} />
                <span
                  className={cn(
                    'min-w-0 truncate',
                    row.status === 'completed' && 'text-muted-foreground line-through',
                    row.status === 'cancelled' && 'text-muted-foreground/60 line-through',
                    row.status === 'in_progress' && 'font-medium text-foreground',
                    row.status === 'pending' && 'text-muted-foreground',
                  )}
                  title={row.content}
                >
                  {row.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Compact last-known plan for the transcript, where vertical space is scarce. */
export function TaskPlanReceipt({ progress }: { progress?: TaskProgressAttachment }) {
  const rows = progress ? planRows(progress) : []
  if (!progress || rows.length === 0) return null
  const summary = planSummary(rows)
  const active = rows.find((row) => row.status === 'in_progress')
  return (
    <div
      className="flex w-full items-center gap-2.5 rounded-xl border border-border/50 bg-muted/30 px-3 py-1.5 text-[13px]"
      data-testid="task-plan-receipt"
    >
      <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
      <span className="shrink-0 font-medium text-foreground">执行计划</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {summary}
        {active && ` · ${active.content}`}
      </span>
    </div>
  )
}
