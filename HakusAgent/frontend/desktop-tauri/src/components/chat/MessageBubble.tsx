import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import { Check, Copy, PanelRight, RefreshCw, Undo2, HelpCircle, ArrowRight, X, ChevronDown, ChevronRight } from 'lucide-react'
import type { ChatMessage } from '@/api/types'
import { cn, copyToClipboard, formatTime } from '@/lib/utils'
import { translateError } from '@/lib/errorTranslate'
import { ReasoningLogItem } from './ReasoningLogItem'
import { TaskPlanReceipt } from './TaskPlanPanel'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/store/settings'
import { useAppStore } from '@/store/app'
import { useI18n } from '@/lib/i18n'

const MarkdownMessage = lazy(() =>
  import('./MarkdownMessage').then((module) => ({ default: module.MarkdownMessage })),
)

interface MessageBubbleProps {
  message: ChatMessage
  /** Index of the segment within message.text_segments to render. -1 (or 0 for
   *  non-assistant messages) means "render the whole message" (user/system). */
  segmentIndex?: number
  /** Total segments in the owning assistant message (1 for user). Used to
   *  decide whether to show the avatar (only on the first segment). */
  totalSegments?: number
  /** Reasoning text paired with this segment. */
  segmentReasoning?: string
  /** True if this is the last segment of a streaming assistant message —
   *  controls the streaming cursor. */
  isStreamingCursor?: boolean
  /** True if this is the last item in the entire timeline — controls
   *  regenerate button visibility. */
  isLastMessage?: boolean
  onRegenerate?: () => void
  onRewind?: (messageId: string) => void
  onAnswer?: (messageId: string, choice: string) => void
}

