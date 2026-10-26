import { describe, expect, it } from 'vitest'
import { agentEventToLogEvent, isTurnTerminalEvent } from './sessionLogProjection'
import type { AgentEvent } from '@/api/types'

const NOW = 1728000000000 // fixed timestamp for deterministic assertions
const TS = Math.floor(NOW / 1000)

describe('session log projection', () => {
  it('maps stream events onto session-log shapes', () => {
    const text = agentEventToLogEvent({ event_type: 'text_delta', text: 'hi' } as AgentEvent, 3, NOW)
    expect(text).toMatchObject({ type: 'text_delta', text: 'hi', turn: 3, ts: TS })

    const tool = agentEventToLogEvent(
      {
        event_type: 'tool_call_finished',
        call_id: 'c1',
        name: 'read_file',
        result: 'ok',
        success: true,
        duration: 12,
        arguments: {},
      } as AgentEvent,
      3,
      NOW,
    )
    expect(tool).toMatchObject({
      type: 'tool_call_finished',
      call_id: 'c1',
      name: 'read_file',
      success: true,
      duration_ms: 12,
      turn: 3,
    })
  })

  it('maps turn lifecycle and usage events', () => {
    expect(
      agentEventToLogEvent({ event_type: 'turn_started', turn_id: 't', model: 'm1' } as AgentEvent, 1, NOW),
    ).toMatchObject({ type: 'turn_start', model: 'm1' })
    expect(
      agentEventToLogEvent(
        { event_type: 'turn_completed', input_tokens: 10, output_tokens: 5 } as AgentEvent,
        1,
        NOW,
      ),
    ).toMatchObject({ type: 'turn_completed', input_tokens: 10, output_tokens: 5 })
    expect(
      agentEventToLogEvent({ event_type: 'turn_failed', error: 'boom', code: 'E1' } as AgentEvent, 1, NOW),
    ).toMatchObject({ type: 'turn_failed', error: 'boom', code: 'E1' })
    expect(
      agentEventToLogEvent({ event_type: 'cancelled', reason: 'user', partial_content: '' } as AgentEvent, 1, NOW),
    ).toMatchObject({ type: 'cancelled', reason: 'user' })
    expect(
      agentEventToLogEvent({ event_type: 'token_usage', input_tokens: 1, output_tokens: 2 } as AgentEvent, 1, NOW),
    ).toMatchObject({ type: 'token_usage', input_tokens: 1, output_tokens: 2 })
  })

  it('returns null for events with dedicated surfaces', () => {
    expect(
      agentEventToLogEvent({ event_type: 'goal_updated', goal: null } as AgentEvent, 1, NOW),
    ).toBeNull()
    expect(
      agentEventToLogEvent({ event_type: 'task_progress' } as unknown as AgentEvent, 1, NOW),
    ).toBeNull()
  })

  it('marks turn-terminal events for reconciliation', () => {
    expect(isTurnTerminalEvent({ event_type: 'turn_completed' } as AgentEvent)).toBe(true)
    expect(isTurnTerminalEvent({ event_type: 'turn_failed' } as AgentEvent)).toBe(true)
    expect(isTurnTerminalEvent({ event_type: 'cancelled' } as AgentEvent)).toBe(true)
    expect(isTurnTerminalEvent({ event_type: 'text_delta', text: '' } as AgentEvent)).toBe(false)
  })
})
