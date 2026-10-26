/**
 * Node run-status presentation — the class, label and icon for a node state.
 *
 * Kept in one place because the status has to stay consistent across the node
 * card, the inspector and the run panel.
 *
 * The icons carry `flow-status-*` classes rather than Tailwind palette
 * utilities. Tailwind palette colors resolve against the app theme, but the
 * canvas keeps the same dark plane in both themes, so `text-emerald-400` would
 * be the one thing on the canvas that shifted when the app theme did.
 */

import { AlertCircle, CheckCircle2, Loader2, Pause, SkipForward } from 'lucide-react'
import type { FlowNodeStatus } from '@/lib/flow/types'

export const STATUS_CLASS: Record<FlowNodeStatus, string> = {
  idle: '',
  queued: 'flow-node-queued',
  running: 'flow-node-running',
  done: 'flow-node-done',
  error: 'flow-node-error',
  skipped: 'flow-node-skipped',
  waiting: 'flow-node-waiting',
}

export const STATUS_LABEL: Record<FlowNodeStatus, string> = {
  idle: '',
  queued: '排队',
  running: '运行中',
  done: '完成',
  error: '出错',
  skipped: '跳过',
  waiting: '等待',
}

export function StatusIcon({ status }: { status: FlowNodeStatus }) {
  if (status === 'running') return <Loader2 className="flow-status-running h-3 w-3 animate-spin" />
  if (status === 'done') return <CheckCircle2 className="flow-status-done h-3 w-3" />
  if (status === 'error') return <AlertCircle className="flow-status-error h-3 w-3" />
  if (status === 'skipped') return <SkipForward className="flow-status-skipped h-3 w-3" />
  if (status === 'waiting') return <Pause className="flow-status-waiting h-3 w-3" />
  return null
}
