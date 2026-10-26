import { Loader2, WifiOff } from 'lucide-react'
import { useSessionStreamStore } from '@/store/sessionStream'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * StreamStateBadge (Phase 6 Slice C): the one badge every bus-consuming
 * panel uses to say "this projection may not be live". Renders null while
 * the session's turn stream is live (or has no state yet); shows
 * reconnecting / stale / failed / permission-required otherwise, with the
 * same phase vocabulary as ChatView's banner.
 */
export function StreamStateBadge({ sessionId }: { sessionId: string }) {
  const { locale } = useI18n()
  const phase = useSessionStreamStore((s) => s.phases[sessionId])
  if (!phase || phase === 'live') return null
  const zh = locale === 'zh-CN'
  const label =
    phase === 'stale'
      ? (zh ? '投影可能滞后' : 'projection may be stale')
      : phase === 'reconnecting'
        ? (zh ? '重连中' : 'reconnecting')
        : phase === 'failed'
          ? (zh ? '事件流已断开' : 'stream lost')
          : (zh ? '需要重新授权' : 're-auth required')
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        phase === 'reconnecting' || phase === 'stale'
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'bg-destructive/10 text-destructive',
      )}
    >
      {phase === 'reconnecting'
        ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
        : <WifiOff className="h-2.5 w-2.5" />}
      {label}
    </span>
  )
}
