import { describe, expect, it } from 'vitest'
import {
  MAX_STREAM_RECONNECT_ATTEMPTS,
  classifyStreamFailure,
  nextReconnectDelay,
} from './streamPolicy'

/** HakusAIError-shaped error (client.ts sets .status; kept structural here). */
function httpLike(status: number): Error {
  const error = new Error(`HTTP ${status}`) as Error & { status?: number }
  error.status = status
  return error
}

describe('classifyStreamFailure', () => {
  it('maps 401 and 403 to permission_required regardless of the attempt budget', () => {
    expect(classifyStreamFailure(httpLike(401), 0)).toBe('permission_required')
    expect(classifyStreamFailure(httpLike(403), MAX_STREAM_RECONNECT_ATTEMPTS)).toBe('permission_required')
  })

  it('maps other statuses to reconnecting while the budget lasts', () => {
    expect(classifyStreamFailure(httpLike(500), 0)).toBe('reconnecting')
    expect(classifyStreamFailure(httpLike(500), MAX_STREAM_RECONNECT_ATTEMPTS - 1)).toBe('reconnecting')
  })

  it('maps exhausted non-permission failures to failed', () => {
    expect(classifyStreamFailure(httpLike(500), MAX_STREAM_RECONNECT_ATTEMPTS)).toBe('failed')
    expect(classifyStreamFailure(new Error('network gone'), MAX_STREAM_RECONNECT_ATTEMPTS)).toBe('failed')
  })

  it('returns null for a user-intended abort so no banner appears', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyStreamFailure(abort, 0)).toBeNull()
    expect(classifyStreamFailure(abort, MAX_STREAM_RECONNECT_ATTEMPTS)).toBeNull()
  })
})

describe('nextReconnectDelay', () => {
  it('grows exponentially and stays bounded', () => {
    expect(nextReconnectDelay(1)).toBe(500)
    expect(nextReconnectDelay(2)).toBe(1000)
    expect(nextReconnectDelay(3)).toBe(2000)
    expect(nextReconnectDelay(10)).toBe(4000)
  })
})
