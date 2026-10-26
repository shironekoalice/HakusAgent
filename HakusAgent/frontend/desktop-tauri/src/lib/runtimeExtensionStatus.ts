import type { RuntimeExtensionStatus } from '@/api/types'

type ExtensionState = RuntimeExtensionStatus['state']

const EXTENSION_STATES: ExtensionState[] = ['started', 'unavailable', 'rejected', 'crashed']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function safeState(value: unknown, running: boolean): ExtensionState {
  return typeof value === 'string' && EXTENSION_STATES.includes(value as ExtensionState)
    ? value as ExtensionState
    : running ? 'started' : 'unavailable'
}

/** Keep untrusted extension text out of the webview projection. */
function safeError(value: unknown, fallback: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 240) return fallback
  if (/https?:\/\/|[A-Za-z]:\\|(?:^|\s)\/(?:[^\s/]+\/)+/i.test(normalized)) return fallback
  return normalized
}

export function projectRuntimeExtensionStatus(
  value: unknown,
  extensionId: string,
  unavailableError: string,
): RuntimeExtensionStatus {
  const record = isRecord(value) ? value : {}
  const running = record.running === true
  return {
    extension_id: extensionId,
    state: safeState(record.state, running),
    running,
    pid: running ? safePid(record.pid) : null,
    error: running ? null : safeError(record.error, unavailableError),
  }
}

