import { create } from 'zustand'
import {
  classifyStreamFailure,
  type SessionStreamPhase,
} from '@/lib/streamPolicy'

/**
 * Per-session turn-stream state (Phase 6 Slice C: consistent connection
 * states).
 *
 * The app-level connection store (`store/connection.ts`) answers "is the
 * Runtime reachable at all". This store answers a different question per
 * session: is the canonical SSE turn stream currently delivering, and if
 * not, why not — so ChatView and every bus-consuming panel render the same
 * non-live states instead of inventing their own:
 *
 * - `live`               — events are arriving on the stream;
 * - `reconnecting`       — a transient failure; the producer is resuming;
 * - `stale`              — the projection may be behind the ledger (bus
 *                          consumers show data but must not claim liveness);
 * - `failed`             — reconnect budget exhausted; user action required;
 * - `permission_required`— the Runtime answered 401/403; retrying cannot
 *                          succeed.
 */

interface SessionStreamStore {
  phases: Record<string, SessionStreamPhase>
  errors: Record<string, string | null>
  /** Mark the stream as delivering events (idempotent, no re-render churn). */
  markLive: (sessionId: string) => void
  /** Record that the producer is resuming after a dropped stream. */
  markReconnecting: (sessionId: string, attempt: number) => void
  /**
   * Record a turn-stream failure; returns the resulting phase, or null when
   * the failure class requires no state change (e.g. a user abort).
   */
  reportStreamFailure: (sessionId: string, error: unknown, attempts: number) => SessionStreamPhase | null
  /** Downgrade a live stream to stale (projection may be behind). */
  markStale: (sessionId: string) => void
  clearSessionStream: (sessionId: string) => void
}

export const useSessionStreamStore = create<SessionStreamStore>((set, get) => ({
  phases: {},
  errors: {},

  markLive: (sessionId) => {
    if (get().phases[sessionId] === 'live') return
    set((s) => ({
      phases: { ...s.phases, [sessionId]: 'live' },
      errors: { ...s.errors, [sessionId]: null },
    }))
  },

  markReconnecting: (sessionId, attempt) => {
    set((s) => ({
      phases: { ...s.phases, [sessionId]: 'reconnecting' },
      errors: {
        ...s.errors,
        [sessionId]: `stream interrupted (reconnect attempt ${attempt})`,
      },
    }))
  },

  reportStreamFailure: (sessionId, error, attempts) => {
    const phase = classifyStreamFailure(error, attempts)
    if (!phase) return null
    set((s) => ({
      phases: { ...s.phases, [sessionId]: phase },
      errors: {
        ...s.errors,
        [sessionId]: error instanceof Error ? error.message : String(error),
      },
    }))
    return phase
  },

  markStale: (sessionId) => {
    // Stale means "data may be behind", which must not mask a hard failure
    // or a permission wall — only a live (or absent) stream is downgraded.
    const current = get().phases[sessionId]
    if (current !== 'live' && current !== undefined) return
    set((s) => ({ phases: { ...s.phases, [sessionId]: 'stale' } }))
  },

  clearSessionStream: (sessionId) => {
    set((s) => {
      const phases = { ...s.phases }
      const errors = { ...s.errors }
      delete phases[sessionId]
      delete errors[sessionId]
      return { phases, errors }
    })
  },
}))

/** Standalone helper for non-hook callers (e.g. session deletion). */
export function clearSessionStream(sessionId: string): void {
  useSessionStreamStore.getState().clearSessionStream(sessionId)
}
