import type { AgentEvent } from '@/api/types'

/**
 * Shared per-session event cursor and fan-out (Phase 6: unified workbench).
 *
 * Before this module the canonical SSE stream was consumed only inside
 * ChatView's `handleAgentEvent`; every other panel learned about a turn
 * through REST polling, and "one session across panels" only held because
 * ChatView is never unmounted. This bus is the single ingestion point: the
 * stream producer (ChatView's onChunk, fed the canonical ledger `seq` by
 * api/client.ts) calls `ingestSessionEvent`, and any panel may
 * `subscribeToSessionEvents` — including mid-turn, receiving every event
 * from its subscription point onward.
 *
 * The cursor tracks the canonical ledger sequence per session. Events
 * arriving with a seq at or below the cursor are replays (e.g. a future
 * SSE resume) and are dropped before fan-out, so subscribers never see a
 * duplicated application of the same ledger event.
 */

export interface SessionEventEnvelope {
  event: AgentEvent
  /** Canonical ledger seq, when the transport provides one. */
  ledgerSeq: number | null
  receivedAt: number
}

export type SessionEventHandler = (envelope: SessionEventEnvelope) => void

interface SessionChannel {
  handlers: Set<SessionEventHandler>
  cursor: number | null
}

const channels = new Map<string, SessionChannel>()

function channelFor(sessionId: string): SessionChannel {
  let channel = channels.get(sessionId)
  if (!channel) {
    channel = { handlers: new Set(), cursor: null }
    channels.set(sessionId, channel)
  }
  return channel
}

/**
 * Feed one agent event into the bus for `sessionId`. `ledgerSeq` is the
 * canonical ledger sequence from the SSE envelope when available; compat
 * transports without a seq still fan out but leave the cursor untouched.
 * Returns false when the event was dropped as a replay.
 */
export function ingestSessionEvent(
  sessionId: string,
  event: AgentEvent,
  ledgerSeq?: number,
): boolean {
  const channel = channelFor(sessionId)
  if (typeof ledgerSeq === 'number' && Number.isFinite(ledgerSeq)) {
    if (channel.cursor !== null && ledgerSeq <= channel.cursor) return false
    channel.cursor = ledgerSeq
  }
  const envelope: SessionEventEnvelope = {
    event,
    ledgerSeq: typeof ledgerSeq === 'number' && Number.isFinite(ledgerSeq) ? ledgerSeq : null,
    receivedAt: Date.now(),
  }
  for (const handler of channel.handlers) {
    try {
      handler(envelope)
    } catch (error) {
      // A faulty subscriber must not break the stream producer.
      console.error('[eventBus] subscriber failed:', error)
    }
  }
  return true
}

/** Subscribe to a session's event fan-out; returns an unsubscribe function. */
export function subscribeToSessionEvents(
  sessionId: string,
  handler: SessionEventHandler,
): () => void {
  const channel = channelFor(sessionId)
  channel.handlers.add(handler)
  return () => {
    channel.handlers.delete(handler)
  }
}

/** Last canonical seq applied for this session, or null if none observed. */
export function getSessionEventCursor(sessionId: string): number | null {
  return channels.get(sessionId)?.cursor ?? null
}

/** Drop all cursor and subscriber state for a session (on session delete). */
export function clearSessionEvents(sessionId: string): void {
  channels.delete(sessionId)
}
