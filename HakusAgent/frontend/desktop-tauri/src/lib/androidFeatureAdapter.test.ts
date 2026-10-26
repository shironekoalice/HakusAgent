import { describe, expect, it } from 'vitest'
import {
  ANDROID_CELIA_EXTENSION_ID,
  projectAndroidVoiceResult,
  projectAndroidVoiceStatus,
} from './androidFeatureAdapter'

describe('Android Runtime extension adapter', () => {
  it('projects an unavailable extension without exposing backend details', () => {
    const status = projectAndroidVoiceStatus({
      extension_id: 'voice.celia',
      state: 'unavailable',
      running: false,
      pid: null,
      error: 'plugin not installed',
    })

    expect(status).toMatchObject({
      running: false,
      pid: null,
      state: 'unavailable',
      extensionId: ANDROID_CELIA_EXTENSION_ID,
      lastError: 'plugin not installed',
    })
  })

  it('projects a running extension and accepts only a safe pid', () => {
    const status = projectAndroidVoiceStatus({ state: 'started', running: true, pid: 4312 })
    expect(status).toMatchObject({ running: true, pid: 4312, lastError: null, state: 'started' })

    const invalidPid = projectAndroidVoiceStatus({ state: 'started', running: true, pid: '4312' })
    expect(invalidPid.pid).toBeNull()
  })

  it('treats stop as idempotent when Runtime reports unavailable', () => {
    expect(projectAndroidVoiceResult({ state: 'unavailable', running: false }, 'stop')).toEqual({
      ok: true,
      running: false,
      pid: null,
      error: null,
    })
    expect(projectAndroidVoiceResult({ state: 'unavailable', running: false }, 'start').ok).toBe(false)
    expect(projectAndroidVoiceResult(undefined, 'stop', 'Runtime extension unavailable')).toMatchObject({
      ok: false,
      error: 'Runtime extension unavailable',
    })
  })

  it('uses a generic fallback for Runtime request failures and unsafe error text', () => {
    const status = projectAndroidVoiceStatus(
      { state: 'crashed', running: false, error: 'http://127.0.0.1:48081/v1/extensions/voice.celia C:\\secret\\token' },
      'Runtime extension unavailable',
    )
    expect(status.lastError).toBe('Runtime extension unavailable')
    expect(projectAndroidVoiceResult(undefined, 'start', 'Runtime extension unavailable')).toEqual({
      ok: false,
      running: false,
      pid: null,
      error: 'Runtime extension unavailable',
    })
  })
})
