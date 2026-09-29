import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowUp, LayoutGrid, AlertCircle, WifiOff, Mic, Volume2, Loader2, Rocket, GitPullRequest, Compass, Bug, Check, ChevronDown, FolderOpen, FolderPlus, Send, MessageCircle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { useConnectionStore } from '@/store/connection'
import { useAppStore } from '@/store/app'
import { useProjectsStore } from '@/store/projects'
import { apiClient, HakusAIError, isRuntimeMissingThreadError } from '@/api/client'
import type { AgentEvent, ToolCall, QuestionAskedEvent, TaskProgressEvent, TaskProgressAttachment, TextSegment, ThreadGoal, Project, ApprovalRecord } from '@/api/types'
import { MessageBubble } from './MessageBubble'
import { InlineToolCallBubble } from './InlineToolCallBubble'
import { ApprovalDialog } from './ApprovalDialog'
import { Composer, type QueuedComposerMessage } from './Composer'
import { ChatNavButtons } from './ChatNavButtons'
import { MessageNavRail } from './MessageNavRail'
import { CheckpointList } from './CheckpointList'
import { SubagentsPanel } from './SubagentsPanel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, displayPath, generateId } from '@/lib/utils'
import { playVoiceNotification } from '@/lib/voiceNotifications'
import { VoiceConversation, type ConversationState } from '@/lib/voiceConversation'
import { VoiceCallEngine, type VoiceCallState } from '@/lib/voiceCall'
import { useToast } from '@/components/ui/toast'
import type { ChatMessage } from '@/api/types'
import { useI18n } from '@/lib/i18n'
import { isProviderConfigured } from '@/lib/providerState'
import { confirmProjectAccess, pickProjectFolder } from '@/api/tauriBridge'
import { assignSessionWorkspace } from '@/lib/sessionWorkspaces'
import { ProjectSourceDialog } from '@/components/projects/ProjectSourceDialog'
import { RemoteProjectWizard } from '@/components/settings/panels/RemoteProjectWizard'
import { executeAgentBrowserAction } from '@/lib/agentBrowser'

interface TimelineMessageItem {
  kind: 'message'
  message: ChatMessage
  /** When the assistant message owns multiple segments, this is the segment
   *  index. -1 means "render as a plain user/system message". */
  segmentIndex: number
  /** Total number of segments in the owning assistant message (1 for user). */
  totalSegments: number
  /** Reasoning text paired with this segment (may be empty). */
  reasoning: string
  /** True only for the last segment of a streaming assistant message. */
  isStreamingCursor: boolean
}

interface TimelineToolCallItem {
  kind: 'tool_call'
  toolCall: ToolCall
}

type TimelineItem = TimelineMessageItem | TimelineToolCallItem

interface QueuedSendMessage extends QueuedComposerMessage {
  sessionId: string
}

/**
 * Build a flat, article-style timeline: text → tool → text → tool → …
 *
 * For user messages, emits a single message item.
 * For assistant messages, expands the message into multiple items by walking
 * its `text_segments` and `tool_calls` arrays in lock-step:
 *   - segment[i] is the text BEFORE tool_calls[i]
 *   - segment[i+1] is the text AFTER tool_calls[i]
 *
 * If `text_segments` is missing (legacy messages), falls back to a single
 * segment containing `content`. If `tool_calls` is longer than `segments-1`,
 * the extra tool calls render at the end (no trailing text segment).
 */
function buildTimeline(messages: ChatMessage[]): TimelineItem[] {
  // Deduplicate by message id to guard against backend/state bugs that
  // surface the same message twice. Keeps the first occurrence.
  const seen = new Set<string>()
  const uniqueMessages = messages.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })

  const items: TimelineItem[] = []
  for (const msg of uniqueMessages) {
    if (msg.role !== 'assistant') {
      items.push({
        kind: 'message',
        message: msg,
        segmentIndex: 0,
        totalSegments: 1,
        reasoning: '',
        isStreamingCursor: false,
      })
      continue
    }

    // Assistant message — expand into segments + tool calls, paired by
    // after_tool_call_id so text bubbles interleave correctly with tool-call
    // cards even when tool calls finish out of start order.
    const textSegs: TextSegment[] =
      msg.text_segments && msg.text_segments.length > 0
        ? msg.text_segments
        : [{ id: 'legacy', text: msg.content || '' }]
    const reasonSegs = msg.reasoning_segments && msg.reasoning_segments.length > 0
      ? msg.reasoning_segments
      : []
    // Tool calls sorted by start time so the visual order matches execution.
    const toolCalls = [...(msg.tool_calls || [])].sort(
      (a, b) => (a.started_at || 0) - (b.started_at || 0),
    )

    // Build a lookup: call_id → segment index, so we can find which text
    // segment follows a given tool call.
    const segByAfterCall = new Map<string, number>()
    textSegs.forEach((seg, idx) => {
      if (seg.after_tool_call_id) segByAfterCall.set(seg.after_tool_call_id, idx)
    })

    // Segment 0 (no after_tool_call_id) is the pre-tool-call text.
    const preIdx = textSegs.findIndex((s) => !s.after_tool_call_id)
    const emitSegment = (idx: number, isStreamingCursor: boolean) => {
      const seg = textSegs[idx]
      const reasoning = reasonSegs[idx]?.text || ''
      const isLast = idx === textSegs.length - 1
      const isEmpty = !seg.text?.trim() && !reasoning?.trim()
      // Skip totally-empty non-last segments (no text + no reasoning) so we
      // don't render a blank bubble between two tool calls. The last segment
      // is always emitted so the streaming cursor has a home.
      if (!isEmpty || isLast) {
        items.push({
          kind: 'message',
          message: msg,
          segmentIndex: idx,
          totalSegments: textSegs.length,
          reasoning,
          isStreamingCursor,
        })
      }
    }

    // Emit pre-tool-call text (segment 0, or whichever seg has no after_tool_call_id).
    if (preIdx >= 0) {
      emitSegment(preIdx, !!msg.streaming && preIdx === textSegs.length - 1)
    }

    // Walk tool calls in execution order. After each tool call, emit the
    // segment that follows it (if any), so the interleaving matches the
    // model's actual output order: text → tool → text → tool → text.
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      items.push({ kind: 'tool_call', toolCall: tc })
      const afterIdx = segByAfterCall.get(tc.call_id)
      if (afterIdx !== undefined) {
        emitSegment(afterIdx, !!msg.streaming && afterIdx === textSegs.length - 1)
      }
    }

    // Edge case: streaming cursor when no tool calls yet and the single
    // segment is the last one — emitSegment above already handled it via
    // preIdx. If there are zero segments at all (shouldn't happen but
    // guard), emit a final streaming bubble.
    if (preIdx < 0 && toolCalls.length === 0 && textSegs.length === 0) {
      items.push({
        kind: 'message',
        message: msg,
        segmentIndex: 0,
        totalSegments: 0,
        reasoning: '',
        isStreamingCursor: !!msg.streaming,
      })
    }
  }
  return items
}

