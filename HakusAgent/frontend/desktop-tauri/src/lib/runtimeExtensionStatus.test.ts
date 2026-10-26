import { describe, expect, it } from 'vitest'
import { projectRuntimeExtensionStatus } from './runtimeExtensionStatus'

describe('Runtime extension status projection', () => {
  it('keeps a crash observable after a child exits', () => {
    expect(projectRuntimeExtensionStatus(
      { state: 'crashed', running: false, pid: 1234, error: 'Extension crashed' },
      'avatar.vtuber',
      'Extension unavailable',
    )).toEqual({
      extension_id: 'avatar.vtuber',
      state: 'crashed',
      running: false,
      pid: null,
      error: 'Extension crashed',
    })
  })

  it('falls back to unavailable without exposing URL or local path details', () => {
    const status = projectRuntimeExtensionStatus(
      { state: 'rejected', running: false, error: 'http://127.0.0.1:48081 C:\\private\\bundle' },
      'voice.celia',
      'Extension unavailable',
    )
    expect(status.state).toBe('rejected')
    expect(status.error).toBe('Extension unavailable')
  })

  it('accepts only a running positive integer pid', () => {
    expect(projectRuntimeExtensionStatus({ state: 'started', running: true, pid: 4321 }, 'voice.celia', 'unavailable').pid).toBe(4321)
    expect(projectRuntimeExtensionStatus({ state: 'started', running: true, pid: '4321' }, 'voice.celia', 'unavailable').pid).toBeNull()
  })
})
