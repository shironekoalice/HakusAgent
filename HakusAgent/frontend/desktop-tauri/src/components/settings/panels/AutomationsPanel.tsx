/**
 * AutomationsPanel — scheduled turns management.
 *
 * Lists automations from the backend scheduler, lets the user create
 * (name / schedule / prompt), pause/resume, run-now, delete, and
 * inspect recent run history. Schedule format: "30m" / "1h" / "@daily"
 * / "@manual".
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Timer,
  Play,
  Pause,
  Zap,
  Trash2,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  Check,
  X,
} from 'lucide-react'
import { apiClient, BackendOutdatedError } from '@/api/client'
import { BackendOutdatedBanner } from '@/components/settings/BackendOutdatedBanner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'

interface Automation {
  id: string
  name: string
  schedule: string
  enabled: boolean
  prompt: string
  session_id: string | null
  next_run_at: number | null
  created_at: number
}

interface AutomationRun {
  id: string
  automation_id: string
  status: string
  session_id: string | null
  error: string | null
  started_at: number | null
  finished_at: number | null
}

const SCHEDULE_PRESETS = ['15m', '30m', '1h', '@daily', '@manual']

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function AutomationsPanel() {
  const toast = useToast()
  const copy = (zh: string, en: string) => (/^zh/i.test(navigator.language) ? zh : en)

  const [items, setItems] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [outdatedError, setOutdatedError] = useState<BackendOutdatedError | null>(null)

  // create form
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('30m')
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)

  // run history drawer
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setOutdatedError(null)
    try {
      const list = await apiClient.listRuntimeAutomations<Automation[]>()
      setItems(Array.isArray(list) ? list : [])
    } catch (error) {
      if (error instanceof BackendOutdatedError) setOutdatedError(error)
      else toast.error(copy('加载定时任务失败', 'Could not load automations'))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) {
      toast.error(copy('请填写名称和提示词', 'Name and prompt are required'))
      return
    }
    setCreating(true)
    try {
      await apiClient.createRuntimeAutomation({
        name: name.trim(), schedule: schedule.trim(), prompt: prompt.trim(), enabled: true,
      })
      toast.success(copy('定时任务已创建', 'Automation created'))
      setName(''); setPrompt(''); setShowForm(false)
      await refresh()
    } catch (error) {
      toast.error(copy('创建失败', 'Create failed') + `: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCreating(false)
    }
  }

  const act = async (id: string, action: 'pause' | 'resume' | 'run' | 'delete') => {
    setBusyId(id)
    try {
      if (action === 'delete') await apiClient.deleteRuntimeAutomation(id)
      else if (action === 'pause') await apiClient.pauseRuntimeAutomation(id)
      else if (action === 'resume') await apiClient.resumeRuntimeAutomation(id)
      else await apiClient.runRuntimeAutomation(id)
      if (action === 'run') toast.success(copy('已触发运行', 'Run triggered'))
      await refresh()
    } catch (error) {
      toast.error(copy('操作失败', 'Action failed') + `: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusyId(null)
    }
  }

  const toggleRuns = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    setRunsLoading(true)
    try {
      const list = await apiClient.listRuntimeAutomationRuns<AutomationRun[]>(id)
      setRuns(Array.isArray(list) ? list : [])
    } catch {
      setRuns([])
    } finally {
      setRunsLoading(false)
    }
  }

  return (
    <section className="space-y-4">
      {outdatedError && (
        <BackendOutdatedBanner message={outdatedError.message} onRetry={() => void refresh()} />
      )}

      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{copy('定时任务', 'Automations')}</h3>
        <span className="text-[11px] text-muted-foreground">
          {copy('按周期自动运行 Agent 会话', 'Run agent sessions on a schedule')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} title={copy('刷新', 'Refresh')}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-3.5 w-3.5" />
            {copy('新建', 'New')}
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={copy('任务名称', 'Name')}
              className="h-8 text-[13px]"
            />
            <Input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="30m / 1h / @daily"
              className="h-8 w-40 shrink-0 font-mono text-[12px]"
              list="automation-schedule-presets"
            />
            <datalist id="automation-schedule-presets">
              {SCHEDULE_PRESETS.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={copy('每次运行时发给 Agent 的提示词…', 'Prompt sent to the agent on each run…')}
            rows={3}
            className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>{copy('取消', 'Cancel')}</Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {copy('创建', 'Create')}
            </Button>
          </div>
        </div>
      )}

      {!loading && items.length === 0 && !showForm && (
        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-[12px] text-muted-foreground">
          {copy('暂无定时任务。点击「新建」创建一个。', 'No automations yet. Click "New" to create one.')}
        </div>
      )}

      <ul className="space-y-2">
        {items.map((auto) => (
          <li key={auto.id} className="rounded-lg border border-border/70 bg-card/60">
            <div className="flex items-center gap-2 p-3">
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => void toggleRuns(auto.id)}
                title={copy('运行历史', 'Run history')}
              >
                {expandedId === auto.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{auto.name}</span>
                  <span className={cn(
                    'rounded-full px-1.5 py-0.5 font-mono text-[10px]',
                    auto.enabled
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground',
                  )}>
                    {auto.schedule}
                  </span>
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {auto.enabled && auto.next_run_at
                    ? `${copy('下次运行', 'Next run')}: ${formatTime(auto.next_run_at)}`
                    : copy('已暂停', 'Paused')}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {busyId === auto.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    <Button variant="ghost" size="sm" title={copy('立即运行', 'Run now')} onClick={() => void act(auto.id, 'run')}>
                      <Zap className="h-3.5 w-3.5" />
                    </Button>
                    {auto.enabled ? (
                      <Button variant="ghost" size="sm" title={copy('暂停', 'Pause')} onClick={() => void act(auto.id, 'pause')}>
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" title={copy('恢复', 'Resume')} onClick={() => void act(auto.id, 'resume')}>
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost" size="sm"
                      title={copy('删除', 'Delete')}
                      className="text-destructive hover:text-destructive"
                      onClick={() => void act(auto.id, 'delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            {expandedId === auto.id && (
              <div className="border-t border-border/60 px-3 py-2">
                {runsLoading ? (
                  <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> {copy('加载中…', 'Loading…')}
                  </div>
                ) : runs.length === 0 ? (
                  <div className="py-1 text-[11px] text-muted-foreground">{copy('暂无运行记录', 'No runs yet')}</div>
                ) : (
                  <ul className="space-y-1">
                    {runs.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 text-[11px]">
                        {r.status === 'completed'
                          ? <Check className="h-3 w-3 text-emerald-500" />
                          : r.status === 'running'
                            ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            : <X className="h-3 w-3 text-destructive" />}
                        <span className="tabular-nums text-muted-foreground">{formatTime(r.started_at)}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className={cn(
                          r.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400'
                            : r.status === 'running' ? 'text-muted-foreground' : 'text-destructive',
                        )}>
                          {r.status}
                        </span>
                        {r.error && <span className="min-w-0 flex-1 truncate text-destructive/80">{r.error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