export function ChatView() {
  const { t, locale } = useI18n()
  const toast = useToast()
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeSessionId)
  const createSession = useSessionStore((s) => s.createSession)
  const messages = useSessionStore((s) => s.messages)
  const addMessage = useSessionStore((s) => s.addMessage)
  const updateMessage = useSessionStore((s) => s.updateMessage)
  const appendToStreamingLog = useSessionStore((s) => s.appendToStreamingLog)
  const appendReasoningToStreamingLog = useSessionStore((s) => s.appendReasoningToStreamingLog)
  const startStreamingLog = useSessionStore((s) => s.startStreamingLog)
  const stopStreamingLog = useSessionStore((s) => s.stopStreamingLog)
  const cacheStartedToolCall = useSessionStore((s) => s.cacheStartedToolCall)
  const applyFinishedToolCall = useSessionStore((s) => s.applyFinishedToolCall)
  const clearPendingToolCalls = useSessionStore((s) => s.clearPendingToolCalls)
  const renameSession = useSessionStore((s) => s.renameSession)
  // 五档权限审批卡（approval_required SSE 事件驱动）
  const [pendingApproval, setPendingApproval] = useState<ApprovalRecord | null>(null)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const setStreaming = useSessionStore((s) => s.setStreaming)
  const persistNewMessage = useSessionStore((s) => s.persistNewMessage)
  const persistMessage = useSessionStore((s) => s.persistMessage)
  const rewindToMessage = useSessionStore((s) => s.rewindToMessage)
  const bindRemoteMessageId = useSessionStore((s) => s.bindRemoteMessageId)
  const rbindSessionThread = useSessionStore((s) => s.rebindSessionThread)

  const settings = useSettingsStore()
  const configuredProviders = settings.providers.filter(isProviderConfigured)
  const activeProvider = configuredProviders.find((provider) => provider.is_default)
    || configuredProviders.find((provider) => provider.id === settings.defaultModel)
  // A provider catalog's `model_name` may be a built-in suggestion. Only a
  // model explicitly saved by the user makes the composer usable.
  const activeModel = activeProvider?.configured_models?.find((model) => Boolean(model?.trim()))
  const modelConfigured = Boolean(
    activeProvider
      // No `enabled !== false` gate here: the runtime reports enabled=false
      // even for the active provider when its key lives in the credential
      // store. isProviderConfigured already covers setup signals.
      // `models` is the read-only provider catalog. It can be populated even
      // on a fresh install, so it must not make the composer look usable.
      // Only a selected model or an explicitly saved user model counts.
      && Boolean(activeModel),
  )
  const connState = useConnectionStore((s) => s.state)
  const agentMode = useAppStore((s) => s.agentMode)
  const getReasoningEffort = useAppStore((s) => s.getReasoningEffort)
  const addTokens = useAppStore((s) => s.addTokens)
  const resetTokens = useAppStore((s) => s.resetTokens)
  const connCheck = useConnectionStore((s) => s.check)
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = useProjectsStore((s) => s.activeProject)
  const setActiveProject = useProjectsStore((s) => s.setActive)
  const createProject = useProjectsStore((s) => s.create)

  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null)
  const [composerDraft, setComposerDraft] = useState<string | undefined>(undefined)
  const [sendQueue, setSendQueue] = useState<QueuedSendMessage[]>([])
  const [voiceCallActive, setVoiceCallActive] = useState(false)
  const [voiceCallLoading, setVoiceCallLoading] = useState(false)
  const [conversationState, setConversationState] = useState<ConversationState>('idle')
  const [voiceAudioLevel, setVoiceAudioLevel] = useState(0)
  const [goal, setGoal] = useState<ThreadGoal | null>(null)
  // Long-running mode is armed independently from the persisted goal. The
  // next normal message becomes the goal objective and starts the first turn.
  const [longRunningArmed, setLongRunningArmed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sendQueueRef = useRef<QueuedSendMessage[]>([])
  const runSendRef = useRef<((text: string, sessionId: string, longRunningGoal?: boolean) => Promise<void>) | null>(null)
  const voiceConversationRef = useRef<VoiceConversation | null>(null)
  const voiceCallEngineRef = useRef<VoiceCallEngine | null>(null)
  const abortCtrlRef = useRef<AbortController | null>(null)

  const activeSession = sessions.find((s) => s.id === activeId)
  const activeMessages = activeId ? messages[activeId] || [] : []
  const activeQueuedMessages = activeId ? sendQueue.filter((item) => item.sessionId === activeId) : []
  const activeTaskProgress = [...activeMessages]
    .reverse()
    .find((msg) => msg.role === 'assistant' && (msg.streaming || msg.task_progress) && msg.task_progress)
    ?.task_progress

  useEffect(() => {
    let cancelled = false
    const remoteId = activeSession?.remote_session_id || activeId
    if (!remoteId) {
      setGoal(null)
      return () => { cancelled = true }
    }
    void apiClient.getRuntimeThreadGoal(remoteId)
      .then((next) => { if (!cancelled) setGoal(next) })
      .catch(() => { if (!cancelled) setGoal(null) })
    return () => { cancelled = true }
  }, [activeId, activeSession?.remote_session_id])

  useEffect(() => {
    // The armed state is a composer affordance for one conversation. Do not
    // carry it into another thread when the user switches sessions.
    setLongRunningArmed(false)
    // Reset cumulative token totals so they don't carry across sessions.
    resetTokens()
  }, [activeId, resetTokens])

  useEffect(() => {
    const remoteId = activeSession?.remote_session_id || activeId
    if (!remoteId || !goal || goal.status !== 'active') return
    let cancelled = false
    const refresh = async () => {
      try {
        const next = await apiClient.getRuntimeThreadGoal(remoteId)
        if (!cancelled) setGoal(next)
      } catch {
        // The goal may have been cleared by another client; the next session
        // refresh will reconcile the empty state.
      }
    }
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [activeId, activeSession?.remote_session_id, goal?.status])

  const startGoal = useCallback(async (objective: string) => {
    const remoteId = activeSession?.remote_session_id || activeId
    if (!remoteId) return
    const next = await apiClient.upsertRuntimeThreadGoal(remoteId, { objective })
    setGoal(next)
    return next
  }, [activeId, activeSession?.remote_session_id])

  const toggleLongRunning = useCallback(() => {
    setLongRunningArmed((current) => !current)
  }, [])

  const applyGoalAction = useCallback(async (action: 'pause' | 'resume' | 'complete' | 'block') => {
    const remoteId = activeSession?.remote_session_id || activeId
    if (!remoteId) return
    const next = action === 'pause'
      ? await apiClient.pauseRuntimeThreadGoal(remoteId)
      : action === 'resume'
        ? await apiClient.resumeRuntimeThreadGoal(remoteId)
        : action === 'complete'
          ? await apiClient.completeRuntimeThreadGoal(remoteId)
          : await apiClient.blockRuntimeThreadGoal(remoteId)
    setGoal(next)
    toast.success(action === 'pause' ? '长程任务已暂停' : action === 'resume' ? '长程任务已继续' : action === 'complete' ? '长程任务已完成' : '长程任务已暂停并标记为需处理')
  }, [activeId, activeSession?.remote_session_id, toast])

  useEffect(() => {
    sendQueueRef.current = sendQueue
  }, [sendQueue])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const status = await window.electron?.voice?.status?.()
      if (!cancelled && status) setVoiceCallActive(status.running)
    }
    void refresh()
    const id = setInterval(refresh, 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Auto-scroll on new content
  useEffect(() => {
    if (settings.autoScroll && scrollRef.current) {
      const el = scrollRef.current
      // Only auto-scroll if user is already near the bottom
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distance < 200) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [activeMessages, settings.autoScroll])

  const runNextQueued = useCallback(() => {
    if (useSessionStore.getState().isStreaming) return
    const next = sendQueueRef.current[0]
    if (!next) return
    const rest = sendQueueRef.current.slice(1)
    sendQueueRef.current = rest
    setSendQueue(rest)
    void runSendRef.current?.(next.text, next.sessionId)
  }, [])

  const runSend = useCallback(
    async (text: string, sessionId: string, longRunningGoal = false) => {
      if (!sessionId) return

      const userMsgId = addMessage(sessionId, {
        role: 'user',
        content: text,
        tool_calls: [],
      })
      void persistNewMessage(sessionId, userMsgId)

      const assistantMsgId = startStreamingLog(sessionId)
      void persistNewMessage(sessionId, assistantMsgId)

      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      if (session && session.title === 'New Chat') {
        void renameSession(sessionId, text.slice(0, 40).replace(/\n/g, ' '))
      }

      const ctrl = new AbortController()
      setAbortCtrl(ctrl)
      setStreaming(true, ctrl)

      // One turn attempt against a given Runtime thread id. Extracted so a
      // stale thread pointer can be healed and retried (see below).
      const streamTurn = (threadId: string) =>
        apiClient.chatStream(
          text,
          threadId,
          (chunk, event) => {
            // Defensive guard: if the stream has been aborted by rewind
            // or stop, streamingLogId[session] is null and assistantMsgId
            // has been (or will be) removed from the store. Drop any
            // in-flight buffered SSE chunks so they don't leak into a
            // half-removed message or get fed to TTS after the user
            // already cancelled.
            const currentLogId = useSessionStore.getState().streamingLogId[sessionId]
            if (!currentLogId || currentLogId !== assistantMsgId) return

            if (event) {
              handleAgentEvent(event, sessionId)
              return
            }
            if (chunk.content) {
              appendToStreamingLog(sessionId, chunk.content)
              voiceConversationRef.current?.feedAgentText(chunk.content)
            }
            if (chunk.error) {
              updateMessage(sessionId, assistantMsgId, {
                error: chunk.error,
                streaming: false,
              })
            }
            if (chunk.done) {
              updateMessage(sessionId, assistantMsgId, { streaming: false })
              voiceConversationRef.current?.endAgentTurn()
            }
          },
          ctrl.signal,
          settings.defaultModel,
          agentMode,
          getReasoningEffort(agentMode),
          // Read from store at send time, not from closure — otherwise
          // switching projects via the Composer picker doesn't take
          // effect until runSend is recreated (which never happens
          // because activeProject isn't in the useCallback deps).
          useProjectsStore.getState().activeProject?.id,
          activeModel,
          longRunningGoal || goal?.status === 'active',
        )

      try {
        try {
          await streamTurn(session?.remote_session_id || sessionId)
        } catch (e) {
          // `remote_session_id` is a client-side pointer into the Runtime's
          // thread store and goes stale when the Runtime restarts onto a
          // fresh store or the thread is deleted elsewhere. Without this,
          // every later send fails with "404 Thread not found" and the
          // session is permanently dead. Mint a replacement thread and
          // retry the turn once.
          if (!isRuntimeMissingThreadError(e)) throw e
          if (!rbindSessionThread) throw e
          const freshThreadId = await rbindSessionThread(sessionId)
          if (!freshThreadId) throw e
          await streamTurn(freshThreadId)
        }
        updateMessage(sessionId, assistantMsgId, { streaming: false })
        void persistMessage(sessionId, assistantMsgId)
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          // Only append "_Stopped_" if the assistant message still
          // exists in the store. If rewind already removed it, the
          // updateMessage call below is a no-op — and we should NOT
          // synthesize a stale "_Stopped_" tail that the user never
          // asked for.
          const stillExists = !!useSessionStore.getState().messages[sessionId]?.find((m) => m.id === assistantMsgId)
          if (stillExists) {
            const currentContent = useSessionStore.getState().messages[sessionId]?.find((m) => m.id === assistantMsgId)?.content || ''
            updateMessage(sessionId, assistantMsgId, {
              streaming: false,
              content: currentContent + '\\n\\n_Stopped_',
            })
            void persistMessage(sessionId, assistantMsgId)
          }
        } else {
          const msg = e instanceof HakusAIError ? e.message : 'Failed to send message'
          updateMessage(sessionId, assistantMsgId, {
            error: msg,
            streaming: false,
          })
          void persistMessage(sessionId, assistantMsgId)
        }
      } finally {
        stopStreamingLog(sessionId)
        setStreaming(false)
        setAbortCtrl(null)
        setTimeout(runNextQueued, 0)
      }
    },
    [activeModel, addMessage, agentMode, getReasoningEffort, appendToStreamingLog, persistMessage, persistNewMessage, renameSession, setStreaming, settings.defaultModel, startStreamingLog, stopStreamingLog, updateMessage, runNextQueued, rbindSessionThread, goal?.status],
  )

  useEffect(() => {
    runSendRef.current = runSend
  }, [runSend])

  useEffect(() => {
    abortCtrlRef.current = abortCtrl
  }, [abortCtrl])

  // Ensure microphone is released if the chat view unmounts while a call is active
  useEffect(() => {
    return () => {
      if (voiceCallEngineRef.current && voiceCallEngineRef.current.currentState !== 'idle') {
        void voiceCallEngineRef.current.stop()
      }
      voiceCallEngineRef.current = null
      if (voiceConversationRef.current && voiceConversationRef.current.currentState !== 'idle') {
        void voiceConversationRef.current.stop()
      }
      voiceConversationRef.current = null
    }
  }, [])

  const handleSend = useCallback(
    (text: string) => {
      if (!activeId) return
      if (useSessionStore.getState().isStreaming) {
        const nextQueue = [
          ...sendQueueRef.current,
          {
            id: generateId('q_'),
            sessionId: activeId,
            text,
            createdAt: Date.now(),
          },
        ]
        sendQueueRef.current = nextQueue
        setSendQueue(nextQueue)
        return
      }
      const shouldStartGoal = longRunningArmed && goal?.status !== 'active'
      if (!shouldStartGoal) {
        void runSend(text, activeId)
        return
      }
      void (async () => {
        try {
          const next = await startGoal(text)
          setLongRunningArmed(false)
          await runSend(text, activeId, next?.status === 'active')
        } catch (error) {
          const message = error instanceof HakusAIError ? error.message : '无法启动长程任务'
          toast.error(message)
        }
      })()
    },
    [activeId, goal?.status, longRunningArmed, runSend, startGoal, toast],
  )

  const handleRemoveQueued = useCallback((id: string) => {
    const nextQueue = sendQueueRef.current.filter((item) => item.id !== id)
    sendQueueRef.current = nextQueue
    setSendQueue(nextQueue)
  }, [])

  const notifyVoice = useCallback((kind: 'complete' | 'permission' | 'ask') => {
    void playVoiceNotification(kind, useSettingsStore.getState()).catch((error) => {
      console.warn('[voice] notification failed:', error)
    })
  }, [])

  const handleToggleVoiceCall = useCallback(async () => {
    // If VoiceCallEngine (builtin WS) is running, stop it
    if (voiceCallEngineRef.current && voiceCallEngineRef.current.currentState !== 'idle') {
      await voiceCallEngineRef.current.stop()
      voiceCallEngineRef.current = null
      setConversationState('idle')
      setVoiceCallActive(false)
      return
    }
    // If VoiceConversation (legacy) is running, stop it
    if (voiceConversationRef.current && voiceConversationRef.current.currentState !== 'idle') {
      await voiceConversationRef.current.stop()
      voiceConversationRef.current = null
      setConversationState('idle')
      setVoiceCallActive(false)
      return
    }

    const currentSettings = useSettingsStore.getState()
    if (!currentSettings.voiceCallEnabled) {
      toast.info('请先在设置里开启语音通话')
      return
    }

    if (currentSettings.voiceCallBackend === 'celia') {
      toast.info('当前使用 Celia 后端，请在「设置 → 语音通话与播报」中启动 Celia 进程')
      return
    }

    setVoiceCallLoading(true)
    try {
      const sessionId = useSessionStore.getState().activeSessionId
      if (!sessionId) {
        toast.error('没有活动会话，无法启动语音通话')
        return
      }

      // 使用新的 VoiceCallEngine（WebSocket 全双工）
      const currentSettings = useSettingsStore.getState()
      const engine = new VoiceCallEngine(
        {
          onStateChange: (state: VoiceCallState) => {
            // VoiceCallState 比 ConversationState 多了 'connecting'，映射到 thinking
            setConversationState(state as ConversationState)
          },
          onUserSpeech: (text) => {
            // Abort current stream if AI is still responding (interruption)
            if (abortCtrlRef.current) {
              abortCtrlRef.current.abort()
              abortCtrlRef.current = null
            }
            // 语音通话模式：后端 voice_call_handler 已自带 LLM+TTS 管线，
            // 前端只需显示用户消息 + 开始流式日志，不要通过 REST API 重复发送
            const sid = useSessionStore.getState().activeSessionId
            if (sid) {
              addMessage(sid, { role: 'user', content: text, tool_calls: [] })
              startStreamingLog(sid)
            }
          },
        onAgentToken: (text) => {
          // 将 LLM token 显示在聊天中
          const sid = useSessionStore.getState().activeSessionId
          if (sid) {
            appendToStreamingLog(sid, text)
          }
        },
        onAgentAudio: (_audioBase64) => {
          // 音频由 VoiceCallEngine 内部自动播放，此处无需额外处理
        },
        onAudioLevel: (level) => setVoiceAudioLevel(level),
        onError: (msg) => {
          console.warn('[voice-call]', msg)
          void engine.stop().finally(() => {
            voiceCallEngineRef.current = null
            setVoiceCallActive(false)
            setVoiceAudioLevel(0)
            setConversationState('idle')
          })
          toast.error(`语音通话异常：${msg}`)
        },
      },
      { dashscopeApiKey: currentSettings.dashscopeApiKey },
      )

      await engine.start(sessionId)
      voiceCallEngineRef.current = engine
      setVoiceCallActive(true)
      setConversationState('listening')
    } catch (e: any) {
      toast.error(`无法启动语音对话：${e?.message || e}`)
      voiceCallEngineRef.current = null
    } finally {
      setVoiceCallLoading(false)
    }
  }, [toast, appendToStreamingLog])

  // Handle typed AgentEvent from the protocol layer
  const handleAgentEvent = (event: AgentEvent, sessionId: string) => {
    if (event.event_type === 'browser_tool_requested') {
      useAppStore.getState().setRightPanelTab('browser')
      void (async () => {
        let result: { success: boolean; content: Array<{ type: 'input_text'; text: string }> }
        try {
          const text = await executeAgentBrowserAction(event.arguments)
          result = { success: true, content: [{ type: 'input_text', text }] }
        } catch (error) {
          result = {
            success: false,
            content: [{ type: 'input_text', text: error instanceof Error ? error.message : String(error) }],
          }
        }
        try {
          await apiClient.submitRuntimeToolCallResult(event.thread_id, event.turn_id, event.call_id, result)
        } catch (error) {
          console.error('[browser] failed to return tool result:', error)
        }
      })()
      return
    }
    if (event.event_type === 'goal_updated') {
      setGoal((event as any).goal || null)
      return
    }
    // The runtime echoes the user-message item it durably recorded for this
    // turn. Rebind the locally-generated user message id (`m_…`) to the
    // runtime item id (`item_…`) so the rewind button / checkpoint list can
    // address it. This must run before the streamingLogId gate below — the
    // event arrives right at turn start and is unrelated to the assistant
    // streaming placeholder.
    if ((event as any).event_type === 'remote_message_id') {
      const remoteId = String((event as any).remote_id || '')
      const msgs = useSessionStore.getState().messages[sessionId] || []
      // The newest user message is the one this turn just created.
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      if (remoteId && lastUser && lastUser.id !== remoteId) {
        bindRemoteMessageId(sessionId, lastUser.id, remoteId)
      }
      return
    }
    const messageId = useSessionStore.getState().streamingLogId[sessionId]
    if (!messageId) return

    switch (event.event_type) {
      case 'text_delta':
        {
          const text = (event as any).text || (event as any).content
          appendToStreamingLog(sessionId, text)
          // Feed text to voice conversation engine for TTS
          voiceConversationRef.current?.feedAgentText(text)
        }
        break
      case 'reasoning_delta':
        appendReasoningToStreamingLog(sessionId, (event as any).text || (event as any).content)
        break
      case 'tool_call_started': {
        // Don't render the card yet — the started event often has empty
        // arguments (they arrive with the finished event). Stash so we can
        // pair it with the finished event and present one card per tool call.
        // The name/arguments live in a nested `tool_call` object on the
        // server-side event (see agent_bridge.py).
        const tc = (event as any).tool_call || event
        const toolCall: ToolCall = {
          call_id: tc.call_id || event.call_id || generateId('tc_'),
          name: tc.name || event.name || '',
          arguments: tc.arguments || event.arguments || {},
          started_at: Date.now(),
        }
        cacheStartedToolCall(sessionId, messageId, toolCall)
        break
      }
      case 'approval_required': {
        // 五档权限引擎（guardian/granular/ask）要求用户审批 → 弹 glass 审批卡
        const ap = (event as any).approval as ApprovalRecord | undefined
        if (ap && ap.id) setPendingApproval(ap)
        break
      }
      case 'tool_call_finished':
        // Materialize: the tool card only appears when the call is fully done,
        // with complete arguments and result, so the user never sees a stack
        // of empty placeholder cards.
        {
          const tc = (event as any).tool_call || event
          applyFinishedToolCall(
            sessionId,
            messageId,
            tc.call_id || event.call_id,
            event.result || '',
            event.success !== false,
            event.duration || 0,
            tc.name || event.name,
            tc.arguments || event.arguments || {},
          )
        }
        break
      case 'token_usage':
        updateMessage(sessionId, messageId, {
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          cache_hit_tokens: (event as any).cache_hit_tokens ?? 0,
          cache_miss_tokens: (event as any).cache_miss_tokens ?? 0,
        })
        addTokens(event.input_tokens, event.output_tokens)
        break
      case 'turn_completed':
        // A host-managed long-running goal can produce several durable turns
        // on one SSE connection. Keep the composer streaming until the goal
        // lifecycle event reaches a terminal/non-running state.
        if (goal?.status === 'active') {
          if (event.content) appendToStreamingLog(sessionId, event.content)
          break
        }
        updateMessage(sessionId, messageId, {
          streaming: false,
          content: event.content || useSessionStore.getState().messages[sessionId]?.find((m) => m.id === messageId)?.content || '',
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          cache_hit_tokens: (event as any).cache_hit_tokens ?? 0,
          cache_miss_tokens: (event as any).cache_miss_tokens ?? 0,
        })
        notifyVoice('complete')
        voiceConversationRef.current?.endAgentTurn()
        break
      case 'turn_failed':
        updateMessage(sessionId, messageId, {
          streaming: false,
          error: `[${event.code}] ${event.error}`,
        })
        voiceConversationRef.current?.endAgentTurn()
        break
      case 'cancelled':
        updateMessage(sessionId, messageId, {
          streaming: false,
          content: event.partial_content || '',
        })
        voiceConversationRef.current?.endAgentTurn()
        break
      case 'orchestrator_phase_changed':
      case 'activity_changed':
        // Surface as a phase indicator on the message
        updateMessage(sessionId, messageId, {
          phase: 'phase' in event ? (event as any).phase : undefined,
          activity: 'activity' in event ? (event as any).activity : undefined,
        })
        break
      case 'question_asked': {
        const q = event as QuestionAskedEvent
        updateMessage(sessionId, messageId, {
          question: {
            question_id: q.question_id,
            question: q.question,
            options: q.options || [],
            allow_free_text: q.allow_free_text,
            answered: false,
          },
        })
        const questionText = String(q.question || "") + " " + (q.options || []).join(" ")
        const isPermissionQuestion = /permission|approve|deny|权限|允许|批准|确认执行|危险操作|执行/.test(questionText.toLowerCase())
        notifyVoice(isPermissionQuestion ? "permission" : "ask")
        break
      }
      case 'question_answered': {
        const a = event as any
        updateMessage(sessionId, messageId, {
          question: {
            ...(useSessionStore.getState().messages[sessionId]?.find((m) => m.id === messageId)?.question || {}),
            answered: true,
            selected: a.choice,
          } as any,
        })
        break
      }
      case 'task_progress': {
        const p = event as TaskProgressEvent
        const prev = useSessionStore.getState().messages[sessionId]?.find((m) => m.id === messageId)?.task_progress
        const tasks = prev?.tasks ? [...prev.tasks] : []
        if (p.current_task && !tasks.includes(p.current_task)) {
          tasks.push(p.current_task)
        }
        updateMessage(sessionId, messageId, {
          task_progress: {
            completed: p.completed,
            total: p.total,
            current_task: p.current_task,
            tasks,
          } as TaskProgressAttachment,
        })
        break
      }
      default:
        // Other events (checkpoint_saved, patch_*, reflection_*)
        // can be surfaced in a future iteration
        break
    }
  }

  const handleAnswerQuestion = async (messageId: string, choice: string) => {
    if (!activeId) return
    const sessionId = activeId
    const msg = useSessionStore.getState().messages[sessionId]?.find((m) => m.id === messageId)
    if (!msg?.question) return

    const question = msg.question
    // Optimistically mark answered
    updateMessage(sessionId, messageId, {
      question: { ...question, answered: true, selected: choice },
    })

    try {
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      await apiClient.answerQuestion(session?.remote_session_id || sessionId, question.question_id, choice)
    } catch (e: any) {
      console.error('[chat] answer question failed:', e)
      // Roll back so the user can retry
      updateMessage(sessionId, messageId, {
        question: { ...question, answered: false, selected: undefined },
      })
    }
  }

  const handleStop = () => {
    abortCtrl?.abort()
  }

  const handleRewind = async (messageId: string) => {
    // NOTE: do NOT guard with `isStreaming` here. The user's intent when
    // clicking "撤回此轮" while AI is streaming is "stop this response
    // AND remove it". rewindToMessage() in the store now aborts the
    // active SSE stream and resets streaming state before removing
    // messages — so rewinding while streaming is a supported operation.
    if (!activeId) return
    try {
      const text = await rewindToMessage(activeId, messageId)
      if (text !== null) {
        setComposerDraft(text)
      }
    } catch (e: any) {
      console.error('[chat] rewind failed:', e)
    }
  }

  const handleRegenerate = () => {
    if (!activeId) return
    const msgs = useSessionStore.getState().messages[activeId]
    if (!msgs) return
    // Find last user message
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (lastUser) {
      handleSend(lastUser.content)
    }
  }

  const startWorkspaceSession = async (projectId: string) => {
    setActiveProject(projectId)
    try {
      const id = await createSession('New Chat')
      assignSessionWorkspace(id, projectId)
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e)
      toast.error(locale.startsWith('zh') ? `新建会话失败：${detail}` : `Could not create chat: ${detail}`)
    }
  }

  const handleCreateWorkspace = async () => {
    try {
      const selected = await pickProjectFolder()
      if (!selected) return
      const allowed = await confirmProjectAccess()
      if (!allowed) return
      const name = selected.name || selected.path.split(/[\\/]/).filter(Boolean).pop() || 'Untitled'
      const project = await createProject({ name, path: selected.path, source_uri: selected.sourceUri })
      await startWorkspaceSession(project.id)
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e)
      toast.error(locale.startsWith('zh') ? `新建工作区失败：${detail}` : `Could not create workspace: ${detail}`)
    }
  }

  const handleDirectChat = async () => {
    setActiveProject(null)
    try {
      await createSession('New Chat')
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e)
      toast.error(locale.startsWith('zh') ? `新建会话失败：${detail}` : `Could not create chat: ${detail}`)
    }
  }

  // Empty state: a new install starts with a workspace decision instead of
  // silently creating a conversation in the application directory.
  if (!activeSession) {
    return (
      <WorkspaceLaunchpad
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectWorkspace={(projectId) => void startWorkspaceSession(projectId)}
        onCreateWorkspace={() => void handleCreateWorkspace()}
        onDirectChat={() => void handleDirectChat()}
        onContinueActive={(projectId) => void startWorkspaceSession(projectId)}
      />
    )
  }

  return (
    <div className="app-chat flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Connection warning */}
      {connState === 'error' && (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <div className="flex items-center gap-2">
            <WifiOff className="h-3.5 w-3.5" />
            <span>{t('connectionUnavailable')}：{settings.connection.serverUrl}</span>
          </div>
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => connCheck()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {/* Voice conversation status banner */}
      {conversationState !== 'idle' && (
        <div className="flex items-center justify-center border-b bg-muted/30 px-4 py-1.5">
          <div
            className={cn(
              'flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium',
              conversationState === 'listening' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
              conversationState === 'speaking' && 'bg-primary/15 text-primary',
              conversationState === 'connecting' && 'bg-primary/15 text-primary',
              (conversationState === 'transcribing' || conversationState === 'thinking') &&
                'bg-amber-500/15 text-amber-600 dark:text-amber-400',
            )}
          >
            {conversationState === 'connecting' && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                连接语音服务中…
              </>
            )}
            {conversationState === 'listening' && (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <Mic className="h-3 w-3" />
                聆听中…
              </>
            )}
            {conversationState === 'transcribing' && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                语音识别中…
              </>
            )}
            {conversationState === 'thinking' && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                AI 思考中…
              </>
            )}
            {conversationState === 'speaking' && (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                <Volume2 className="h-3 w-3" />
                AI 播报中…说话可打断
              </>
            )}
          </div>
        </div>
      )}

      {/* Messages — wrapped in a relative container so the floating
          nav buttons (ChatNavButtons) can anchor to its top-right
          corner. The buttons live OUTSIDE the scroll div so they
          don't scroll with the content. */}
      <div className="relative min-h-0 flex-1">
        {/* 悬浮工具簇：检查点 + 子代理。有消息时显示。 */}
        {activeMessages.length > 0 && (
          <div className="absolute right-3 top-3 z-10 flex gap-1.5">
            <CheckpointList messages={activeMessages} onRewind={handleRewind} />
            <SubagentsPanel sessionId={activeId || undefined} />
          </div>
        )}
        <ChatNavButtons
          scrollRef={scrollRef}
          offsetTop="top-[4.75rem]"
          // Re-evaluate button visibility whenever the message count
          // or the last message id changes (new content arrived).
          messagesKey={`${activeMessages.length}#${activeMessages[activeMessages.length - 1]?.id ?? ''}`}
        />
        {/* 右缘用户消息导航轨（长会话跳转） */}
        <MessageNavRail
          scrollRef={scrollRef}
          messagesKey={`${activeMessages.length}#${activeMessages[activeMessages.length - 1]?.id ?? ''}`}
        />
        <div ref={scrollRef} className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
        {activeMessages.length === 0 ? (
          <EmptyStateHero
            projectName={activeProject ? activeProject.name : t('currentDirectory')}
            onPick={(prompt) => setComposerDraft(prompt)}
          />
        ) : (
          // 宽度上限由 index.css 的 .chat-timeline 提供（它覆盖了
          // @layer utilities 的 max-width:100%，Tailwind 的 max-w-* 在此无效）。
          <div className="chat-timeline mx-auto min-w-0 w-full py-6">
            {buildTimeline(activeMessages).map((item, idx, arr) => {
              if (item.kind === 'message') {
                return (
                  <MessageBubble
                    key={`${item.message.id}#seg${item.segmentIndex}`}
                    message={item.message}
                    segmentIndex={item.segmentIndex}
                    totalSegments={item.totalSegments}
                    segmentReasoning={item.reasoning}
                    isStreamingCursor={item.isStreamingCursor}
                    isLastMessage={idx === arr.length - 1}
                    onRegenerate={handleRegenerate}
                    onRewind={handleRewind}
                    onAnswer={handleAnswerQuestion}
                  />
                )
              }
              return <InlineToolCallBubble key={item.toolCall.call_id} toolCall={item.toolCall} />
            })}
            <div ref={messagesEndRef} className="h-4" />
          </div>
        )}
        </div>
      </div>

      {/* Composer */}
      <Composer
        sessionId={activeId || undefined}
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        disabled={connState !== 'connected' || !modelConfigured}
        draftValue={composerDraft}
        onDraftConsumed={() => setComposerDraft(undefined)}
        pendingQueue={activeQueuedMessages}
        onRemoveQueued={handleRemoveQueued}
        taskProgress={activeTaskProgress}
        isVoiceCallActive={voiceCallActive}
        voiceCallLoading={voiceCallLoading}
        voiceAudioLevel={voiceAudioLevel}
        onToggleVoiceCall={handleToggleVoiceCall}
        conversationState={conversationState}
        goal={goal}
        longRunningArmed={longRunningArmed}
        onToggleLongRunning={toggleLongRunning}
        onGoalAction={applyGoalAction}
      />

      {/* 五档权限审批卡（glass） */}
      <ApprovalDialog
        approval={pendingApproval}
        onClose={() => setPendingApproval(null)}
      />
    </div>
  )
}

