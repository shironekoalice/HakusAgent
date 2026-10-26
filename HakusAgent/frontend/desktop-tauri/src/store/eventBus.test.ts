import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionEvents,
  getSessionEventCursor,
  ingestSessionEvent,
  subscribeToSessionEvents,
} from './eventBus'
import type { AgentEvent } from '@/api/types'

function textDelta(text: string): AgentEvent {
  return { event_type: 'text_delta', text } as AgentEvent
}

afterEach(() => {
  clearSessionEvents('s_test')
  vi.restoreAllMocks()
})

describe('shared session event bus', () => {
  it('fans events out to subscribers and advances the cursor', () => {
    const seen: number[] = []
    subscribeToSessionEvents('s_test', ({ ledgerSeq }) => seen.push(ledgerSeq ?? -1))

    expect(ingestSessionEvent('s_test', textDelta('a'), 7)).toBe(true)
    expect(ingestSessionEvent('s_test', textDelta('b'), 9)).toBe(true)

    expect(seen).toEqual([7, 9])
    expect(getSessionEventCursor('s_test')).toBe(9)
  })

  it('lets a subscriber join mid-turn and receive only later events', () => {
    ingestSessionEvent('s_test', textDelta('before-subscriber'), 1)

    const seen: string[] = []
    subscribeToSessionEvents('s_test', ({ event }) => {
      if (event.event_type === 'text_delta') seen.push(event.text)
    })

    ingestSessionEvent('s_test', textDelta('after-subscriber'), 2)
    expect(seen).toEqual(['after-subscriber'])
  })

  it('drops replayed events at or below the cursor before fan-out', () => {
    const handler = vi.fn()
    subscribeToSessionEvents('s_test', handler)

    expect(ingestSessionEvent('s_test', textDelta('a'), 5)).toBe(true)
    expect(ingestSessionEvent('s_test', textDelta('replay-5'), 5)).toBe(false)
    expect(ingestSessionEvent('s_test', textDelta('replay-4'), 4)).toBe(false)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(getSessionEventCursor('s_test')).toBe(5)
  })

  it('fans out events without a ledger seq but leaves the cursor untouched', () => {
    subscribeToSessionEvents('s_test', () => {})
    ingestSessionEvent('s_test', textDelta('compat'))
    expect(getSessionEventCursor('s_test')).toBeNull()
  })

  it('unsubscribes cleanly and isolates a throwing subscriber', () => {
    const boom = vi.fn(() => {
      throw new Error('subscriber bug')
    })
    const fine = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeToSessionEvents('s_test', boom)
    const unsubscribe = subscribeToSessionEvents('s_test', fine)

    unsubscribe()
    ingestSessionEvent('s_test', textDelta('a'), 1)

    expect(fine).not.toHaveBeenCalled()
    expect(boom).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('keeps sessions isolated from each other', () => {
    const a = vi.fn()
    subscribeToSessionEvents('s_a', a)
    ingestSessionEvent('s_b', textDelta('b event'), 1)
    expect(a).not.toHaveBeenCalled()
    expect(getSessionEventCursor('s_a')).toBeNull()
    expect(getSessionEventCursor('s_b')).toBe(1)
    clearSessionEvents('s_a')
    clearSessionEvents('s_b')
  })
})
