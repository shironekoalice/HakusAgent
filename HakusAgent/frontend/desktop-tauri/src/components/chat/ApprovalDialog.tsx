/**
 * ApprovalDialog — approval card (glass effect).
 *
 * Rendered when the agent's five-mode permission engine requires user
 * confirmation (guardian / granular / ask flows). Receives the
 * approval_required SSE payload and posts the decision back:
 *   - 仅本次允许   → POST /api/approvals/{id}/approve  {}
 *   - 本会话允许   → POST /api/approvals/{id}/approve  {scope:'session'}
 *   - 拒绝         → POST /api/approvals/{id}/deny
 */
import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { ShieldAlert, Check, X, Loader2, Terminal, FilePen, Globe, Wrench } from 'lucide-react'
import { apiClient } from '@/api/client'
import type { ApprovalRecord } from '@/api/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ApprovalDialogProps {
  approval: ApprovalRecord | null
  onClose: () => void
}

const RISK_TOOLS = new Set(['bash', 'shell', 'delete_file', 'write_file', 'edit_file', 'handoff_thread'])

function riskLevel(tool: string): 'high' | 'medium' {
  return RISK_TOOLS.has(tool) ? 'high' : 'medium'
}

function toolIcon(tool: string) {
  switch (tool) {
    case 'bash':
    case 'shell':
      return <Terminal className="h-4 w-4" />
    case 'write_file':
    case 'edit_file':
    case 'append_file':
    case 'delete_file':
      return <FilePen className="h-4 w-4" />
    case 'web_search':
    case 'web_fetch':
      return <Globe className="h-4 w-4" />
    default:
      return <Wrench className="h-4 w-4" />
  }
}

export function ApprovalDialog({ approval, onClose }: ApprovalDialogProps) {
  const [deciding, setDeciding] = useState(false)

  // Esc rejects the approval (safer default than silently allowing).
  useEffect(() => {
    if (!approval) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void handleDecide('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval?.id])

  if (!approval) return null

  const handleDecide = async (decision: 'once' | 'session' | 'deny') => {
    setDeciding(true)
    try {
      await apiClient.decideApproval(approval.id, decision)
    } catch {
      // The poller will deny it after timeout; nothing else to do here.
    } finally {
      setDeciding(false)
      onClose()
    }
  }

  const risk = riskLevel(approval.tool)

  return createPortal(
    <div className="fixed inset-0 z-[520] flex items-center justify-center p-4" data-hakus-overlay="approval-dialog">
      {/* glass backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-md"
        onClick={() => void handleDecide('deny')}
        role="presentation"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/15 bg-card/92 shadow-2xl backdrop-blur-xl dark:bg-card/85"
      >
        <div className="flex items-start gap-3 border-b border-white/10 bg-white/[0.03] px-5 py-4 dark:bg-white/[0.02]">
          <div className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            risk === 'high'
              ? 'bg-red-500/15 text-red-500'
              : 'bg-amber-500/15 text-amber-500',
          )}>
            <ShieldAlert className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">需要你的批准</h3>
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                risk === 'high'
                  ? 'bg-red-500/15 text-red-500'
                  : 'bg-amber-500/15 text-amber-500',
              )}>
                {risk === 'high' ? '高风险' : '需确认'}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              AI 请求执行以下操作，你可以逐项放行或拒绝。
            </p>
          </div>
        </div>

        <div className="space-y-2 px-5 py-4">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">{toolIcon(approval.tool)}</span>
            <span className="font-medium">{approval.tool}</span>
            <code className="ml-auto truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {approval.action_key}
            </code>
          </div>
          {approval.reason && (
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-foreground/80">
              {approval.reason}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/10 bg-white/[0.03] px-5 py-3.5 dark:bg-white/[0.02]">
          <Button
            variant="ghost" size="sm"
            disabled={deciding}
            onClick={() => void handleDecide('deny')}
            className="text-destructive hover:text-destructive"
          >
            {deciding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            拒绝
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline" size="sm"
              disabled={deciding}
              onClick={() => void handleDecide('session')}
            >
              <Check className="h-3.5 w-3.5" />
              本会话允许
            </Button>
            <Button size="sm" disabled={deciding} onClick={() => void handleDecide('once')}>
              <Check className="h-3.5 w-3.5" />
              仅本次允许
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