interface WorkspaceLaunchpadProps {
  projects: Project[]
  activeProjectId: string | null
  onSelectWorkspace: (projectId: string) => void
  onCreateWorkspace: () => void
  onDirectChat: () => void
  onContinueActive: (projectId: string) => void
}

function WorkspaceLaunchpad({
  projects,
  activeProjectId,
  onSelectWorkspace,
  onCreateWorkspace,
  onDirectChat,
  onContinueActive,
}: WorkspaceLaunchpadProps) {
  const { locale } = useI18n()
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const [projectSourceOpen, setProjectSourceOpen] = useState(false)
  const [remoteWizardOpen, setRemoteWizardOpen] = useState(false)

  return (
    <>
    <main className="workspace-launchpad flex min-h-0 flex-1 items-center justify-center bg-background px-5 py-8">
      <div className="workspace-launchpad-inner w-full max-w-[46rem]">
        <div className="workspace-launchpad-heading text-center">
          <div className="workspace-launchpad-mark mx-auto flex h-11 w-11 items-center justify-center rounded-2xl">
            <LayoutGrid className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {locale.startsWith('zh') ? '从一个工作区开始' : 'Start with a workspace'}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {locale.startsWith('zh')
              ? '选择一个项目文件夹，HakusAI 会在这个范围内理解、编辑和运行你的工作。'
              : 'Choose a project folder so HakusAI can understand, edit, and run work in the right context.'}
          </p>
        </div>

        <div className="workspace-launchpad-context mt-7 flex flex-wrap items-center justify-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="workspace-launchpad-pill" aria-label={locale.startsWith('zh') ? '选择工作区' : 'Choose workspace'}>
                <FolderOpen className="h-4 w-4 text-primary" />
                <span className="max-w-[15rem] truncate">{activeProject?.name || (locale.startsWith('zh') ? '选择工作区' : 'Choose workspace')}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-[min(340px,calc(100vw-32px))] p-1.5">
              {projects.length > 0 ? projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => onSelectWorkspace(project.id)}
                  className="gap-2 rounded-xl px-2.5 py-2.5"
                >
                  <FolderOpen className={cn('h-4 w-4 shrink-0', project.id === activeProjectId ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{project.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{displayPath(project.path)}</span>
                  </span>
                  {project.id === activeProjectId && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </DropdownMenuItem>
              )) : (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {locale.startsWith('zh') ? '还没有已保存的工作区' : 'No saved workspaces yet'}
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setProjectSourceOpen(true)} className="gap-2 rounded-xl px-2.5 py-2.5">
                <FolderPlus className="h-4 w-4 shrink-0 text-primary" />
                <span className="font-medium">{locale.startsWith('zh') ? '新建工作区' : 'Create workspace'}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDirectChat} className="gap-2 rounded-xl px-2.5 py-2.5">
                <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{locale.startsWith('zh') ? '直接对话' : 'Direct chat'}</span>
                  <span className="block text-[11px] text-muted-foreground">{locale.startsWith('zh') ? '不使用工作区，适合临时问答' : 'Chat without a workspace for quick questions'}</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <button
          type="button"
          className="workspace-launchpad-composer mt-5"
          onClick={() => {
            if (activeProject) {
              onContinueActive(activeProject.id)
              return
            }
            setProjectSourceOpen(true)
          }}
          aria-label={
            activeProject
              ? locale.startsWith('zh')
                ? `在 ${activeProject.name} 中新建会话`
                : `Start a new chat in ${activeProject.name}`
              : locale.startsWith('zh')
                ? '选择工作区并开始'
                : 'Choose a workspace to begin'
          }
        >
          <span
            className="workspace-launchpad-placeholder"
            aria-hidden="true"
          >
            {activeProject ? (locale.startsWith('zh') ? `继续使用 ${activeProject.name}` : `Continue with ${activeProject.name}`) : (locale.startsWith('zh') ? '选择一个工作区开始' : 'Choose a workspace to begin')}
          </span>
          <span className="workspace-launchpad-composer-footer">
            <span>
              {activeProject
                ? locale.startsWith('zh')
                  ? '点击新建会话'
                  : 'Click to start a new chat'
                : locale.startsWith('zh')
                  ? '点击选择文件夹作为工作区'
                  : 'Click to choose a folder as your workspace'}
            </span>
            <span className="workspace-launchpad-send" aria-hidden="true">
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </span>
          </span>
        </button>
      </div>
    </main>
    <ProjectSourceDialog
      open={projectSourceOpen}
      onOpenChange={setProjectSourceOpen}
      onLocal={onCreateWorkspace}
      onRemote={() => { setProjectSourceOpen(false); setRemoteWizardOpen(true) }}
    />
    <RemoteProjectWizard open={remoteWizardOpen} onOpenChange={setRemoteWizardOpen} />
    </>
  )
}

// =============================================================================
// EmptyStateHero — 助手式问候语 + 方形快捷入口卡片
// -----------------------------------------------------------------------------
// 设计要点：
// 1. 标题改成「问候式」语气（你好，我是 HakusAI），更像助手打招呼。
// 2. 4 个入口从「长条形胶囊」改成「正方形卡片」：图标在顶部、文字在下方，
//    水平并列摆放（flex-row + gap），整体居中。
// 3. 容器变窄时通过 CSS 网格重排，所有入口始终保留。
// =============================================================================
interface StarterCard {
  icon: typeof Rocket
  labelKey: 'starterBuild' | 'starterReview' | 'starterExplore' | 'starterFix'
  promptKey: 'starterBuildPrompt' | 'starterReviewPrompt' | 'starterExplorePrompt' | 'starterFixPrompt'
}

const STARTER_CARDS: StarterCard[] = [
  { icon: Rocket, labelKey: 'starterBuild', promptKey: 'starterBuildPrompt' },
  { icon: GitPullRequest, labelKey: 'starterReview', promptKey: 'starterReviewPrompt' },
  { icon: Compass, labelKey: 'starterExplore', promptKey: 'starterExplorePrompt' },
  { icon: Bug, labelKey: 'starterFix', promptKey: 'starterFixPrompt' },
]

function EmptyStateHero({ projectName, onPick }: { projectName: string; onPick: (prompt: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="empty-state-hero flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="empty-state-icon flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/40 text-muted-foreground">
        <MessageCircle className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-base font-semibold">{t('helloHakus')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('readyToWorkPrefix')} <span className="font-medium text-foreground/80">{projectName}</span>{t('readyToWorkSuffix')}
        </p>
      </div>
      {/* ref 容器只用来测宽，本身不可见；内层 flex 真正承载卡片 */}
      <div className="starter-card-grid w-full max-w-xl">
        <div className="flex justify-center gap-3">
          {STARTER_CARDS.map((card) => {
            const Icon = card.icon
            return (
              <button
                key={card.labelKey}
                onClick={() => onPick(t(card.promptKey))}
                title={t(card.promptKey)}
                className="group flex w-32 aspect-square flex-col items-start gap-2 rounded-xl border border-border/60 bg-card/60 p-3 text-left backdrop-blur-xl transition-colors hover:bg-[var(--cx-ghost-hover)]"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-muted/30 text-muted-foreground transition-colors group-hover:text-foreground">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <span className="text-xs font-medium leading-tight text-foreground/90">
                  {t(card.labelKey)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
