#!/usr/bin/env node
// Phase 7 static audit for the no-bundle compatibility boundary.
//
// This audit proves that optional feature planes fail closed when their
// reviewed bundles are absent. It deliberately does not claim that a feature
// bundle exists or that a compatibility facade is a migrated implementation.
// Exit 0 means every fallback contract is present; exit 1 means a required
// boundary was removed or renamed.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const checks = [
  {
    id: 'voice-bridge-unavailable',
    file: 'hakus/voice_bridge.py',
    required: [
      'unavailable_reason',
      'return False',
      'return "", None',
      'voice.celia',
    ],
    forbidden: ['subprocess', 'Popen', 'create_subprocess_exec'],
  },
  {
    id: 'celia-transcription-fail-closed',
    file: 'src/hakusai_server/celia_voice.py',
    required: [
      'def transcribe_audio_celia(',
      'del audio_path, celia_path, config_path',
      'voice.celia',
    ],
    forbidden: ['sys.path.insert', 'import celia', 'subprocess'],
  },
  {
    id: 'vtuber-unavailable',
    file: 'src/hakusai_server/vtuber_websocket.py',
    required: [
      'self.extension_id = "avatar.vtuber"',
      'self._extension_available = False',
      '"extension_unavailable"',
      'await websocket.close(code=1013',
    ],
  },
  {
    id: 'legacy-provider-boundary',
    file: 'hakus/models/legacy_provider_adapter.py',
    required: [
      'class LegacyProviderAdapter:',
      'canonical_plane: str = "rust_runtime"',
      'allow_fallback',
      'LegacyProviderRouteError',
    ],
  },
  {
    id: 'android-runtime-adapter',
    file: 'HakusAgent/frontend/desktop-tauri/src/lib/androidFeatureAdapter.ts',
    required: [
      "ANDROID_CELIA_EXTENSION_ID = 'voice.celia'",
      'projectRuntimeExtensionStatus',
      'projectAndroidVoiceResult',
    ],
  },
  {
    id: 'runtime-extension-host',
    file: 'frontend/terminal/crates/tui/src/plugins/extension_host.rs',
    required: [
      'EXTENSION_PROTOCOL_V1',
      'spawn_extension_with_registry',
      'redact_payload',
      'ExtensionEventPayload',
    ],
  },
  {
    id: 'desktop-extension-status-projection',
    file: 'HakusAgent/frontend/desktop-tauri/src/lib/runtimeExtensionStatus.ts',
    required: [
      'EXTENSION_STATES',
      'safePid',
      'safeError',
      'projectRuntimeExtensionStatus',
    ],
  },
  {
    id: 'bundle-review-inputs',
    file: 'docs/REFACTOR_EXTENSION_BUNDLE_INPUTS.md',
    required: [
      '`voice.celia`',
      '`avatar.vtuber`',
      'Legacy provider',
      'Android voice integration',
      'failed-upgrade',
      'rollback',
    ],
  },
]

const results = []
const violations = []
for (const check of checks) {
  const path = join(ROOT, check.file)
  if (!existsSync(path)) {
    violations.push({ id: check.id, reason: `missing file: ${check.file}` })
    results.push({ id: check.id, file: check.file, status: 'fail', missing: check.required })
    continue
  }
  const content = readFileSync(path, 'utf8')
  const missing = check.required.filter((needle) => !content.includes(needle))
  const forbidden = (check.forbidden ?? []).filter((needle) => content.includes(needle))
  if (missing.length > 0 || forbidden.length > 0) {
    violations.push({ id: check.id, missing, forbidden })
  }
  results.push({
    id: check.id,
    file: check.file,
    status: missing.length === 0 && forbidden.length === 0 ? 'pass' : 'fail',
    ...(missing.length > 0 ? { missing } : {}),
    ...(forbidden.length > 0 ? { forbidden } : {}),
  })
}

const report = {
  generated_at_unix_ms: Date.now(),
  audit: 'phase7-extension-fallback-audit',
  meaning: 'fallback-boundary-only; reviewed feature bundles are not inferred',
  checks: results,
  violations,
  status: violations.length === 0 ? 'pass' : 'fail',
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.status === 'pass' ? 0 : 1)

