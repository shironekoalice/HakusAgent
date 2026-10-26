/**
 * Sessions & messages store
 *
 * Persistence layer migrated from localStorage to server-side SQLite
 * (~/.hakus/sessions.db) via /api/sessions* endpoints. Why:
 *   - localStorage caps at 5-10 MB, breaks under heavy reasoning/tool-call
 *     history
 *   - survives browser/Electron cache clear
 *   - backup is "copy ~/.hakus"
 *
 * Streaming behavior:
 *   - During stream, we update in-memory state only (fast UI)
 *   - On stream end (turn_completed / turn_failed / abort),
 *     ChatView calls persistMessage() once to write the final row
 *   - User messages are persisted immediately on send
 *
 * Boot flow:
 *   1. App boots -> connection store detects backend healthy
 *   2. Session store calls loadFromServer() -> GET /api/sessions
 *   3. For each session, GET /api/sessions/{id} on demand (lazy)
 *   4. localStorage 'hakusai-sessions-v1' (if present) is migrated
 *      once via POST /api/sessions/migrate, then the local key is cleared
 */

import { create } from 'zustand'
import type { ChatMessage, ChatSession, ToolCall, TextSegment, ReasoningSegment } from '@/api/types'
import { generateId } from '@/lib/utils'
import { apiClient, isRuntimeMissingThreadError } from '@/api/client'
import { removeSessionWorkspace } from '@/lib/sessionWorkspaces'
import { clearSessionEvents } from '@/store/eventBus'
import { clearSessionStream } from '@/store/sessionStream'

const EPHEMERAL_KEY = 'hakusai:ephemeral-sessions'

