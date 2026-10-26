import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStreamStore } from './sessionStream'

const reset = () => {
  useSessionStreamStore.setState({ phases: {}, errors: {} })
}

describe('sessionStreamStore', () => {
  beforeEach(reset)

  it('markLive is idempotent and clears the error', () => {
    const store = useSessionStreamStore.getState()
    store.markReconnecting('s1', 1)
    store.markLive('s1')
    expect(useSessionStreamStore.getState().phases.s1).toBe('live')
    expect(useSessionStreamStore.getState().errors.s1).toBeNull()
    // Second call: no change, no error resurrection.
    store.markLive('s1')
    expect(useSessionStreamStore.getState().phases.s1).toBe('live')
  })

  it('markReconnecting records the phase and attempt', () => {
    useSessionStreamStore.getState().markReconnecting('s1', 2)
    const state = useSessionStreamStore.getState()
    expect(state.phases.s1).toBe('reconnecting')
    expect(state.errors.s1).toContain('2')
  })

  it('reportStreamFailure classifies 401/403 as permission_required', () => {
    const error = Object.assign(new Error('denied'), { status: 403 })
    const phase = useSessionStreamStore.getState().reportStreamFailure('s1', error, 0)
    expect(phase).toBe('permission_required')
    expect(useSessionStreamStore.getState().phases.s1).toBe('permission_required')
  })

  it('reportStreamFailure with an exhausted budget records failed', () => {
    const phase = useSessionStreamStore.getState().reportStreamFailure('s1', new Error('gone'), 99)
    expect(phase).toBe('failed')
    expect(useSessionStreamStore.getState().phases.s1).toBe('failed')
  })

  it('markStale downgrades live and absent sessions but never masks a failure', () => {
    const store = useSessionStreamStore.getState()
    store.markLive('s1')
    store.markStale('s1')
    expect(useSessionStreamStore.getState().phases.s1).toBe('stale')

    useSessionStreamStore.getState().markStale('s2')
    expect(useSessionStreamStore.getState().phases.s2).toBe('stale')

    useSessionStreamStore.getState().reportStreamFailure('s3', Object.assign(new Error('x'), { status: 401 }), 0)
    useSessionStreamStore.getState().markStale('s3')
    expect(useSessionStreamStore.getState().phases.s3).toBe('permission_required')
  })

  it('clearSessionStream removes all state for the session', () => {
    const store = useSessionStreamStore.getState()
    store.markLive('s1')
    store.markLive('s2')
    store.clearSessionStream('s1')
    expect(useSessionStreamStore.getState().phases.s1).toBeUndefined()
    expect(useSessionStreamStore.getState().phases.s2).toBe('live')
  })
})
