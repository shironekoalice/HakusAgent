/**
 * Turn-stream failure policy (Phase 6 Slice C: consistent connection
 * states).
 *
 * Pure decision logic shared by the Runtime client (which performs the
 * actual SSE resume loop) and the session-stream store (which records the
 * phase the UI renders). Kept free of imports so both sides can use it
 * without a dependency cycle.
 */

export type SessionStreamPhase =
  | 'live'
  | 'reconnecting'
  | 'stale'
  | 'failed'
  | 'permission_required'

/** Reconnect attempts before the stream is declared failed. */
export const MAX_STREAM_RECONNECT_ATTEMPTS = 3

/** Bounded backoff: 500ms, 1000ms, 2000ms… capped at 4s. */
export function nextReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 4000)
}

/**
 * Map a turn-stream failure to the phase the UI should show, or null when
 * the failure needs no state change at all.
 *
 * - A user-intended abort (stop button, rewind, voice interruption)
 *   surfaces as AbortError: the stream ended on purpose, so no banner may
 *   appear.
 * - 401/403 are terminal: retrying cannot succeed, so the phase is
 *   permission_required regardless of the attempt budget. Status is read
 *   structurally (HakusAIError carries it) to keep this module import-free.
 * - Anything else is transient until the attempt budget is exhausted.
 */
export function classifyStreamFailure(
  error: unknown,
  attempts: number,
): SessionStreamPhase | null {
  if (error instanceof Error && error.name === 'AbortError') return null
  const status = (error as { status?: unknown } | null)?.status
  if (status === 401 || status === 403) return 'permission_required'
  if (attempts < MAX_STREAM_RECONNECT_ATTEMPTS) return 'reconnecting'
  return 'failed'
}
