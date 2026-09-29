/**
 * Dependency doctor — workspace dependency diagnose/reinstall card.
 * Probes git/node/python/uv/gh via Tauri and shows backend health.
 */

import { useEffect } from 'react'
import { CheckCircle2, Loader2, RefreshCw, Stethoscope, TriangleAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useReviewStore } from '@/store/review'
import { useConnectionStore } from '@/store/connection'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'

function statusIcon(status: string) {
  if (status === 'ok') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
  if (status === 'missing') return <XCircle className="h-3.5 w-3.5 text-rose-500" />
  return <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
}

export function DependencyDoctorPanel() {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const toast = useToast()
  const doctor = useReviewStore((s) => s.doctor)
  const doctorLoading = useReviewStore((s) => s.doctorLoading)
  const runDoctor = useReviewStore((s) => s.runDoctor)
  const health = useConnectionStore((s) => s.health)
  const backendVersion = useConnectionStore((s) => s.backendVersion)

  useEffect(() => {
    void runDoctor()
  }, [runDoctor])

  const problems = doctor?.checks.filter((c) => c.status !== 'ok') || []

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Stethoscope className="h-4 w-4 text-primary" />
            {copy('依赖医生', 'Dependency doctor')}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {copy('检查本机 Git / Node / Python 等工具链，以及 Runtime 连接状态。', 'Checks local Git / Node / Python toolchains and Runtime connectivity.')}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void runDoctor()} disabled={doctorLoading}>
          {doctorLoading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {copy('诊断', 'Diagnose')}
        </Button>
      </div>

      <div className="rounded-xl border border-border/60 bg-card/40 p-3">
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="font-medium">{copy('Runtime 服务', 'Runtime backend')}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px]',
              doctor?.backend.healthy || health?.status === 'ok'
                ? 'bg-emerald-500/15 text-emerald-500'
                : 'bg-rose-500/15 text-rose-500',
            )}
          >
            {doctor?.backend.healthy || health?.status === 'ok' ? copy('健康', 'Healthy') : copy('不可用', 'Unavailable')}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">
          {copy('版本', 'Version')}:{' '}
          {doctor?.backend.version ||
            (typeof backendVersion === 'string'
              ? backendVersion
              : (backendVersion as any)?.version) ||
            copy('未知', 'unknown')}{' '}
          · port 48081
        </div>
      </div>

      <div className="space-y-1.5">
        {doctorLoading && !doctor ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {copy('检测中...', 'Checking...')}
          </div>
        ) : (
          (doctor?.checks || []).map((c) => (
            <div key={c.id} className="rounded-xl border border-border/60 bg-card/40 p-2.5">
              <div className="flex items-center gap-2">
                {statusIcon(c.status)}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                {c.required && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    {copy('必需', 'required')}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {c.version || (c.found ? copy('已安装', 'found') : copy('未找到', 'missing'))}
                </span>
              </div>
              {c.path && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/70">{c.path}</div>}
              {c.hint && <div className="mt-1 text-[10px] text-amber-600/90 dark:text-amber-400/80">{c.hint}</div>}
            </div>
          ))
        )}
      </div>

      {doctor && problems.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-600 dark:text-amber-400">
          {copy(
            `发现 ${problems.length} 项问题。若工具调用失败，请安装缺失组件后重新诊断。`,
            `${problems.length} issue(s) found. Install missing tools and re-run diagnostics if tool calls fail.`,
          )}
        </div>
      )}
      {doctor && problems.length === 0 && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          {copy('本机依赖看起来是健康的。', 'Local dependencies look healthy.')}
        </div>
      )}
    </div>
  )
}
