/**
 * ContextUsageMeter — 上下文计量圈圈 + 点击展开的「用量明细」面板。
 *
 * 圆圈本身可点击，展开一个下拉面板，展示：
 *   - 上下文窗口占比条（used / total，按 50%/80% 阈值变色）
 *   - 本会话累计 token 明细：输入 / 输出 / 缓存命中 / 缓存未命中
 *   - 按轮次（assistant 消息）分解的 token 列表
 *
 * 数据全部来自前端已有的 ChatMessage 元数据（input/output/cache tokens），
 * 不发网络请求；无会话或无用量时显示空态提示。
 */
import { useMemo } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ContextRing } from '@/components/ui/context-ring'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import type { ChatMessage } from '@/api/types'

interface ContextUsageMeterProps {
  used: number
  total: number | null | undefined
  messages: ChatMessage[]
  disabled?: boolean
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function ContextUsageMeter({ used, total, messages, disabled }: ContextUsageMeterProps) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)

  const turns = useMemo(
    () =>
      messages
        .filter((m) => m.role === 'assistant' && (m.input_tokens || m.output_tokens))
        .map((m) => ({
          id: m.id,
          in: m.input_tokens || 0,
          out: m.output_tokens || 0,
          cacheHit: m.cache_hit_tokens || 0,
          cacheMiss: m.cache_miss_tokens || 0,
        })),
    [messages],
  )

  const totals = useMemo(
    () =>
      turns.reduce(
        (acc, t) => ({
          in: acc.in + t.in,
          out: acc.out + t.out,
          cacheHit: acc.cacheHit + t.cacheHit,
          cacheMiss: acc.cacheMiss + t.cacheMiss,
        }),
        { in: 0, out: 0, cacheHit: 0, cacheMiss: 0 },
      ),
    [turns],
  )

  const hasTotal = typeof total === 'number' && total > 0
  const pct = hasTotal ? Math.min(1, used / (total as number)) : 0
  const barColor = !hasTotal
    ? 'bg-muted-foreground/40'
    : pct >= 0.8
      ? 'bg-destructive'
      : pct >= 0.5
        ? 'bg-[hsl(38_92%_50%)]'
        : 'bg-[hsl(142_71%_45%)]'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors hover:bg-[var(--cx-ghost-hover)]"
          title={copy('上下文用量明细', 'Context usage breakdown')}
          aria-label={copy('上下文用量明细', 'Context usage breakdown')}
          onClick={(e) => {
            // Open the full usage cost page in the right panel.
            e.preventDefault()
            void import('@/store/app').then(({ useAppStore }) => {
              useAppStore.getState().setRightPanelTab('usage')
            })
          }}
        >
          <ContextRing used={used} total={total} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-[300px] p-3">
        <div className="mb-2 text-xs font-medium">{copy('上下文窗口', 'Context window')}</div>
        <div className="mb-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
            <div
              className={cn('h-full rounded-full transition-all duration-300', barColor)}
              style={{ width: hasTotal ? `${Math.max(2, pct * 100)}%` : '0%' }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>{hasTotal ? `${Math.round(pct * 100)}%` : copy('窗口未知', 'window unknown')}</span>
            <span>
              {fmtTokens(used)}
              {hasTotal ? ` / ${fmtTokens(total as number)}` : ''}
            </span>
          </div>
        </div>

        {turns.length === 0 ? (
          <div className="py-2 text-center text-xs text-muted-foreground">
            {copy('本轮暂无 token 用量数据', 'No token usage recorded yet')}
          </div>
        ) : (
          <>
            <div className="mb-1.5 grid grid-cols-4 gap-1 border-t border-border/60 pt-2 text-[11px]">
              <div>
                <div className="text-muted-foreground">{copy('输入', 'Input')}</div>
                <div className="font-medium tabular-nums">{fmtTokens(totals.in)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{copy('输出', 'Output')}</div>
                <div className="font-medium tabular-nums">{fmtTokens(totals.out)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{copy('缓存命中', 'Cache hit')}</div>
                <div className="font-medium tabular-nums">{fmtTokens(totals.cacheHit)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{copy('缓存未命中', 'Cache miss')}</div>
                <div className="font-medium tabular-nums">{fmtTokens(totals.cacheMiss)}</div>
              </div>
            </div>
            <div className="max-h-[180px] overflow-y-auto border-t border-border/60 pt-2">
              {turns
                .slice()
                .reverse()
                .map((t, i) => (
                  <div key={t.id} className="flex items-center justify-between py-1 text-[11px] text-muted-foreground">
                    <span>
                      {copy('第', 'Turn')} {turns.length - i} {copy('轮', '')}
                    </span>
                    <span className="tabular-nums">
                      {fmtTokens(t.in)} ↑ · {fmtTokens(t.out)} ↓
                      {t.cacheHit > 0 && ` · ${copy('缓存', 'cache')} ${fmtTokens(t.cacheHit)}`}
                    </span>
                  </div>
                ))}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