export const MessageBubble = memo(function MessageBubble({
  message,
  segmentIndex = 0,
  totalSegments = 1,
  segmentReasoning = '',
  isStreamingCursor = false,
  isLastMessage = false,
  onRegenerate,
  onRewind,
  onAnswer,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false)
  const openArtifact = useAppStore((s) => s.openRightPanelArtifact)
  const { t } = useI18n()
  const showReasoning = useSettingsStore((s) => s.showReasoning)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'

  // Pull the segment text for assistant messages; user/system messages
  // ignore segmentIndex and use message.content directly.
  const segmentText = isAssistant
    ? (message.text_segments?.[segmentIndex]?.text ?? (segmentIndex === 0 ? message.content : ''))
    : message.content

  const handleCopy = async () => {
    const ok = await copyToClipboard(segmentText)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  // For assistant multi-segment messages the timeline already merges segments
  // into one article flow; the first segment hosts turn-level affordances.
  const isFirstSegmentOfAssistantTurn = isAssistant && segmentIndex === 0
  const isLastSegmentOfAssistantTurn = isAssistant && segmentIndex === totalSegments - 1

  // Reasoning for this segment — only show if user wants it AND there's content
  // (or we're streaming this segment with no text yet, so the "thinking…"
  // indicator has a home).
  const reasoningText = isAssistant && showReasoning ? segmentReasoning : ''
  const showReasoningBlock =
    isAssistant &&
    showReasoning &&
    (!!reasoningText?.trim() || (isStreamingCursor && !segmentText?.trim()))

  // Reduce vertical gap for non-first assistant segments so the article reads
  // as a continuous flow rather than separate "messages".
  const verticalGap =
    isAssistant && !isFirstSegmentOfAssistantTurn ? 'py-1' : 'py-3'

  // 无头像列，整条消息是一个 article 流。
  // assistant 无边框全宽排版；user 右对齐。
  return (
    <div
      // data-role + data-message-id let the parent ChatView find user
      // messages via querySelectorAll and scrollIntoView them — used by
      // the up/down navigation buttons next to the chat scroll area.
      data-role={message.role}
      data-message-id={message.id}
      className={cn(
        'chat-message group flex min-w-0 w-full flex-col animate-fade-in',
        verticalGap,
        isUser && 'items-end justify-end gap-2',
      )}
    >
      {/* Message body */}
      <div className={cn('chat-message-body flex min-w-0 flex-col gap-1', isUser ? 'max-w-[77%]' : 'w-full')}>
        {/* Reasoning (inline, no bubble) — shown above the text bubble.
            Just muted text with a Brain icon; click to expand into full thinking. */}
        {showReasoningBlock && (
          <ReasoningLogItem
            reasoning={reasoningText || ''}
            isStreaming={isStreamingCursor}
          />
        )}

        {/* Content — user message bubble layout:
            bg-text/5 + rounded-2xl + px-3 py-2 + max-w-[77%]，无 ring 无边框；
            assistant: borderless full-width article text with comfortable line height. */}
        {segmentText ? (
          <div
            className={cn(
              'selectable min-w-0 text-foreground',
              isUser
                ? 'rounded-2xl bg-foreground/[0.05] px-3 py-2'
                : 'w-full',
            )}
            style={{ fontSize: `${fontSize}px` }}
          >
            {isAssistant && segmentText.length > 200 && (
              <button
                type="button"
                onClick={() =>
                  openArtifact({ title: t('artifactTab'), content: segmentText, language: 'markdown' })
                }
                className={cn(
                  'mb-1 ml-auto mr-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground',
                  'opacity-0 transition-opacity hover:bg-[var(--cx-ghost-hover)] group-hover:opacity-100',
                )}
                title={t('openInPanel')}
                aria-label={t('openInPanel')}
              >
                <PanelRight className="h-3 w-3" />
                {t('openInPanel')}
              </button>
            )}
            {isAssistant ? (
              <div className="markdown-body leading-relaxed">
                <Suspense fallback={<div className="whitespace-pre-wrap break-words">{segmentText}</div>}>
                  <MarkdownMessage content={segmentText} />
                </Suspense>
                {isStreamingCursor && (
                  <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse-dot bg-foreground/70 align-text-bottom" />
                )}
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words">{segmentText}</div>
            )}
          </div>
        ) : (
          /* Streaming cursor when there's no text yet but the segment is the
             active streaming one — give it a tiny host so the cursor shows. */
          isStreamingCursor && (
            <div className="w-full px-1 py-2.5" style={{ fontSize: `${fontSize}px` }}>
              <span className="inline-block h-3.5 w-[2px] animate-pulse-dot bg-foreground/70 align-text-bottom" />
            </div>
          )
        )}

        {/* Plan receipt — only on the last segment of the assistant turn.
            Deliberately a one-line receipt rather than the full plan card: the
            live plan already docks above the composer, so a second expanded
            copy here duplicated every row and scrolled away exactly when the
            user scrolled up to read it. */}
        {isLastSegmentOfAssistantTurn && message.task_progress && (
          <TaskPlanReceipt progress={message.task_progress} />
        )}

        {/* Interactive question — only on the last segment */}
        {isLastSegmentOfAssistantTurn && message.question && (
          <QuestionCard
            messageId={message.id}
            question={message.question}
            onAnswer={onAnswer}
          />
        )}

        {/* Error — only on the last segment. Shows a friendly Chinese
            one-liner; raw technical detail is hidden behind a toggle. */}
        {isLastSegmentOfAssistantTurn && message.error && (
          <ErrorBlock raw={message.error} />
        )}

        {/* Footer: time + actions — only on the last segment of an assistant turn,
            or always for user messages */}
        {(isUser || isLastSegmentOfAssistantTurn) && (
          <div
            className={cn(
              'flex items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100',
              isUser && 'flex-row-reverse',
            )}
          >
            <span>{formatTime(message.created_at)}</span>
            {(message.input_tokens || message.output_tokens) && (
              <span className="text-muted-foreground/70">
                · {message.input_tokens || 0}↑ {message.output_tokens || 0}↓
                {(() => {
                  // Cache hit rate — only show when cache stats are present
                  // (DeepSeek providers). Hit rate = hit / (hit + miss).
                  // Display as plain percentage number, no label.
                  const hit = message.cache_hit_tokens ?? 0
                  const miss = message.cache_miss_tokens ?? 0
                  const total = hit + miss
                  if (total <= 0) return null
                  const pct = Math.round((hit / total) * 100)
                  return <> {pct}%</>
                })()}
              </span>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              onClick={handleCopy}
              title="Copy"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            </Button>
            {isUser && onRewind && !message.streaming && (
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => onRewind(message.id)}
                title="回撤此轮"
              >
                <Undo2 className="h-3 w-3" />
              </Button>
            )}
            {isAssistant && isLastMessage && onRegenerate && !message.streaming && (
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={onRegenerate}
                title="Regenerate"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

interface QuestionCardProps {
  messageId: string
  question: NonNullable<ChatMessage['question']>
  onAnswer?: (messageId: string, choice: string) => void
}

function QuestionCard({ messageId, question, onAnswer }: QuestionCardProps) {
  const [selected, setSelected] = useState<string | null>(question.selected || null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const handleConfirm = () => {
    if (!selected || isSubmitting) return
    setIsSubmitting(true)
    onAnswer?.(messageId, selected)
  }

  // The hint line advertises keyboard selection — make it true: number keys
  // jump to an option, ArrowUp/Down cycle, Enter confirms, Tab (shift for
  // reverse) moves the selection like the option cards.
  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (question.answered || isSubmitting) return
    const count = question.options.length
    if (!count) return
    const current = selected ? question.options.indexOf(selected) : -1
    if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1
      if (idx < count) {
        e.preventDefault()
        setSelected(question.options[idx])
      }
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      setSelected(question.options[(current + 1 + count) % count])
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      setSelected(question.options[(current - 1 + count) % count])
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (selected) handleConfirm()
    }
  }

  const handleSkip = () => {
    if (isSubmitting) return
    setIsSubmitting(true)
    onAnswer?.(messageId, '')
  }

  useEffect(() => {
    if (!question.answered) cardRef.current?.focus()
  }, [question.answered])

  if (question.answered) {
    return (
      <div className="w-full overflow-hidden rounded-2xl border border-primary/30 bg-primary/10 px-5 py-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary">
          <HelpCircle className="h-4 w-4" />
          <span>羽汐想问</span>
        </div>
        <div className="mb-4 text-sm text-foreground">{question.question}</div>
        <div className="flex items-center gap-2 rounded-xl bg-background/80 px-3 py-2 text-sm text-muted-foreground">
          <Check className="h-4 w-4 text-emerald-500" />
          <span>
            已选择：<span className="font-medium text-foreground">{question.selected || '跳过'}</span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={cardRef}
      tabIndex={0}
      onKeyDown={handleCardKeyDown}
      className="w-full overflow-hidden rounded-2xl border border-primary/30 bg-primary/10 px-5 py-4 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary">
        <HelpCircle className="h-4 w-4" />
        <span>羽汐想问</span>
      </div>
      <div className="mb-4 text-sm font-medium text-foreground">{question.question}</div>

      <div className="space-y-1.5">
        {question.options.map((opt, idx) => {
          const isSelected = selected === opt
          return (
            <button
              key={opt}
              onClick={() => setSelected(opt)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                isSelected
                  ? 'border-primary/50 bg-primary/20 text-foreground'
                  : 'border-border/60 bg-background/80 text-foreground/90 hover:bg-[var(--cx-ghost-hover)]',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {idx + 1}
              </span>
              <span className="flex-1">{opt}</span>
              {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border/30 pt-3">
        <span className="text-xs text-muted-foreground">数字键 / 上下键选择，回车确认，Tab 切换</span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleSkip}
            disabled={isSubmitting}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            忽略
          </Button>
          <Button
            size="sm"
            className="h-8 rounded-xl bg-primary px-4 text-xs text-primary-foreground hover:bg-primary/90"
            onClick={handleConfirm}
            disabled={!selected || isSubmitting}
          >
            继续
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * ErrorBlock — friendly Chinese title + collapsible technical detail.
 *
 * Wraps the raw error string with `translateError()` so the user sees
 * a one-line summary first. If the raw text carries useful detail
 * (longer than the title's intent), a "技术细节" toggle expands to
 * show it in a <pre> block.
 */
const ErrorBlock = memo(function ErrorBlock({ raw }: { raw: string }) {
  const [expanded, setExpanded] = useState(false)
  const translated = translateError(raw)
  const hasDetail = !!translated.detail

  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <div className="flex items-start gap-1.5">
        <span className="flex-1 leading-relaxed">{translated.title}</span>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-destructive/70 transition-colors hover:bg-destructive/15 hover:text-destructive"
            aria-expanded={expanded}
            aria-label="展开技术细节"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>{expanded ? '收起' : '技术细节'}</span>
          </button>
        )}
      </div>
      {hasDetail && expanded && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/5 px-2 py-1.5 text-[10px] leading-relaxed text-destructive/80">
          {translated.detail}
        </pre>
      )}
    </div>
  )
})
