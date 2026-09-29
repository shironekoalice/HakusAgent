/**
 * CheckpointList — 「检查点」悬浮按钮 + 下拉列表。
 *
 * 每条用户消息即一个检查点（与后端 timeline/rewind 账本对齐）。
 * 列表从新到旧展示各检查点（时间 + 摘要），点击后二次确认，
 * 确认后调用 onRewind(messageId) 回到该节点（其后内容被撤回，
 * 消息文本回到输入框）。
 */
import { useState } from 'react'
import { History, Check, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import type { ChatMessage } from '@/api/types'

interface CheckpointListProps {
  messages: ChatMessage[]
  onRewind: (messageId: string) => void
}

function fmtTime(ts: number, locale: string): string {
  try {
    return new Date(ts).toLocaleTimeString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export function CheckpointList({ messages, onRewind }: CheckpointListProps) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const checkpoints = messages.filter((m) => m.role === 'user')

  if (checkpoints.length === 0) return null

  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setConfirmId(null) }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={copy('检查点', 'Checkpoints')}
          aria-label={copy('检查点', 'Checkpoints')}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/80 text-foreground/80 shadow-sm backdrop-blur-md transition-colors',
            'hover:bg-[var(--cx-ghost-hover)] hover:text-foreground active:scale-95',
          )}
        >
          <History className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-[320px] p-1.5">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {copy('回到历史检查点', 'Restore a checkpoint')}
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {checkpoints
            .slice()
            .reverse()
            .map((m, i) => {
              const snippet = m.content.replace(/\s+/g, ' ').trim()
              const preview = snippet.length > 60 ? `${snippet.slice(0, 60)}…` : snippet
              const confirming = confirmId === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    if (confirming) {
                      setConfirmId(null)
                      onRewind(m.id)
                    } else {
                      setConfirmId(m.id)
                    }
                  }}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--cx-ghost-hover)]',
                    confirming && 'bg-destructive/10',
                  )}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/60 text-[10px] tabular-nums text-muted-foreground">
                    {checkpoints.length - i}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground/90">{preview}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {fmtTime(m.created_at, locale)}
                    </span>
                  </span>
                  {confirming ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-destructive">
                      <Check className="h-3 w-3" />
                      {copy('确认撤回', 'Confirm')}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                      {copy('回到此处', 'Restore')}
                    </span>
                  )}
                </button>
              )
            })}
        </div>
        <div className="flex items-start gap-1 border-t border-border/60 px-2 pt-1.5 text-[10px] text-muted-foreground">
          <X className="mt-0.5 h-3 w-3 shrink-0" />
          {copy('回到检查点会撤回其后的所有消息', 'Restoring removes all messages after the checkpoint')}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
