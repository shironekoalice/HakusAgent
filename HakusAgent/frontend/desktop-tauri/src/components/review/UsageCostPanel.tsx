/**
 * Usage / cost breakdown panel.
 */

import { useEffect } from 'react'
import { Coins, DollarSign, Gauge, Layers, RefreshCw } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { useReviewStore } from '@/store/review'
import { formatTokens, formatUsd } from '@/lib/pricing'
import type { ChatMessage } from '@/api/types'
import {
  RpBody,
  RpEmpty,
  RpFooter,
  RpHeader,
  RpIconButton,
  RpSection,
  RpShell,
  RpStat,
  useRpCopy,
} from './PanelChrome'

const EMPTY_MESSAGES: ChatMessage[] = []

const BAR_PALETTE = [
  'hsl(var(--primary))',
  '#22d3ee',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#34d399',
]

export function UsageCostPanel() {
  const copy = useRpCopy()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messagesMap = useSessionStore((s) => s.messages)
  const messages = (activeSessionId && messagesMap[activeSessionId]) || EMPTY_MESSAGES
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const modelInfo = useSettingsStore((s) => (s as any).model)
  const modelKey =
    typeof defaultModel === 'string'
      ? defaultModel
      : (defaultModel as any)?.model_name || modelInfo?.model_name || 'unknown'
  const breakdown = useReviewStore((s) => s.usageBreakdown)
  const runtimeUsage = useReviewStore((s) => s.runtimeUsage)
  const usageLoading = useReviewStore((s) => s.usageLoading)
  const computeUsage = useReviewStore((s) => s.computeUsage)
  const loadRuntimeUsage = useReviewStore((s) => s.loadRuntimeUsage)

  useEffect(() => {
    computeUsage(messages, modelKey)
  }, [messages, modelKey, computeUsage])

  const refresh = () => {
    computeUsage(messages, modelKey)
    void loadRuntimeUsage()
  }

  const totals = breakdown?.totals
  const byModel = breakdown?.by_model || []
  const turns = breakdown?.turns || []

  return (
    <RpShell>
      <RpHeader
        icon={Coins}
        title={copy('本次会话用量', 'Usage in this chat')}
        meta={totals ? `${totals.turn_count} ${copy('轮', 'turns')} · ${formatUsd(totals.cost_usd)}` : copy('暂无', '—')}
        actions={<RpIconButton icon={RefreshCw} title={copy('刷新', 'Refresh')} onClick={refresh} disabled={usageLoading} />}
      />

      <RpBody>
        {!totals ? (
          <RpEmpty
            icon={Coins}
            title={copy('暂无用量数据', 'Not available')}
            desc={copy('发送消息后，这里会显示 token 与费用明细。', 'Token and cost details appear after you send messages.')}
          />
        ) : (
          <>
            <RpSection label={copy('概览', 'Overview')} icon={Gauge}>
              <div className="rp-stats">
                <RpStat
                  icon={DollarSign}
                  label={copy('预估费用', 'Est. cost')}
                  value={formatUsd(totals.cost_usd)}
                  sub={copy('按本地价目表', 'From local pricing')}
                />
                <RpStat
                  icon={Layers}
                  label={copy('Tokens', 'Tokens')}
                  value={`${formatTokens(totals.input_tokens)} / ${formatTokens(totals.output_tokens)}`}
                  sub={copy('输入 / 输出', 'Input / output')}
                />
                <RpStat
                  label={copy('缓存命中', 'Cached input')}
                  value={formatTokens(totals.cache_hit_tokens)}
                  sub={copy('KV cache hit', 'KV cache hit')}
                />
                <RpStat
                  label={copy('缓存未命中', 'Uncached')}
                  value={formatTokens(totals.cache_miss_tokens)}
                  sub={copy('首次读取', 'First read')}
                />
              </div>
            </RpSection>

            <RpSection label={copy('模型份额', 'Models')} icon={Layers}>
              {byModel.length === 0 ? (
                <div className="rp-card text-[11px] text-muted-foreground">{copy('暂无数据', 'Not available')}</div>
              ) : (
                <div className="rp-card">
                  <div className="rp-bar" role="img" aria-label={copy('模型份额', 'Model share')}>
                    {byModel.map((s, i) => (
                      <span
                        key={s.key}
                        style={{
                          flexGrow: Math.max(s.share_pct, 1),
                          backgroundColor: BAR_PALETTE[i % BAR_PALETTE.length],
                        }}
                        title={`${s.label} ${s.share_pct}%`}
                      />
                    ))}
                  </div>
                  <div className="rp-legend">
                    {byModel.map((m, i) => (
                      <span key={m.key} className="rp-legend-item">
                        <span className="rp-legend-dot" style={{ backgroundColor: BAR_PALETTE[i % BAR_PALETTE.length] }} />
                        <span className="max-w-[8.5rem] truncate">{m.label}</span>
                        <span className="tabular-nums text-foreground/70">{m.share_pct}%</span>
                        <span className="tabular-nums">{formatUsd(m.cost_usd)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </RpSection>

            <RpSection label={copy('逐轮明细', 'Turns')} icon={Coins}>
              {turns.length === 0 ? (
                <div className="rp-card text-[11px] text-muted-foreground">{copy('暂无轮次', 'No turns yet')}</div>
              ) : (
                <div className="space-y-1">
                  {turns.map((t) => (
                    <div key={`${t.index}-${t.timestamp}`} className="rp-card rp-card-tight flex items-center gap-2">
                      <span className="w-6 shrink-0 font-mono text-[10px] text-muted-foreground">#{t.index}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {formatTokens(t.input_tokens)} → {formatTokens(t.output_tokens)}
                        {t.cache_hit_tokens > 0 ? (
                          <span className="ml-1 text-emerald-600/85 dark:text-emerald-400/85">
                            c{formatTokens(t.cache_hit_tokens)}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums">{formatUsd(t.cost_usd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </RpSection>
          </>
        )}
      </RpBody>

      <RpFooter>
        <span>
          {copy('费用为本地估算，可能与供应商账单有差异。', 'Spend is approximate and may differ from provider billing.')}
        </span>
        {runtimeUsage != null ? <span>{copy('Runtime 已连接', 'Runtime live')}</span> : null}
      </RpFooter>
    </RpShell>
  )
}
