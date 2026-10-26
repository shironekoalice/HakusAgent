#!/usr/bin/env node
// Phase 8 prerequisite: static call-site audit of the legacy Python state
// writers (REFACTOR_SPEC §18 deletion condition 3: "no default-path call
// sites from rg/static analysis").
//
// For every legacy component the spec names (AgentCore, checkpoint manager,
// long-task state, rollout transcripts, session log, message persistence) we
// search the desktop DEFAULT path (TS + Tauri Rust + runtime crates) for
// references to the component's identifiers. Findings are classified:
//   - compat-read: the sanctioned Rust importer reading legacy state
//   - extension-plane: sanctioned optional spawns (voice) — not the coding path
//   - VIOLATION: anything else, which fails the audit
// Also verifies the writers_frozen gate exists in the Python session store.
//
// Run:  node scripts/phase8-call-site-audit.mjs
// Exit: 0 = pass, 1 = violation (usable as a CI gate).

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// ── Legacy components and the identifiers that mark a call site ────────────
const COMPONENTS = [
  {
    id: 'agentcore',
    file: 'hakus/agent.py',
    identifiers: ['AgentCore'],
    classification: 'retire-candidate',
  },
  {
    id: 'checkpoint-manager',
    file: 'hakus/checkpoint.py',
    identifiers: ['CheckpointManager'],
    classification: 'retire-candidate',
  },
  {
    id: 'long-task-state',
    file: 'hakus/long_task_context.py',
    identifiers: ['LongTaskContext'],
    classification: 'retire-candidate',
  },
  {
    id: 'rollout-transcripts',
    file: 'hakus/rollout.py',
    identifiers: ['RolloutRecorder', 'RolloutEvent'],
    classification: 'retire-candidate',
  },
  {
    id: 'session-log-recorder',
    file: 'hakus/session_log.py',
    identifiers: ['SessionLogRecorder'],
    classification: 'retire-candidate',
  },
  {
    id: 'message-persistence',
    file: 'src/hakusai_server/session_store.py',
    identifiers: ['add_message', 'append_truncation', 'bulk_import'],
    classification: 'retire-candidate',
  },
]

// Sanctioned non-default-path references. Everything here is deliberately
// allowed; anything outside these allow-lists is a VIOLATION.
const ALLOWLIST = [
  // The Rust compat importer READS the legacy session store (never writes).
  {
    id: 'message-persistence',
    path: 'HakusAgent/frontend/terminal/crates/state/src/lib.rs',
    reason: 'compat-read: legacy session-store discovery/import (Phase 1 importer)',
  },
  {
    id: 'message-persistence',
    path: 'HakusAgent/frontend/terminal/crates/tui/src/runtime_api.rs',
    reason: 'compat-read: legacy discovery HTTP surface',
  },
  {
    id: 'message-persistence',
    path: 'HakusAgent/frontend/terminal/crates/tui/src/runtime_threads.rs',
    reason: 'compat-read: legacy import execution',
  },
]

// Python spawn sites that are part of the optional extension plane, not the
// coding-turn default path. Listed and classified rather than hidden.
const EXTENSION_SPAWNS = [
  {
    path: 'HakusAgent/frontend/desktop-tauri/src-tauri/src/voice_cmds.rs',
    reason: 'extension-plane: voice (Celia) optional process, explicitly launched',
  },
]

const SEARCH_ROOTS = [
  'HakusAgent/frontend/desktop-tauri/src',
  'HakusAgent/frontend/desktop-tauri/src-tauri/src',
  'HakusAgent/frontend/terminal/crates',
]
const SKIP_DIRS = new Set([
  'target', 'node_modules', '.git', 'dist', '.dsh', '.dsh-coldstart',
  'build', '.next', 'coverage', '__pycache__',
])
const TEXT_EXT = new Set([
  '.rs', '.ts', '.tsx', '.js', '.mjs', '.css', '.json', '.toml', '.html',
])

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      yield* walk(full)
    } else if (TEXT_EXT.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full
    }
  }
}

const violations = []
const findings = []
const componentReport = []

for (const component of COMPONENTS) {
  const componentPath = join(ROOT, component.file)
  if (!existsSync(componentPath)) {
    violations.push({
      kind: 'missing-component-file',
      detail: `legacy component file not found: ${component.file}`,
    })
    continue
  }

  const hits = []
  for (const root of SEARCH_ROOTS) {
    const rootDir = join(ROOT, root)
    if (!existsSync(rootDir)) continue
    for (const file of walk(rootDir)) {
      const rel = relative(ROOT, file).split(sep).join('/')
      const content = readFileSync(file, 'utf8')
      for (const identifier of component.identifiers) {
        let index = content.indexOf(identifier)
        while (index !== -1) {
          hits.push({ file: rel, identifier, index })
          index = content.indexOf(identifier, index + identifier.length)
        }
      }
    }
  }

  for (const hit of hits) {
    const allow = ALLOWLIST.find(
      (rule) => rule.id === component.id && hit.file === rule.path,
    )
    findings.push({
      component: component.id,
      file: hit.file,
      identifier: hit.identifier,
      classification: allow ? 'compat-read' : 'VIOLATION',
      reason: allow?.reason,
    })
    if (!allow) {
      violations.push({
        kind: 'default-path-reference',
        detail: `${component.id}: "${hit.identifier}" referenced in ${hit.file}`,
      })
    }
  }

  componentReport.push({
    id: component.id,
    file: component.file,
    identifiers: component.identifiers,
    default_path_references: hits.length,
    compat_read_references: findings.filter(
      (f) => f.component === component.id && f.classification === 'compat-read',
    ).length,
  })
}

// Writers-freeze gate must exist (Python side honesty check).
const sessionStorePath = join(ROOT, 'src/hakusai_server/session_store.py')
const freezeGatePresent = existsSync(sessionStorePath)
  && readFileSync(sessionStorePath, 'utf8').includes('writers_frozen')
if (!freezeGatePresent) {
  violations.push({
    kind: 'freeze-gate-missing',
    detail: 'session_store.py does not contain the writers_frozen gate',
  })
}

const report = {
  generated_at_unix_ms: Date.now(),
  audit: 'phase8-static-call-site-audit',
  components: componentReport,
  findings,
  extension_plane_spawns: EXTENSION_SPAWNS.map((spawn) => ({
    path: spawn.path,
    reason: spawn.reason,
    present: existsSync(join(ROOT, spawn.path)),
  })),
  writers_frozen_gate_present: freezeGatePresent,
  violations,
  status: violations.length === 0 ? 'pass' : 'fail',
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.status === 'pass' ? 0 : 1)
