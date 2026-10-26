/**
 * RunBar — the bar under the canvas.
 *
 * Left to right: run status, one input per Start field, then either the human
 * prompt (when the run is paused for input) or the run id / shortcut hint.
 */

import { useMemo, useRef } from 'react'
import { TriangleAlert, Workflow } from 'lucide-react'
import { useFlowStore } from '@/store/flow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { validateGraph } from '@/lib/flow/validation'

const STATUS_TEXT: Record<string, { zh: string; en: string }> = {
  running: { zh: '执行中', en: 'Running' },
  waiting_human: { zh: '等待人工输入', en: 'Waiting for human' },
  done: { zh: '运行完成', en: 'Done' },
  error: { zh: '运行出错', en: 'Error' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  idle: { zh: '就绪', en: 'Idle' },
}

const CHIP_TONE: Record<string, string> = {
  error: 'rp-chip-danger',
  done: 'rp-chip-ok',
  idle: 'rp-chip-muted',
}

export function RunBar() {
  const run = useFlowStore((s) => s.run)
  const runInputs = useFlowStore((s) => s.runInputs)
  const setRunInput = useFlowStore((s) => s.setRunInput)
  const submitHuman = useFlowStore((s) => s.submitHuman)
  const graph = useFlowStore((s) => s.graph)
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const startNode = graph.nodes.find((n) => n.type === 'start')
  const humanRef = useRef<HTMLInputElement>(null)

  const startKeys = useMemo(() => {
    if (!startNode) return [] as string[]
    return String(startNode.data.fields || '')
      .split('\n')
      .map((l) => l.trim().split('=')[0])
      .filter(Boolean)
  }, [startNode])

  const statusText = (STATUS_TEXT[run.status] || STATUS_TEXT.idle)[zh ? 'zh' : 'en']
  const settled = run.status === 'idle' || run.status === 'done' || run.status === 'cancelled' || run.status === 'error'

  // Graph defects, not run state: they are visible before the first Run and
  // stay visible after a failure. Clicking a chip selects the offending nodes
  // on the canvas (the selection ring is the shared highlight).
  const validation = useMemo(() => validateGraph(graph), [graph])
  const labelOf = (id: string) => String(graph.nodes.find((n) => n.id === id)?.data.label || id)
  const selectIssues = (ids: string[]) => useFlowStore.getState().selectNodes(ids)

  return (
    <div className="flow-runbar">
      <span className={cn('rp-chip', CHIP_TONE[run.status] || 'rp-chip-info')}>
        <Workflow className="mr-1 h-3 w-3" />
        {statusText}
      </span>

      {validation.cycleNodeIds.size > 0 ? (
        <button
          type="button"
          className="rp-chip rp-chip-warn cursor-pointer"
          title={[...validation.cycleNodeIds].map(labelOf).join(' · ')}
          onClick={() => selectIssues([...validation.cycleNodeIds])}
        >
          <TriangleAlert className="mr-1 h-3 w-3" />
          {zh
            ? `图中有环 · ${validation.cycleNodeIds.size} 个节点无法执行`
            : `cycle · ${validation.cycleNodeIds.size} node(s) can never run`}
        </button>
      ) : null}

      {validation.unwired.length > 0 ? (
        <button
          type="button"
          className="rp-chip rp-chip-warn cursor-pointer"
          title={validation.unwired.map((u) => `${labelOf(u.nodeId)} (${u.portIds.join(', ')})`).join(' · ')}
          onClick={() => selectIssues(validation.unwired.map((u) => u.nodeId))}
        >
          <TriangleAlert className="mr-1 h-3 w-3" />
          {zh ? `${validation.unwired.length} 个节点输入未接` : `${validation.unwired.length} node(s) missing input`}
        </button>
      ) : null}

      {startKeys.map((k) => (
        <label key={k} className="flow-run-input">
          <span className="flow-run-label">{zh ? '入参' : 'input'}</span>
          <span className="font-mono">{k}</span>
          <input
            className="rp-input !h-6 !w-32"
            value={String(runInputs[k] ?? '')}
            onChange={(e) => setRunInput(k, e.target.value)}
            disabled={run.status === 'running'}
          />
        </label>
      ))}

      {run.status === 'waiting_human' && run.human ? (
        <div className="flow-human">
          <span className="shrink-0 text-[11px] text-amber-500">{run.human.prompt}</span>
          <input
            ref={humanRef}
            className="rp-input !h-7 !w-56"
            placeholder={zh ? '输入后回车提交…' : 'Type and press Enter…'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                submitHuman((e.target as HTMLInputElement).value)
                ;(e.target as HTMLInputElement).value = ''
              }
            }}
          />
          <Button
            size="sm"
            className="h-7 rounded-lg px-2 text-[11px]"
            onClick={() => {
              submitHuman(humanRef.current?.value || '')
              if (humanRef.current) humanRef.current.value = ''
            }}
          >
            {zh ? '提交' : 'Submit'}
          </Button>
        </div>
      ) : (
        <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground">
          {settled ? (zh ? '⌘/Ctrl + Enter 运行' : '⌘/Ctrl + Enter to run') : run.runId || ''}
        </span>
      )}
    </div>
  )
}
