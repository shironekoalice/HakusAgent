/**
 * Goal side panel chrome.
 */

import { useCallback, useEffect, useState } from 'react'
import { Ban, CheckCircle2, Loader2, Pause, Play, Target, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/store/session'
import { useReviewStore } from '@/store/review'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import type { ThreadGoalStatus } from '@/api/types'
import {
  RpBody,
  RpChip,
  RpEmpty,
  RpFooter,
  RpHeader,
  RpSection,
  RpShell,
  useRpCopy,
} from './PanelChrome'
import { useI18n } from '@/lib/i18n'

const STATUS_TONE: Record<ThreadGoalStatus, 'ok' | 'warn' | 'danger' | 'info' | 'muted'> = {
  active: 'ok',
  paused: 'warn',
  blocked: 'danger',
  usage_limited: 'warn',
  budget_limited: 'warn',
  complete: 'info',
}

function relativeMinutes(ts: number, zh: boolean): string {
  if (!ts) return zh ? '尚未保存' : 'Not saved yet'
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (mins <= 0) return zh ? '刚刚更新' : 'Updated just now'
  return zh ? `${mins} 分钟前更新` : `Updated ${mins} min ago`
}

export function GoalPanel() {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const copy = useRpCopy()
  const toast = useToast()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined
  const threadId = activeSession?.remote_session_id || null

  const goal = useReviewStore((s) => s.goal)
  const goalLoading = useReviewStore((s) => s.goalLoading)
  const goalThreadId = useReviewStore((s) => s.goalThreadId)
  const loadGoal = useReviewStore((s) => s.loadGoal)
  const saveGoal = useReviewStore((s) => s.saveGoal)
  const goalAction = useReviewStore((s) => s.goalAction)
  const deleteGoal = useReviewStore((s) => s.deleteGoal)

  const [draft, setDraft] = useState('')
  const [budget, setBudget] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (goalThreadId === threadId) return
    void loadGoal(threadId)
  }, [threadId, goalThreadId, loadGoal])

  useEffect(() => {
    setDraft(goal?.objective || '')
    setBudget(goal?.token_budget != null ? String(goal.token_budget) : '')
  }, [goal?.objective, goal?.token_budget])

  const savedObjective = goal?.objective || ''
  const dirty = draft.trim() !== savedObjective.trim()
  const canSave = !saving && draft.trim().length > 0 && dirty

  const onSave = useCallback(async () => {
    if (!threadId || !canSave) return
    setSaving(true)
    try {
      const parsedBudget = budget.trim() ? Number(budget.trim()) : null
      await saveGoal(threadId, draft.trim(), Number.isFinite(parsedBudget as number) ? parsedBudget : null)
      toast.success(copy('目标已保存', 'Goal saved'))
    } catch (e: any) {
      toast.error(copy('保存目标失败：', 'Failed to save goal: ') + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }, [threadId, canSave, draft, budget, saveGoal, toast, copy])

  const onRevert = useCallback(() => {
    setDraft(savedObjective)
    setBudget(goal?.token_budget != null ? String(goal.token_budget) : '')
  }, [savedObjective, goal?.token_budget])

  const onAction = async (action: 'pause' | 'resume' | 'complete' | 'block') => {
    if (!threadId) return
    try {
      await goalAction(threadId, action)
      toast.success(copy('目标状态已更新', 'Goal status updated'))
    } catch (e: any) {
      toast.error(copy('操作失败：', 'Action failed: ') + (e?.message || e))
    }
  }

  const onDelete = async () => {
    if (!threadId || !goal) return
    if (!confirm(copy('删除当前目标？', 'Delete the current goal?'))) return
    try {
      await deleteGoal(threadId)
      setDraft('')
      toast.success(copy('目标已删除', 'Goal deleted'))
    } catch (e: any) {
      toast.error(copy('删除失败：', 'Delete failed: ') + (e?.message || e))
    }
  }

  if (!threadId) {
    return (
      <RpShell>
        <RpEmpty
          icon={Target}
          title={copy('目标不可用', 'Goals unavailable')}
          desc={copy(
            '当前会话尚未连接 Runtime 线程。创建对话并发送消息后再试。',
            'This chat is not bound to a Runtime thread yet. Start a chat and send a message first.',
          )}
        />
      </RpShell>
    )
  }

  return (
    <RpShell>
      <RpHeader
        icon={Target}
        title={copy('会话目标', 'Goal')}
        meta={goal ? <RpChip tone={STATUS_TONE[goal.status] || 'muted'}>{goal.status.replace('_', ' ')}</RpChip> : null}
      />

      <RpBody>
        {goalLoading && !goal ? (
          <div className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {copy('加载中...', 'Loading...')}
          </div>
        ) : (
          <>
            <RpSection label={copy('目标描述', 'Objective')}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={copy(
                  '描述这个会话要完成的目标…',
                  'Describe what this conversation should accomplish…',
                )}
                className="rp-textarea"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) void onSave()
                }}
              />
              <div className="mt-2">
                <div className="rp-section-label !mb-1">{copy('Token 预算（可选）', 'Token budget (optional)')}</div>
                <input
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="e.g. 120000"
                  inputMode="numeric"
                  className="rp-input"
                />
              </div>
            </RpSection>

            {goal && (
              <RpSection label={copy('执行状态', 'Execution')}>
                <div className="rp-stats">
                  <div className="rp-stat">
                    <div className="rp-stat-label">{copy('已用 Tokens', 'Tokens used')}</div>
                    <div className="rp-stat-value">{goal.tokens_used || 0}</div>
                  </div>
                  <div className="rp-stat">
                    <div className="rp-stat-label">{copy('预算', 'Budget')}</div>
                    <div className="rp-stat-value">{goal.token_budget ?? '—'}</div>
                  </div>
                  <div className="rp-stat">
                    <div className="rp-stat-label">{copy('续跑', 'Continuations')}</div>
                    <div className="rp-stat-value">{goal.continuation_count || 0}</div>
                  </div>
                  <div className="rp-stat">
                    <div className="rp-stat-label">{copy('耗时', 'Time used')}</div>
                    <div className="rp-stat-value">{Math.round((goal.time_used_seconds || 0) / 60)}m</div>
                  </div>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {goal.status === 'active' ? (
                    <Button size="sm" variant="outline" className="h-7 rounded-lg px-2.5 text-[11px]" onClick={() => void onAction('pause')}>
                      <Pause className="mr-1 h-3 w-3" /> {copy('暂停', 'Pause')}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 rounded-lg px-2.5 text-[11px]" onClick={() => void onAction('resume')}>
                      <Play className="mr-1 h-3 w-3" /> {copy('继续', 'Resume')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7 rounded-lg px-2.5 text-[11px]" onClick={() => void onAction('complete')}>
                    <CheckCircle2 className="mr-1 h-3 w-3" /> {copy('完成', 'Complete')}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 rounded-lg px-2.5 text-[11px]" onClick={() => void onAction('block')}>
                    <Ban className="mr-1 h-3 w-3" /> {copy('受阻', 'Block')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-lg px-2.5 text-[11px] text-destructive"
                    onClick={() => void onDelete()}
                  >
                    <Trash2 className="mr-1 h-3 w-3" /> {copy('删除', 'Delete')}
                  </Button>
                </div>
              </RpSection>
            )}
          </>
        )}
      </RpBody>

      <RpFooter>
        <span>{relativeMinutes(goal?.updated_at || 0, zh)}</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg px-2 text-[11px]"
            disabled={!dirty || saving}
            onClick={onRevert}
          >
            <Undo2 className="mr-1 h-3 w-3" /> {copy('回滚', 'Revert')}
          </Button>
          <Button
            size="sm"
            className={cn('h-7 rounded-lg px-2.5 text-[11px]', !canSave && 'opacity-50')}
            disabled={!canSave}
            onClick={() => void onSave()}
          >
            {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} {copy('保存', 'Save')}
          </Button>
        </div>
      </RpFooter>
    </RpShell>
  )
}