function readEphemeralSet(): Set<string> {
  try {
    const raw = localStorage.getItem(EPHEMERAL_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function markEphemeralSession(id: string) {
  try {
    const set = readEphemeralSet()
    set.add(id)
    localStorage.setItem(EPHEMERAL_KEY, JSON.stringify([...set]))
  } catch {
    /* ignore */
  }
}

function unmarkEphemeralSession(id: string) {
  try {
    const set = readEphemeralSet()
    set.delete(id)
    localStorage.setItem(EPHEMERAL_KEY, JSON.stringify([...set]))
  } catch {
    /* ignore */
  }
}

function isEphemeralSession(id: string): boolean {
  return readEphemeralSet().has(id)
}

interface SessionStore {
  sessions: ChatSession[]
  activeSessionId: string | null
  messages: Record<string, ChatMessage[]>
  isStreaming: boolean
  /** AbortController for the in-flight SSE stream. Stored in the store so
   *  clearMessages() can abort it — otherwise isStreaming gets stuck true
   *  and the user can't send any new messages in any session. */
  streamingAbort: AbortController | null
  /** True until the first successful loadFromServer(). UI shows skeleton. */
  loaded: boolean
  /** Set if the last loadFromServer() failed. UI can show retry. */
  loadError: Error | null
  /** Sessions whose messages have been fetched from server. */
  hydratedSessionIds: Set<string>
  /**
   * Per-session id of the assistant message currently receiving the stream.
   * This lets stream appenders target a single log without threading the id
   * through every event handler.
   */
  streamingLogId: Record<string, string | null>
  /**
   * Pending tool_call_started events keyed by `${sessionId}:${messageId}:${callId}`.
   * They are not rendered until the matching tool_call_finished arrives, so
   * the user never sees a stack of empty/blank cards while the agent is
   * still streaming. See cacheStartedToolCall / applyFinishedToolCall.
   */
  pendingStartedToolCalls: Map<string, ToolCall>

  // Session CRUD
  createSession: (title?: string, options?: { ephemeral?: boolean }) => Promise<string>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  setActiveSession: (id: string) => void
  pinSession: (id: string, pinned: boolean) => Promise<void>
  /** Fetch messages for a session if not already fetched. */
  hydrateSession: (id: string) => Promise<void>
  /**
   * Rewind a session to before a given user message: delete the target
   * message and every message after it, both in-memory and on the server.
   * Returns the target message's content so the caller can refill the
   * composer input.
   */
  rewindToMessage: (sessionId: string, messageId: string) => Promise<string | null>
  /**
   * Bind a runtime item id (`item_…`) to a locally-created message id
   * (`m_…`). Messages created during streaming only exist locally; the
   * Runtime's rewind endpoint addresses durable items by id, so before a
   * rewind can target this turn's user message we remap its id.
   */
  bindRemoteMessageId: (sessionId: string, localId: string, remoteId: string) => void
  /**
   * Re-point a session at a fresh Runtime thread.
   *
   * `remote_session_id` is a client-side pointer into the Runtime's thread
   * store. It goes stale when the Runtime restarts onto a fresh store or the
   * thread is deleted elsewhere, and every turn then fails with
   * "404 Thread not found". Creating a replacement thread and swapping the
   * pointer keeps the local transcript usable instead of dead-ending.
   */
  rebindSessionThread: (sessionId: string) => Promise<string | null>

  // Message operations — all in-memory during stream; persisted on stream end
  addMessage: (sessionId: string, msg: Omit<ChatMessage, 'id' | 'session_id' | 'created_at' | 'updated_at'>) => string
  updateMessage: (sessionId: string, messageId: string, patch: Partial<ChatMessage>) => void
  appendTextToMessage: (sessionId: string, messageId: string, text: string) => void
  appendReasoningToMessage: (sessionId: string, messageId: string, text: string) => void
  /**
   * Create an assistant placeholder for streaming and remember it as the
   * current streaming log for the session. Returns the new message id.
   * Initializes text_segments / reasoning_segments with one empty entry each
   * so streaming tokens have somewhere to land.
   */
  startStreamingLog: (sessionId: string) => string
  /**
   * Append text to the current streaming log's LAST text segment.
   * Also keeps `content` in sync (concatenation of all segment texts joined
   * by "\n\n") so the persisted shape stays compatible with the server schema.
   */
  appendToStreamingLog: (sessionId: string, text: string) => void
  /**
   * Append reasoning text to the current streaming log's LAST reasoning segment.
   */
  appendReasoningToStreamingLog: (sessionId: string, text: string) => void
  /**
   * Clear the tracked streaming log id for a session.
   */
  stopStreamingLog: (sessionId: string) => void
  /**
   * Cache a tool_call_started event. The card is NOT rendered yet — we wait
   * for the matching tool_call_finished (which has full arguments) so the
   * user never sees a row of empty/blank cards. See applyFinishedToolCall.
   */
  cacheStartedToolCall: (sessionId: string, messageId: string, toolCall: ToolCall) => void
  /**
   * Materialize a finished tool call into the message's tool_calls list.
   * If a matching started event was cached, we use its started_at; otherwise
   * synthesize one from the call_id so the order is stable.
   */
  applyFinishedToolCall: (sessionId: string, messageId: string, callId: string, result: string, success: boolean, duration: number, name: string, args: Record<string, any>) => void
  /**
   * Drop any pending tool_call_started events for this message. Called when
   * a stream ends (success / fail / abort) so a future stream for the same
   * messageId doesn't try to pair against stale entries.
   */
  clearPendingToolCalls: (sessionId: string, messageId: string) => void
  clearMessages: (sessionId: string) => void
  /** Write the current in-memory message to the server (used at stream end). */
  persistMessage: (sessionId: string, messageId: string) => Promise<void>
  /** Write the current in-memory message *as a new row* (user msg / assistant placeholder). */
  persistNewMessage: (sessionId: string, messageId: string) => Promise<void>

  // Streaming state
  setStreaming: (streaming: boolean, abort?: AbortController | null) => void

  // Server sync
  loadFromServer: () => Promise<void>
  /** One-shot migration of legacy localStorage data to server SQLite. */
  migrateFromLocalStorage: () => Promise<void>
}

const LEGACY_STORAGE_KEY = 'hakusai-sessions-v1'
const MIGRATION_FLAG_KEY = 'hakusai-sessions-migrated-to-sqlite'

function isNotFoundError(e: unknown): boolean {
  // Backend returns 404 when the message row does not exist.
  // The apiClient throws HakusAIError with status === 404, or a generic
  // Error whose message contains "404" / "not found".
  if (e && typeof e === 'object') {
    const anyE = e as any
    if (anyE.status === 404 || anyE.statusCode === 404) return true
    if (typeof anyE.message === 'string') {
      const msg = anyE.message.toLowerCase()
      return msg.includes('404') || msg.includes('not found')
    }
  }
  const msg = String(e).toLowerCase()
  return msg.includes('404') || msg.includes('not found')
}

function loadLegacyFromStorage(): { sessions: ChatSession[]; messages: Record<string, ChatMessage[]> } {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return { sessions: [], messages: {} }
    return JSON.parse(raw)
  } catch {
    return { sessions: [], messages: {} }
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  isStreaming: false,
  streamingAbort: null,
  loaded: false,
  loadError: null,
  hydratedSessionIds: new Set<string>(),
  streamingLogId: {},
  pendingStartedToolCalls: new Map(),

  // ===========================================================================
  // Session CRUD
  // ===========================================================================

  createSession: async (title, options) => {
    const id = generateId('s_')
    const now = Date.now()
    const ephemeral = Boolean(options?.ephemeral)
    const session: ChatSession = {
      id,
      title: title || (ephemeral ? 'Temporary chat' : 'New Chat'),
      created_at: now,
      updated_at: now,
      ephemeral,
    }
    // Optimistic in-memory update
    set({
      sessions: [session, ...get().sessions],
      activeSessionId: id,
      messages: { ...get().messages, [id]: [] },
    })
    // Temporary chats still need a Runtime thread to run turns, but must
    // not appear in server history. Record the id locally and hide it.
    if (ephemeral) {
      try {
        const persisted = await apiClient.createSession({
          id,
          title: session.title,
          created_at: now,
          updated_at: now,
        })
        const remoteId = persisted.remote_session_id
        if (remoteId) {
          set({
            sessions: get().sessions.map((item) =>
              item.id === id ? { ...item, remote_session_id: remoteId } : item,
            ),
          })
        }
        markEphemeralSession(id)
        // Best-effort: turn memory off while a temporary chat is active.
        try {
          await (apiClient as any).setRuntimeConfig?.('memory_enabled', false)
        } catch {
          /* Runtime may not support this key */
        }
      } catch (e) {
        console.error('[session] ephemeral createSession failed:', e)
        // Keep the local-only session so the user can still chat if the
        // Runtime is briefly unavailable.
      }
      return id
    }
    // Persist to server
    try {
      const persisted = await apiClient.createSession({
        id,
        title: session.title,
        created_at: now,
        updated_at: now,
      })
      // Android creates a Rust Runtime thread with its own durable ID. Keep
      // the local optimistic ID for the UI, but route turns to that thread.
      if (persisted.remote_session_id) {
        set({
          sessions: get().sessions.map((item) =>
            item.id === id ? { ...item, remote_session_id: persisted.remote_session_id } : item,
          ),
        })
      }
    } catch (e) {
      console.error('[session] createSession persist failed:', e)
      // Rollback optimistic update
      set({
        sessions: get().sessions.filter((s) => s.id !== id),
        activeSessionId: get().sessions[0]?.id || null,
      })
      throw e
    }
    return id
  },

  deleteSession: async (id) => {
    unmarkEphemeralSession(id)
    // If this session's stream is still running locally, end it first. The
    // stream's abort hook also fires the Runtime turn interrupt, which lifts
    // the "has an active turn" guard the Runtime holds against deletion —
    // and lets late stream events die instead of writing into a deleted
    // session. Mirrors clearMessages()/rewindToMessage().
    if (get().streamingLogId[id]) {
      get().streamingAbort?.abort()
      set({
        isStreaming: false,
        streamingAbort: null,
        streamingLogId: { ...get().streamingLogId, [id]: null },
      })
    }
    const prev = get().sessions
    const prevMessages = get().messages
    const previousActiveSessionId = get().activeSessionId
    // Optimistic
    const sessions = prev.filter((s) => s.id !== id)
    const messages = { ...prevMessages }
    delete messages[id]
    let activeSessionId = get().activeSessionId
    if (activeSessionId === id) {
      activeSessionId = sessions[0]?.id || null
    }
    set({ sessions, messages, activeSessionId })
    try {
      const remoteId = prev.find((session) => session.id === id)?.remote_session_id || id
      await apiClient.deleteSession(remoteId)
    } catch (e) {
      // Rollback
      set({ sessions: prev, messages: prevMessages, activeSessionId: previousActiveSessionId })
      throw e
    }
    removeSessionWorkspace(id)
    // Drop the workbench event cursor/fan-out for the deleted session.
    clearSessionEvents(id)
    // Drop the per-session turn-stream phase/error state as well.
    clearSessionStream(id)
  },

  renameSession: async (id, title) => {
    const prev = get().sessions
    set({
      sessions: prev.map((s) =>
        s.id === id ? { ...s, title, updated_at: Date.now() } : s,
      ),
    })
    try {
      const remoteId = prev.find((session) => session.id === id)?.remote_session_id || id
      await apiClient.updateSession(remoteId, { title })
    } catch (e) {
      set({ sessions: prev })
      throw e
    }
  },

  setActiveSession: (id) => {
    if (get().activeSessionId === id) {
      if (!get().hydratedSessionIds.has(id)) {
        void get().hydrateSession(id)
      }
      return
    }
    set({ activeSessionId: id })
    // Lazy hydrate messages on first activation
    if (!get().hydratedSessionIds.has(id)) {
      void get().hydrateSession(id)
    }
    try {
      void import('@/store/shell').then(({ useShellStore }) => {
        const shell = useShellStore.getState()
        shell.touchRecent(id)
        const title = get().sessions.find((s) => s.id === id)?.title || 'Chat'
        shell.ensureSessionTab(id, title, 'main')
      })
    } catch {
      /* ignore */
    }
  },

  pinSession: async (id, pinned) => {
    const prev = get().sessions
    set({
      sessions: prev.map((s) => (s.id === id ? { ...s, pinned } : s)),
    })
    try {
      const remoteId = prev.find((session) => session.id === id)?.remote_session_id || id
      await apiClient.updateSession(remoteId, { pinned })
    } catch (e) {
      set({ sessions: prev })
      throw e
    }
  },

  hydrateSession: async (id) => {
    if (get().hydratedSessionIds.has(id)) return
    try {
      const remoteId = get().sessions.find((session) => session.id === id)?.remote_session_id || id
      const data = await apiClient.getSession(remoteId)
      // Map ServerMessage -> ChatMessage (fields match closely)
      const msgs: ChatMessage[] = (data.messages || []).map((m) => {
        const msg: ChatMessage = {
          id: m.id,
          session_id: id,
          role: m.role as ChatMessage['role'],
          content: m.content,
          reasoning: m.reasoning || undefined,
          tool_calls: m.tool_calls || [],
          input_tokens: m.input_tokens || undefined,
          output_tokens: m.output_tokens || undefined,
          error: m.error || undefined,
          streaming: m.streaming,
          created_at: m.created_at,
          updated_at: m.updated_at,
        }
        // Synthesize a single-segment layout for legacy server rows so the
        // article-style renderer has a consistent shape to work with. The
        // full content goes into one segment; tool calls render after it.
        if (msg.role === 'assistant') {
          if (!msg.text_segments) {
            msg.text_segments = [{ id: generateId('seg_'), text: msg.content || '' }]
          }
          if (!msg.reasoning_segments) {
            msg.reasoning_segments = [{ id: generateId('rseg_'), text: msg.reasoning || '' }]
          }
        }
        return msg
      })
      set({
        messages: { ...get().messages, [id]: msgs },
        hydratedSessionIds: new Set([...get().hydratedSessionIds, id]),
      })
    } catch (e) {
      // A stale `remote_session_id` (Runtime restarted onto a fresh store,
      // thread deleted elsewhere) answers 404 here while the local session
      // row still exists. Treat it as an empty conversation instead of
      // logging forever — `hydration` is only marked on success, so the
      // retry would repeat on every activation. The next send heals the
      // thread pointer (see rebindSessionThread).
      if (isRuntimeMissingThreadError(e)) {
        set({
          messages: { ...get().messages, [id]: [] },
          hydratedSessionIds: new Set([...get().hydratedSessionIds, id]),
        })
        return
      }
      console.error('[session] hydrateSession failed:', e)
    }
  },

  bindRemoteMessageId: (sessionId, localId, remoteId) => {
    if (!remoteId || remoteId === localId) return
    const list = get().messages[sessionId] || []
    set({
      messages: {
        ...get().messages,
        [sessionId]: list.map((m) => (m.id === localId ? { ...m, id: remoteId } : m)),
      },
    })
  },

  rebindSessionThread: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return null
    try {
      const created = await apiClient.createSession({
        id: session.id,
        title: session.title,
        created_at: session.created_at,
        updated_at: Date.now(),
      })
      const remoteId = created.remote_session_id || created.id
      if (!remoteId) return null
      set({
        sessions: get().sessions.map((s) =>
          s.id === sessionId ? { ...s, remote_session_id: remoteId } : s,
        ),
      })
      return remoteId
    } catch (e) {
      console.error('[session] rebindSessionThread failed:', e)
      return null
    }
  },

  rewindToMessage: async (sessionId, messageId) => {
    const list = get().messages[sessionId] || []
    const idx = list.findIndex((m) => m.id === messageId)
    if (idx === -1) return null
    const target = list[idx]
    if (target.role !== 'user') return null

    // Abort any in-flight SSE stream BEFORE removing messages.
    // Without this, the stream's finally-block in ChatView keeps
    // appending tokens to a message id that's no longer in the store
    // (updateMessage becomes a silent no-op), so the UI shows the
    // rewind happened but the AI "keeps talking" in the background
    // until the server-side turn finishes on its own.
    //
    // This mirrors clearMessages() — same pattern, same reason.
    const abort = get().streamingAbort
    if (abort) {
      abort.abort()
    }
    // Reset streaming state immediately so the UI is interactive
    // again. The runSend finally-block will also call setStreaming(false)
    // when the AbortError lands, but that's async — we don't want to
    // leave the user blocked between rewind-click and abort-resolution.
    set({
      isStreaming: false,
      streamingAbort: null,
      streamingLogId: { ...get().streamingLogId, [sessionId]: null },
    })

    const kept = list.slice(0, idx)
    const removed = list.slice(idx)
    const prevMessages = get().messages

    // Optimistic UI update
    set({
      messages: { ...prevMessages, [sessionId]: kept },
    })

    // v0.12.0+: use the backend's atomic rewind endpoint so the
    // session log stays consistent with the message store. This
    // deletes the target message + all subsequent ones AND truncates
    // the JSONL log to the corresponding turn boundary. Falls back
    // to the old client-side delete-loop if the backend is older
    // (404 = endpoint doesn't exist yet) or returns a hard error.
    // Route to the Runtime thread id when one exists — the UI session id
    // is a client-generated `s_…` that the Runtime's /rewind cannot resolve.
    const remoteSessionId = get().sessions.find((s) => s.id === sessionId)?.remote_session_id || sessionId
    try {
      await apiClient.rewindSessionToMessage(remoteSessionId, messageId)
    } catch (e: any) {
      // 404 = old backend without the /rewind endpoint. "Item not found"
      // (400/500) = the runtime never durably recorded this message (turn
      // still running, or an older runtime). Either way fall back to the
      // client-side delete-loop, which addresses messages individually.
      const status = e?.status ?? e?.statusCode
      const message = String(e?.message ?? '')
      const itemMissing = message.toLowerCase().includes('not found')
      if (status === 404 || status === 405 || ((status === 400 || status === 500) && itemMissing)) {
        const results = await Promise.allSettled(
          removed.map((m) => apiClient.deleteMessage(sessionId, m.id)),
        )
        const hardErrors = results
          .map((r, i) => ({ r, m: removed[i] }))
          .filter(({ r }) => r.status === 'rejected')
          .filter(({ r }) => !isNotFoundError((r as PromiseRejectedResult).reason))
        if (hardErrors.length > 0) {
          set({ messages: prevMessages })
          throw hardErrors[0].r
        }
      } else {
        // Hard error (network / 5xx) — rollback the optimistic update.
        set({ messages: prevMessages })
        throw e
      }
    }

    return target.content || null
  },

  // ===========================================================================
  // Message operations (in-memory during stream)
  // ===========================================================================

  addMessage: (sessionId, msg) => {
    const id = generateId('m_')
    const now = Date.now()
    const message: ChatMessage = {
      ...msg,
      id,
      session_id: sessionId,
      created_at: now,
      updated_at: now,
    }
    const existing = get().messages[sessionId] || []
    set({
      messages: { ...get().messages, [sessionId]: [...existing, message] },
    })
    return id
  },

  updateMessage: (sessionId, messageId, patch) => {
    const list = get().messages[sessionId] || []
    set({
      messages: {
        ...get().messages,
        [sessionId]: list.map((m) => {
          if (m.id !== messageId) return m
          const next = { ...m, ...patch, updated_at: Date.now() }
          // When turn_completed delivers the final assembled string, KEEP the
          // existing segment structure if we already built one during streaming
          // — collapsing to a single segment destroys the interleaving between
          // text bubbles and tool-call cards, making all tool calls pile up at
          // the end of the message. Only collapse if we never had segments
          // (e.g. legacy hydration that only set flat `content`).
          if (patch.content !== undefined) {
            const existingSegs = m.text_segments || []
            const hasMultiSegs = existingSegs.length > 1
              || (existingSegs.length === 1 && existingSegs[0].after_tool_call_id)
            if (!hasMultiSegs) {
              next.text_segments = [{ id: generateId('seg_'), text: patch.content }]
            }
            // else: preserve existing text_segments — the streaming-time
            // appendTextToMessage already kept `content` in sync, so the
            // server's value should match anyway.
          }
          if (patch.reasoning !== undefined) {
            const existingRSegs = m.reasoning_segments || []
            const hasMultiRSegs = existingRSegs.length > 1
              || (existingRSegs.length === 1 && existingRSegs[0].after_tool_call_id)
            if (!hasMultiRSegs) {
              next.reasoning_segments = [{ id: generateId('rseg_'), text: patch.reasoning }]
            }
          }
          return next
        }),
      },
    })
  },

  appendTextToMessage: (sessionId, messageId, text) => {
    if (!text) return
    const list = get().messages[sessionId] || []
    set({
      messages: {
        ...get().messages,
        [sessionId]: list.map((m) => {
          if (m.id !== messageId) return m
          // Append to the last text segment (creating one if needed) and
          // keep `content` in sync so persistence / external consumers still
          // see the full string.
          const segs = m.text_segments && m.text_segments.length > 0
            ? [...m.text_segments]
            : [{ id: generateId('seg_'), text: '' } as TextSegment]
          const last = segs[segs.length - 1]
          segs[segs.length - 1] = { ...last, text: last.text + text }
          return {
            ...m,
            text_segments: segs,
            content: segs.map((s) => s.text).filter(Boolean).join('\n\n'),
            updated_at: Date.now(),
          }
        }),
      },
    })
  },

  appendReasoningToMessage: (sessionId, messageId, text) => {
    if (!text) return
    const list = get().messages[sessionId] || []
    set({
      messages: {
        ...get().messages,
        [sessionId]: list.map((m) => {
          if (m.id !== messageId) return m
          const segs = m.reasoning_segments && m.reasoning_segments.length > 0
            ? [...m.reasoning_segments]
            : [{ id: generateId('rseg_'), text: '' } as ReasoningSegment]
          const last = segs[segs.length - 1]
          segs[segs.length - 1] = { ...last, text: last.text + text }
          return {
            ...m,
            reasoning_segments: segs,
            reasoning: segs.map((s) => s.text).filter(Boolean).join('\n\n'),
            updated_at: Date.now(),
          }
        }),
      },
    })
  },

  startStreamingLog: (sessionId) => {
    const id = get().addMessage(sessionId, {
      role: 'assistant',
      content: '',
      reasoning: '',
      tool_calls: [],
      streaming: true,
      text_segments: [{ id: generateId('seg_'), text: '' }],
      reasoning_segments: [{ id: generateId('rseg_'), text: '' }],
    })
    set({ streamingLogId: { ...get().streamingLogId, [sessionId]: id } })
    return id
  },

  appendToStreamingLog: (sessionId, text) => {
    if (!text) return
    const logId = get().streamingLogId[sessionId]
    if (logId) {
      get().appendTextToMessage(sessionId, logId, text)
    }
  },

  appendReasoningToStreamingLog: (sessionId, text) => {
    if (!text) return
    const logId = get().streamingLogId[sessionId]
    if (logId) {
      get().appendReasoningToMessage(sessionId, logId, text)
    }
  },

  stopStreamingLog: (sessionId) => {
    set({ streamingLogId: { ...get().streamingLogId, [sessionId]: null } })
  },

  cacheStartedToolCall: (sessionId, messageId, toolCall) => {
    // Don't render yet — stash so we can pair it with the matching finished
    // event and present one card with both started_at and full arguments.
    const pending = new Map(get().pendingStartedToolCalls)
    pending.set(`${sessionId}:${messageId}:${toolCall.call_id}`, toolCall)
    set({ pendingStartedToolCalls: pending })
  },

  applyFinishedToolCall: (sessionId, messageId, callId, result, success, duration, name, args) => {
    // Recover the started_at from the pending cache so order is stable.
    const key = `${sessionId}:${messageId}:${callId}`
    const pending = new Map(get().pendingStartedToolCalls)
    const cached = pending.get(key)
    pending.delete(key)

    // If the tool_call_started was somehow never sent (e.g. dropped event),
    // use the finished event's arguments — still render a card. An empty
    // object from the finished event must not erase the started event's
    // arguments (runtime item.completed carries input only on item.started).
    const finishedArgs = args && Object.keys(args).length > 0 ? args : undefined
    const toolCall: ToolCall = {
      call_id: callId,
      name: name || cached?.name || 'tool',
      arguments: finishedArgs ?? cached?.arguments ?? {},
      result,
      success,
      duration,
      started_at: cached?.started_at ?? Date.now(),
      finished_at: Date.now(),
    }
    if (!success) {
      toolCall.finished_at = Date.now()
    }

    const list = get().messages[sessionId] || []
    set({
      pendingStartedToolCalls: pending,
      messages: {
        ...get().messages,
        [sessionId]: list.map((m) => {
          if (m.id !== messageId) return m
          // Replace any existing tool call with the same call_id to avoid
          // duplicate React keys when the backend retries or emits the event
          // more than once.
          const existing = m.tool_calls.filter((tc) => tc.call_id !== callId)
          // Push a fresh empty text + reasoning segment so subsequent
          // streaming tokens land in a NEW bubble (article-style flow:
          // text → tool → text → tool → …). Only push if we don't already
          // have a trailing empty segment for this call_id (idempotent on
          // duplicate finished events).
          const textSegs = m.text_segments && m.text_segments.length > 0
            ? [...m.text_segments]
            : [{ id: generateId('seg_'), text: m.content || '' } as TextSegment]
          const lastText = textSegs[textSegs.length - 1]
          if (!lastText || (lastText.after_tool_call_id !== callId && (lastText.text || lastText.after_tool_call_id))) {
            textSegs.push({ id: generateId('seg_'), text: '', after_tool_call_id: callId })
          }
          const reasonSegs = m.reasoning_segments && m.reasoning_segments.length > 0
            ? [...m.reasoning_segments]
            : [{ id: generateId('rseg_'), text: m.reasoning || '' } as ReasoningSegment]
          const lastReason = reasonSegs[reasonSegs.length - 1]
          if (!lastReason || (lastReason.after_tool_call_id !== callId && (lastReason.text || lastReason.after_tool_call_id))) {
            reasonSegs.push({ id: generateId('rseg_'), text: '', after_tool_call_id: callId })
          }
          return {
            ...m,
            tool_calls: [...existing, toolCall],
            text_segments: textSegs,
            reasoning_segments: reasonSegs,
            updated_at: Date.now(),
          }
        }),
      },
    })
  },

  clearPendingToolCalls: (sessionId, messageId) => {
    const pending = new Map(get().pendingStartedToolCalls)
    let changed = false
    for (const key of Array.from(pending.keys())) {
      if (key.startsWith(`${sessionId}:${messageId}:`)) {
        pending.delete(key)
        changed = true
      }
    }
    if (changed) {
      set({ pendingStartedToolCalls: pending })
    }
  },

  clearMessages: (sessionId) => {
    // Abort any in-flight SSE stream before clearing. Without this, the
    // stream's finally-block in ChatView never runs (the SSE connection
    // hangs after the server-side session context is wiped), leaving
    // isStreaming stuck at true — which blocks sending in ALL sessions.
    const abort = get().streamingAbort
    if (abort) {
      abort.abort()
    }
    set({
      messages: { ...get().messages, [sessionId]: [] },
      isStreaming: false,
      streamingAbort: null,
      streamingLogId: { ...get().streamingLogId, [sessionId]: null },
    })
    // Keep the optimistic UI and the durable Runtime projection in sync.
    // The Rust endpoint retains the thread while removing its turns/items.
    void apiClient.clearSessionMessages(sessionId).catch((e) => {
      console.error('[session] clearSessionMessages failed:', e)
    })
  },

  persistNewMessage: async (sessionId, messageId) => {
    const msg = get().messages[sessionId]?.find((m) => m.id === messageId)
    if (!msg) {
      console.warn('[session] persistNewMessage: message not found', sessionId, messageId)
      return
    }
    try {
      await apiClient.addMessage(sessionId, {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        reasoning: msg.reasoning || null,
        tool_calls: msg.tool_calls,
        input_tokens: msg.input_tokens ?? null,
        output_tokens: msg.output_tokens ?? null,
        error: msg.error ?? null,
        streaming: msg.streaming,
        created_at: msg.created_at,
        updated_at: msg.updated_at,
      })
    } catch (e) {
      console.error('[session] persistNewMessage failed:', e)
    }
  },

  persistMessage: async (sessionId, messageId) => {
    const msg = get().messages[sessionId]?.find((m) => m.id === messageId)
    if (!msg) {
      console.warn('[session] persistMessage: message not found', sessionId, messageId)
      return
    }
    try {
      await apiClient.updateMessage(sessionId, messageId, {
        content: msg.content,
        reasoning: msg.reasoning || null,
        tool_calls: msg.tool_calls,
        input_tokens: msg.input_tokens ?? null,
        output_tokens: msg.output_tokens ?? null,
        error: msg.error ?? null,
        streaming: msg.streaming,
      })
    } catch (e) {
      console.error('[session] persistMessage failed:', e)
    }
  },

  setStreaming: (streaming, abort) => {
    if (streaming && abort) {
      set({ isStreaming: true, streamingAbort: abort })
    } else if (!streaming) {
      set({ isStreaming: false, streamingAbort: null })
    } else {
      set({ isStreaming: streaming })
    }
  },

  // ===========================================================================
  // Server sync
  // ===========================================================================

  loadFromServer: async () => {
    try {
      const serverSessions = await apiClient.listSessions()
      const ephemeralIds = readEphemeralSet()
      // Map ServerSession -> ChatSession (drop server-only fields)
      const sessions: ChatSession[] = serverSessions
        .filter((s) => !ephemeralIds.has(s.id))
        .map((s) => ({
          id: s.id,
          title: s.title,
          remote_session_id: s.remote_session_id || undefined,
          provider: s.provider || undefined,
          pinned: s.pinned,
          created_at: s.created_at,
          updated_at: s.updated_at,
        }))
      // Keep any live in-memory ephemeral chats visible in this app session.
      const liveEphemeral = get().sessions.filter((s) => s.ephemeral && ephemeralIds.has(s.id))
      const merged = [...liveEphemeral, ...sessions]
      set({
        sessions: merged,
        // Loading history should not open a conversation automatically. The
        // user chooses a session from the sidebar or creates a new one.
        activeSessionId: null,
        loaded: true,
        loadError: null,
      })
    } catch (e: any) {
      console.error('[session] loadFromServer failed:', e)
      // Keep `loaded: false` so the App.tsx init effect can retry once
      // connState recovers. Previously this set `loaded: true`, which
      // permanently blocked retries and left the user with an empty UI
      // whenever the first load happened to race with backend startup.
      set({
        loaded: false,
        loadError: e instanceof Error ? e : new Error(String(e?.message || e)),
      })
    }
  },

  migrateFromLocalStorage: async () => {
    // Embedded Rust Runtime sessions are authoritative on disk. Do not read
    // the retired browser localStorage snapshot, even when it still exists.
    if (apiClient.usesEmbeddedRuntime) return

    // Idempotent — flag prevents re-running
    if (localStorage.getItem(MIGRATION_FLAG_KEY) === '1') return
    const { sessions, messages } = loadLegacyFromStorage()
    if (sessions.length === 0) {
      // Nothing to migrate — still set the flag so we don't keep checking.
      localStorage.setItem(MIGRATION_FLAG_KEY, '1')
      return
    }
    try {
      // Map ChatSession -> ServerSession shape (loosely)
      const serverSessions = sessions.map((s) => ({
        id: s.id,
        title: s.title,
        remote_session_id: s.remote_session_id || null,
        provider: s.provider || null,
        pinned: !!s.pinned,
        created_at: s.created_at,
        updated_at: s.updated_at,
      }))
      // Map messages dict -> { session_id: ServerMessage[] }
      const serverMessages: Record<string, any[]> = {}
      for (const [sid, msgs] of Object.entries(messages)) {
        serverMessages[sid] = msgs.map((m) => ({
          id: m.id,
          session_id: sid,
          role: m.role,
          content: m.content || '',
          reasoning: m.reasoning || null,
          tool_calls: m.tool_calls || [],
          input_tokens: m.input_tokens ?? null,
          output_tokens: m.output_tokens ?? null,
          error: m.error ?? null,
          streaming: !!m.streaming,
          created_at: m.created_at,
          updated_at: m.updated_at,
        }))
      }
      await apiClient.migrateSessions({
        sessions: serverSessions,
        messages: serverMessages,
      })
      // Clear localStorage + set migration flag
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      localStorage.setItem(MIGRATION_FLAG_KEY, '1')
      console.log(`[session] migrated ${sessions.length} sessions from localStorage to SQLite`)
    } catch (e) {
      console.error('[session] migrateFromLocalStorage failed (will retry next boot):', e)
    }
  },
}))
