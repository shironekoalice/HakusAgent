import type { RuntimeExtensionStatus } from '@/api/types'
import { projectRuntimeExtensionStatus } from '@/lib/runtimeExtensionStatus'

export const ANDROID_CELIA_EXTENSION_ID = 'voice.celia'

type ExtensionState = RuntimeExtensionStatus['state']

export interface AndroidVoiceStatus extends VoiceProcessStatus {
  state: ExtensionState
  extensionId: typeof ANDROID_CELIA_EXTENSION_ID
}

/** Project a redacted Runtime extension status into the existing voice shape. */
export function projectAndroidVoiceStatus(
  value: unknown,
  unavailableError = 'Celia extension is unavailable on Android',
): AndroidVoiceStatus {
  const runtime = projectRuntimeExtensionStatus(value, ANDROID_CELIA_EXTENSION_ID, unavailableError)
  return {
    running: runtime.running,
    pid: runtime.pid,
    startedAt: null,
    lastError: runtime.error,
    state: runtime.state,
    extensionId: ANDROID_CELIA_EXTENSION_ID,
  }
}

export function projectAndroidVoiceResult(
  value: unknown,
  action: 'start' | 'stop',
  unavailableError = 'Celia extension is unavailable on Android',
): VoiceProcessResult {
  const status = projectAndroidVoiceStatus(value, unavailableError)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  const hasExplicitError = typeof record?.error === 'string' && Boolean(record.error.trim())
  const ok = action === 'stop'
    ? record !== null && status.state === 'unavailable' && !hasExplicitError
    : status.running
  return {
    ok,
    running: status.running,
    pid: status.pid,
    error: ok ? null : status.lastError,
    ...(typeof record?.transcript === 'string' ? { text: record.transcript } : null),
  }
}

