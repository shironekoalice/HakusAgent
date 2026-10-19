import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Brain, Copy, CheckCheck } from 'lucide-react'
import { cn, copyToClipboard } from '@/lib/utils'

interface ReasoningLogItemProps {
  reasoning: string
  isStreaming?: boolean
  /** Optional wall-clock duration of the thinking step, in seconds. */
  durationSec?: number | null
}

const PREVIEW_LINES = 20
const STREAM_PREVIEW_HEIGHT = 220

/**
 * Inline thinking/reasoning block — compact one-line header like:
 *   › 思考 · 3.2s
 * Expandable body keeps the full reasoning text.
 */
export function ReasoningLogItem({ reasoning, isStreaming, durationSec }: ReasoningLogItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState(false)

  const prevStreamingRef = useRef<boolean | undefined>(undefined)
  const streamingHadContentRef = useRef(false)
  const scrollRef = useRef<HTMLPreElement | null>(null)

  const trimmed = reasoning.trim()
  const hasReasoning = trimmed.length > 0
  const lines = useMemo(() => trimmed.split('\n').filter(Boolean), [trimmed])
  const isExpandable = lines.length > 1 || (isStreaming && hasReasoning) || (!isStreaming && hasReasoning)

  const visibleLines = showAll ? lines : lines.slice(0, PREVIEW_LINES)
  const hasOverflow = lines.length > PREVIEW_LINES

  const durationLabel =
    durationSec != null && durationSec > 0 ? `${durationSec.toFixed(1)}s` : null

  useEffect(() => {
    const prev = prevStreamingRef.current
    if (isStreaming && hasReasoning && !streamingHadContentRef.current) {
      streamingHadContentRef.current = true
      setExpanded(true)
    }
    if (prev === true && !isStreaming) {
      setExpanded(false)
      streamingHadContentRef.current = false
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, hasReasoning])

  useEffect(() => {
    if (expanded && isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [expanded, isStreaming, reasoning])

  const handleCopy = async () => {
    if (await copyToClipboard(trimmed)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  if (!hasReasoning && !isStreaming) return null

  return (
    <div className="group/reasoning w-full">
      <div
        role={isExpandable ? 'button' : undefined}
        tabIndex={isExpandable ? 0 : -1}
        onClick={() => isExpandable && setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (isExpandable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setExpanded(!expanded)
          }
        }}
        className={cn(
          'flex w-full items-center gap-1.5 py-0.5 text-left text-[11px] text-muted-foreground',
          isExpandable ? 'cursor-pointer hover:text-foreground/80' : 'cursor-default',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <Brain
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground/70',
            isStreaming && 'animate-pulse text-amber-500/80',
          )}
        />
        <span className="shrink-0 font-medium">
          {isStreaming && !hasReasoning ? '思考中' : '思考'}
        </span>
        {durationLabel && !isStreaming && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="shrink-0 tabular-nums">{durationLabel}</span>
          </>
        )}
        {isStreaming && !hasReasoning ? (
          <span className="animate-pulse">正在分析…</span>
        ) : null}
      </div>

      {expanded && hasReasoning && (
        <div className="space-y-1.5 py-1 pl-4">
          <div className="relative">
            <button
              onClick={handleCopy}
              className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground/70 opacity-0 transition-opacity group-hover/reasoning:opacity-100 hover:bg-[var(--cx-ghost-hover)]"
              title="复制思考过程"
            >
              {copied ? <CheckCheck className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
              {copied ? '已复制' : '复制'}
            </button>
            <pre
              ref={scrollRef}
              className={cn(
                'overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2 text-[11px] text-muted-foreground',
                isStreaming ? 'streaming-reasoning-scroll' : 'max-h-[320px]',
              )}
              style={isStreaming ? { maxHeight: `${STREAM_PREVIEW_HEIGHT}px` } : undefined}
            >
              {isStreaming ? trimmed : visibleLines.join('\n')}
            </pre>
          </div>
          {hasOverflow && !isStreaming && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="flex items-center gap-1 text-[10px] text-primary hover:underline"
            >
              {showAll ? '收起' : `展开全部 (${lines.length} 行)`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
