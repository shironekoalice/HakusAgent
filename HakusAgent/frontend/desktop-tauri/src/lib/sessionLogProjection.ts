import type { AgentEvent } from '@/api/types'
import type { SessionLogEvent } from '@/api/types'

/**
 * SessionLogTab projection (Phase 6 Slice B): map a live agent event from
 * the shared workbench event bus onto the session-log JSONL shape, so the
 * trajectory panel can append live events instead of polling the log
 * endpoint every 2s while streaming.
 *
 * Returns null for events the log viewer does not render (goal, plan,
 * question dialogs — those have dedicated surfaces).
 */
export function agentEventToLogEvent(
  event: AgentEvent,
  turn: number,
  now: number = Date.now(),
): SessionLogEvent | null {
  const base = { ts: Math.floor(now / 1000), turn }
  switch (event.event_type) {
    case 'turn_started':
      return { ...base, type: 'turn_start', model: event.model }
    case 'text_delta':
      return { ...base, type: 'text_delta', text: event.text }
    case 'reasoning_delta':
      return { ...base, type: 'reasoning', text: event.text }
    case 'tool_call_started':
      return {
        ...base,
        type: 'tool_call_started',
        call_id: event.call_id,
        name: event.name,
        arguments: event.arguments,
      }
    case 'tool_call_finished':
      return {
        ...base,
        type: 'tool_call_finished',
        call_id: event.call_id,
        name: event.name,
        success: event.success,
        duration_ms: event.duration,
        result_preview: event.result,
        arguments: event.arguments,
      }
    case 'token_usage':
      return {
        ...base,
        type: 'token_usage',
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_hit_tokens: event.cache_hit_tokens,
        cache_miss_tokens: event.cache_miss_tokens,
      }
    case 'turn_completed':
      return {
        ...base,
        type: 'turn_completed',
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
      }
    case 'turn_failed':
      return { ...base, type: 'turn_failed', error: event.error, code: event.code }
    case 'cancelled':
      return { ...base, type: 'cancelled', reason: event.reason }
    default:
      return null
  }
}

/** Terminal turn events: after one of these the server log is authoritative. */
export function isTurnTerminalEvent(event: AgentEvent): boolean {
  return (
    event.event_type === 'turn_completed' ||
    event.event_type === 'turn_failed' ||
    event.event_type === 'cancelled'
  )
}
