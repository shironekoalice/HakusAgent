# HakusAgent Unified Workbench Refactor Specification

Status: Draft for implementation
Version: 1.0.0-draft
Date: 2026-10-02
Owners: HakusAgent runtime and desktop maintainers

This document is the executable specification for the HakusAgent refactor. It
supersedes the shorter direction notes in `ARCHITECTURE_TARGET.md` when an
implementation decision needs a precise contract. The comparison note in
`COMPARISON_ZCODE_DEEPSEEK_HARNESS.md` explains why the decisions below combine
ZCode product patterns with DeepSeek Harness runtime boundaries.

The specification is deliberately written against the repository as it exists
today. Statements under **Current fact** describe code that was found during
the inventory. Statements under **Target contract** are requirements for the
refactor. A target contract is not considered implemented until its tests and
exit criteria pass.

## 1. Product contract

### 1.1 Product identity

HakusAgent is a Windows-first coding workbench for an individual developer.
It must remain useful on one local machine before any remote or team service is
available. Remote workspaces are first-class, in this order:

1. SSH
2. WSL
3. Docker

Enterprise/team capabilities remain supported, but they must not add a daemon,
login flow, network dependency, or memory-heavy service to the local-only path.

Voice, Live2D/VRM, VTuber, streaming, Android, legacy providers, and custom
Python services are optional extensions. They must not be required to launch,
select a workspace, execute a local task, or recover a session.

### 1.2 User-visible vertical slice

The first release gate is one coherent slice that supports all of the following
from the desktop workbench:

- select a local, SSH, WSL, or Docker workspace;
- discover and search files;
- read files and apply single or batch edits;
- run a command, test, build, or log stream;
- inspect Git diff and prepare a review or rollback;
- create a plan and run a long task;
- pause, resume, cancel, and recover a task;
- spawn bounded subagents;
- choose a model and inspect provider health;
- use MCP, Skills, and plugins through the same approval policy;
- observe all of the above through one ordered event stream.

The workbench presents Chat, Editor, Terminal, Tasks, and Review as peer panels.
Chat may be the default focused panel, but no feature may require opening a
chat-specific dialog to reach its primary state.

### 1.3 Non-functional budgets

These are release gates, not aspirations:

| Budget | Requirement | Measurement |
|---|---|---|
| Cold start | Main window usable within 5 seconds | median and p95 over 10 clean launches |
| Idle memory | <= 450 MB working set | after startup, no model server/container |
| Local turn | first runtime event <= 300 ms after submit | local workspace, warm runtime |
| Event ordering | no duplicate or decreasing sequence | protocol conformance test |
| Cancellation | no post-acknowledgement workspace mutation | kill/trace test |
| Recovery | replay produces identical model-visible history | golden ledger replay |
| Provider health | no credential in response/log/event | redaction test |
| Remote reconnect | reconnect does not fork a session history | SSH/WSL reconnect test |

Memory and startup measurements must record the reference machine, OS build,
build profile, enabled extensions, and whether the dev server is present.

## 2. Repository inventory and boundary

### 2.1 Current facts

The repository currently contains these relevant execution planes:

| Area | Current location | Current role | Refactor disposition |
|---|---|---|---|
| Rust protocol | `frontend/terminal/crates/protocol` | runtime, fleet, event and API types | canonical shared contract |
| Rust runtime/TUI | `frontend/terminal/crates/tui` | runtime API, Fleet manager/executor, TUI | canonical execution plane |
| Rust policy | `frontend/terminal/crates/execpolicy` | command/path approval rules | canonical policy engine |
| Rust state | `frontend/terminal/crates/state` | SQLite threads, messages, checkpoints | canonical durable state after migration |
| Rust providers | `frontend/terminal/crates/llm`, `agent`, `config` | provider registry and model calls | canonical provider path |
| Desktop UI | `HakusAgent/frontend/desktop-tauri/src` | React/Tauri workbench | projection/client only |
| Desktop bridge | `HakusAgent/frontend/desktop-tauri/src/api` | runtime and Tauri bridge | versioned client adapter |
| Python server | `src/hakusai_server` | HTTP/WS sidecar, session store, AgentCore bridge | compatibility extension during migration |
| Python AgentCore | `hakus/agent.py`, `hakus/agent_v2.py` | legacy turn execution | freeze, then retire from default path |
| Python state | `src/hakusai_server/session_store.py`, `hakus/checkpoint.py` | messages, event rows, checkpoints | read-only migration/import, then retire |
| Python orchestration | `hakus/orchestrator.py`, `hakus/long_running_agent.py` | long tasks and recovery | port behavior to Rust ledger/task service |
| Legacy UI paths | repository-specific old Vue/sidecar paths | compatibility | remove only after diagnostics pass |

The current code already has useful pieces: `RuntimeEventEnvelope`, Fleet
`FleetHostSpec`, Rust execution policy decisions, OpenAI-compatible providers,
Python append-only session events, and desktop panels. The problem is that these
pieces do not yet share one authority or one lifecycle contract.

### 2.2 Current architectural defects to eliminate

The following are explicitly in scope:

1. Python AgentCore and Rust runtime can both be treated as turn authorities.
2. Python messages, Python event rows, Rust state rows, checkpoints, rollout
   logs, and long-task JSON files can describe overlapping truth.
3. Desktop streaming updates in-memory state and persists at stream boundaries,
   which makes recovery depend on the client and sidecar path.
4. Workspace-specific branches can leak into orchestration instead of stopping
   at Fleet adapters.
5. Approval vocabulary and behavior differs between Python Guardian paths and
   Rust `execpolicy` paths.
6. The desktop layout contains a strong chat/page center even where the target
   requires peer workbench panels.
7. Optional extension startup can affect the critical local launch path.

### 2.3 Boundary rule

The runtime owns execution, persistence, ordering, permissions, and transport.
The desktop owns presentation, panel composition, user input, and local UI
preferences. A desktop component must never directly spawn a workspace tool or
write a session record. A Python extension may request a capability through the
versioned extension protocol, but may not open or mutate the runtime database.

## 3. Target topology

### 3.1 Process topology

The default local deployment has one desktop process and one embedded Rust
runtime. The runtime may expose loopback HTTP plus SSE or WebSocket, but the
transport is an implementation detail behind the runtime client.

```text
Desktop Tauri shell
  React workbench / projections / user actions
          |
          | Runtime API v1 (loopback HTTP + SSE/WS)
          v
Embedded Rust Runtime
  Session Ledger -> Policy -> Agent Loop -> Capability Registry
       |                |          |              |
       |                |          |              +-- Provider / MCP / Skills
       |                |          +-- Workspace capability
       |                +-- allow / ask / deny
       +-- SQLite event log and projections
                                  |
                          Local / SSH / WSL / Docker

Optional Python extension host
  voice / VTuber / legacy provider / domain plugin
  talks to Runtime API; never owns session truth
```

### 3.2 Runtime modules

The Rust runtime is split into explicit modules. A module may depend only on
modules below it in this list, except that the API layer can depend on all
runtime services:

1. `protocol`: versioned wire types and validation;
2. `state`: SQLite schema, migrations, event append/replay, projections;
3. `execpolicy`: capability risk and approval decision;
4. `fleet`: workspace discovery, transport, process lifecycle;
5. `llm` and `agent`: provider calls and model-visible turn loop;
6. `tools`: capability registration and invocation;
7. `workflow`: plan/task/subagent orchestration;
8. `app-server` / runtime API: HTTP, SSE/WS, auth and lifecycle;
9. desktop bridge: client-side adaptation only.

No module above `fleet` may inspect SSH, WSL, or Docker command lines. No module
above `execpolicy` may invent approval results. The agent loop may request a
decision; the policy service owns the decision.

### 3.3 Lifecycle ownership

| Resource | Owner | Created by | Destroyed by |
|---|---|---|---|
| Runtime process | Tauri/Rust host | desktop startup | desktop shutdown |
| Session | state service | `POST /v1/sessions` | archive/delete policy |
| Turn | agent loop | `POST /v1/sessions/{id}/turns` | complete/cancel/fail |
| Workspace | Fleet manager | workspace selection | dispose/explicit removal |
| Worker process | Fleet adapter | task execution | stop + tree cleanup |
| Approval request | policy service | capability invocation | decision/expiry |
| Extension host | extension manager | opt-in activation | deactivate/crash cleanup |

## 4. Versioning and compatibility

### 4.1 Versions

Every externally consumed contract has an independent version:

- Runtime API: `v1` in URL and capability response;
- event envelope: integer `schema_version`, initially `1`;
- capability declaration: `capability_schema_version`, initially `1`;
- extension protocol: `hakus.extension.v1`;
- persisted state schema: SQLite migration number;
- workspace adapter contract: Rust trait version recorded in diagnostics.

Backward compatibility is required within one major version. A client must
reject a newer major version with a structured `unsupported_version` error. A
server must preserve unknown event payload fields when forwarding or storing
them, but must reject an event with missing required envelope fields.

### 4.2 Runtime error envelope

All non-2xx responses and terminal stream errors use this shape:

```json
{
  "error": {
    "code": "permission_required",
    "message": "Human-readable explanation",
    "retryable": false,
    "rule_id": "workspace.write.default",
    "correlation_id": "corr_01J...",
    "details": {}
  }
}
```

`message` is safe for UI display. Secrets, command tokens, raw provider
responses, and unredacted environment values are forbidden in `details`.

## 5. Event ledger contract

### 5.1 Event envelope

The event ledger is the only authority for model-visible state. The canonical
serialized envelope is:

```json
{
  "schema_version": 1,
  "event_id": "evt_01J...",
  "event_type": "tool_call_started",
  "session_id": "ses_01J...",
  "workspace_id": "ws_01J...",
  "turn_id": "turn_01J...",
  "correlation_id": "corr_01J...",
  "parent_event_id": null,
  "seq": 42,
  "timestamp": "2026-10-02T12:00:00.123Z",
  "actor": { "kind": "runtime", "id": "runtime" },
  "visibility": "model_and_ui",
  "payload": {}
}
```

Required invariants:

- `event_id` is globally unique and immutable;
- `(session_id, seq)` is unique;
- `seq` starts at 1 and increases by one per session;
- `timestamp` is wall-clock UTC and is not used for ordering;
- `correlation_id` groups one request, approval, or external operation;
- `parent_event_id` links child/subagent work;
- `workspace_id` is required for workspace-affecting events and null only for
  session/provider metadata events;
- `visibility` controls projections, never execution;
- payload is schema-validated by `event_type`.

The append operation assigns `seq` inside one SQLite transaction. Clients must
never generate sequence numbers. A failed append means the capability action
must not be reported as started.

### 5.2 Event types

The initial registry is closed for core events. Extensions use namespaced event
types and must declare them in their capability manifest.

| Event type | Required payload | Terminal |
|---|---|---|
| `session_created` | title, source | no |
| `session_archived` | reason | yes for session |
| `workspace_attached` | workspace kind, root | no |
| `workspace_detached` | reason | yes for attachment |
| `user_input_submitted` | content, attachments | no |
| `turn_started` | mode, provider, model | no |
| `model_request_started` | provider, model, message_event_ids | no |
| `model_delta` | channel, text or structured delta | no |
| `model_request_settled` | finish_reason, usage | no |
| `tool_call_started` | capability, arguments_hash | no |
| `approval_requested` | rule_id, scope, summary, expires_at | no |
| `approval_decided` | decision, rule_id, reason | no |
| `tool_output_delta` | stream, redacted_text | no |
| `tool_call_finished` | status, exit_code, result_ref | yes for tool |
| `checkpoint_created` | checkpoint_id, base_seq, reason | no |
| `subagent_started` | agent_id, role, parent_turn_id | no |
| `subagent_finished` | agent_id, status, summary_ref | yes for agent |
| `task_state_changed` | task_id, from, to, reason | no |
| `turn_paused` | reason, resume_token | yes for current execution |
| `turn_resumed` | base_seq, resume_token | no |
| `turn_cancel_requested` | reason | no |
| `turn_cancelled` | acknowledged_seq, mutation_guard | yes |
| `turn_failed` | code, retryable, safe_message | yes |
| `turn_completed` | result_ref, usage | yes |
| `provider_health_changed` | provider, state, redacted_reason | no |
| `extension_event` | extension_id, type, payload | extension-defined |

`model_delta` events may be coalesced for storage after a turn settles, but the
replayed model-visible result must remain byte-equivalent to the settled
assistant content. UI-only animation events are not ledger events.

### 5.3 Event append and replay API

The state service exposes these internal operations:

```text
append(event_without_seq) -> EventEnvelope
read(session_id, after_seq, limit) -> [EventEnvelope]
read_turn(turn_id) -> [EventEnvelope]
replay(session_id, through_seq?) -> ModelVisibleHistory
verify(session_id) -> LedgerVerification
```

`verify` checks sequence continuity, parent references, terminal turn rules,
and payload schema. It must be callable in diagnostics without mutating state.

### 5.4 Projections

Messages, task boards, review panes, usage metrics, and recovery summaries are
projections. Each projection records the last applied sequence and can be
rebuilt from the ledger. A projection may be deleted and recreated without
changing model-visible history.

The desktop may maintain an optimistic local rendering buffer for latency, but
the buffer must be reconciled by event id and discarded on reconnect. It may not
be used as the recovery source.

## 6. Durable storage

### 6.1 Canonical tables

The Rust SQLite state database must contain at least:

```sql
session(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  schema_version INTEGER NOT NULL
);

workspace(
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  root TEXT,
  spec_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

event(
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  turn_id TEXT,
  correlation_id TEXT,
  parent_event_id TEXT,
  actor_json TEXT NOT NULL,
  visibility TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

turn(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT,
  state TEXT NOT NULL,
  started_seq INTEGER NOT NULL,
  terminal_seq INTEGER,
  provider TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

checkpoint(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  base_seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

approval(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  capability TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
```

The names may adapt to the existing Rust state schema, but the semantics and
uniqueness constraints are mandatory. Message tables may remain as a derived
projection during migration; they may not be the only source of truth.

### 6.2 Checkpoint semantics

A checkpoint is an indexed recovery snapshot, not an alternate transcript. It
must contain `base_seq` and a bounded runtime state snapshot. Restoring a
checkpoint means replaying events after `base_seq` according to the selected
policy; it must never silently delete events. Rewind is represented by a
`turn_cancelled` or explicit `history_branch_created` event.

Legacy checkpoint files are imported once with an `extension_event` or
`checkpoint_created` record containing the source path and checksum. After
import, the runtime never writes the legacy format on the default path.

## 7. Runtime API v1

### 7.1 Health and capabilities

```text
GET  /v1/health
GET  /v1/capabilities
GET  /v1/diagnostics
GET  /v1/diagnostics/ledger/{session_id}
```

Health distinguishes `starting`, `ready`, `degraded`, and `stopped`. It returns
runtime version, protocol version, process start time, and redacted component
statuses. It never returns provider keys, environment values, command lines, or
workspace secrets.

Capabilities enumerate supported workspace kinds, provider features, event
schema, policy profiles, extension protocol versions, and feature gates.

### 7.2 Sessions and events

```text
POST /v1/sessions
GET  /v1/sessions
GET  /v1/sessions/{session_id}
PATCH /v1/sessions/{session_id}
POST /v1/sessions/{session_id}/archive
GET  /v1/sessions/{session_id}/events?after_seq=0&limit=500
GET  /v1/sessions/{session_id}/events/stream?after_seq=0
```

The stream sends `event` frames in sequence order and a terminal `stream_error`
frame if the connection cannot continue. A reconnect starts from the last
acknowledged sequence; clients must tolerate replay of an already-rendered
event by idempotently replacing it.

### 7.3 Turns and control

```text
POST /v1/sessions/{session_id}/turns
POST /v1/turns/{turn_id}/pause
POST /v1/turns/{turn_id}/resume
POST /v1/turns/{turn_id}/cancel
GET  /v1/turns/{turn_id}
GET  /v1/turns/{turn_id}/events
```

The turn request includes session, workspace, mode, provider, model, user
content, attachments, and an optional client idempotency key. Repeating a
request with the same key returns the existing turn instead of starting a
second model request.

### 7.4 Workspaces and capabilities

```text
POST /v1/workspaces/discover
POST /v1/workspaces
GET  /v1/workspaces/{workspace_id}
POST /v1/workspaces/{workspace_id}/connect
POST /v1/workspaces/{workspace_id}/disconnect
POST /v1/workspaces/{workspace_id}/execute
POST /v1/workspaces/{workspace_id}/read
POST /v1/workspaces/{workspace_id}/write
GET  /v1/workspaces/{workspace_id}/observe
```

All mutating calls pass through the policy service before the Fleet adapter.
The API never accepts an arbitrary executable plus an unbounded environment.

### 7.5 Provider operations

```text
GET  /v1/providers
POST /v1/providers/health
POST /v1/providers/{provider_id}/models
POST /v1/providers/{provider_id}/validate
```

Health results use exactly these stable states:

```text
healthy | unconfigured | unauthorized | forbidden | rate_limited |
unavailable | error
```

Provider credentials are resolved from the secret store or approved config
placeholders. The redacted provider id, model id, latency bucket, and state may
be logged; the credential value may not.

## 8. Capability model

### 8.1 Capability declaration

Every tool, provider, workspace, MCP server, Skill, plugin, and subagent role
declares:

```json
{
  "id": "workspace.write",
  "version": "1.0.0",
  "kind": "workspace_tool",
  "supported_workspaces": ["local", "ssh", "wsl", "docker"],
  "side_effect": "write",
  "risk": "medium",
  "approval": "policy",
  "network": "none",
  "secret_access": "none",
  "reversible": true,
  "input_schema": {},
  "output_schema": {}
}
```

The declaration is data, not a UI hint. The runtime validates it before
registration and refuses a capability that claims unsupported workspace types
or an unsafe combination of secret/network scope.

### 8.2 Permission decision

The canonical decision is:

```json
{
  "decision": "allow",
  "rule_id": "workspace.write.project",
  "reason": "Path is inside the attached workspace",
  "requires_user": false,
  "expires_at": null,
  "scope": { "workspace_id": "ws_01J...", "path_prefix": "src/" }
}
```

`decision` is one of `allow`, `ask`, or `deny`. A missing policy result is a
deny. A timeout while asking the user is a deny. Policy evaluation is pure and
testable; user presentation is handled by the desktop/TUI client.

### 8.3 Policy dimensions

The engine evaluates independently:

- workspace containment and path escape;
- read/write/delete/execute side effect;
- network egress and destination;
- credential or secret access;
- remote process control;
- destructive or irreversible operation;
- workspace trust level;
- user profile: restricted, developer, automated;
- capability-specific rules and session approvals.

Python Guardian may provide a recommendation, but it cannot replace the Rust
decision. If it is used, its recommendation is stored as diagnostic metadata
and the final `allow/ask/deny` event comes from the canonical policy service.

## 9. Workspace transport contract

### 9.1 Adapter lifecycle

Every adapter implements the same semantic lifecycle:

```text
discover -> prepare -> connect -> execute/read/write -> observe -> stop -> dispose
```

The Rust trait may use different method names, but each method must have the
following behavior:

| Stage | Required behavior |
|---|---|
| discover | enumerate valid targets without starting a worker |
| prepare | validate paths, credentials references, policy and tool availability |
| connect | create a bounded session and return an opaque connection id |
| execute | start a child under the adapter-owned process boundary |
| read/write | enforce workspace root and stream bounded data |
| observe | report status, logs, exit and heartbeat without mutating state |
| stop | request cancellation, then terminate the complete process tree |
| dispose | remove temporary resources and close transport handles |

The agent loop sees a `WorkspaceCapability`; it must not branch on `ssh`, `wsl`,
or `docker`.

### 9.2 Local adapter

Local is the reference implementation. It must provide process-tree cleanup,
bounded stdout/stderr, working-directory validation, environment allowlisting,
path containment, cancellation acknowledgement, and deterministic fake hooks.

### 9.3 SSH adapter

SSH is the first remote implementation and highest priority.

Required:

- host, port, user, identity, known-hosts and optional fingerprint pinning;
- explicit non-interactive and interactive authentication modes;
- password prompt delegated to the UI/secure input boundary when required;
- `BatchMode` only for headless mode;
- jump host and port-forward fields reserved in the spec, even if initially
  disabled behind a feature gate;
- remote working-directory validation;
- bounded environment allowlist;
- remote command execution and file read/write;
- reconnect using the same workspace id;
- redacted command diagnostics;
- fake adapter contract tests and one real smoke test against the configured
  `43.*` SSH target when credentials are supplied interactively.

The password must never be stored in the session ledger, provider config,
workspace spec, or log. A request that needs it emits `approval_requested` with
the reason `ssh_password_required` and pauses before transmission.

### 9.4 WSL adapter

Required:

- distro discovery and explicit distro selection;
- launch through `wsl.exe` with argument-array construction;
- Windows path to `/mnt/<drive>/...` translation;
- cancellation that kills the WSL worker and descendants;
- attach/reconnect semantics;
- fake contract tests plus a local real smoke test on the configured distro.

Path conversion must reject UNC paths, drive-relative paths, and paths outside
the selected workspace unless the policy explicitly allows them.

### 9.5 Docker adapter

Docker is implemented behind the same contract but real testing remains gated by
the user's explicit choice. The fake contract must cover:

- deterministic `docker run` argv construction;
- image validation;
- allowlisted environment injection;
- workspace mount policy;
- log streaming;
- stop and explicit `rm` cleanup;
- failure before/after container id acquisition;
- existing-container attach as a future feature gate.

No real Docker daemon is started as part of the current migration validation.

## 10. Agent loop and turn state machine

### 10.1 Turn states

```text
created -> planning -> awaiting_approval -> executing -> streaming
streaming -> paused | cancelling | completed | failed
paused -> resuming | cancelled
resuming -> awaiting_approval | executing | failed
cancelling -> cancelled | failed
```

Invalid transitions return `invalid_state_transition` and append no misleading
success event. A terminal state is immutable.

### 10.2 Turn algorithm

For each user turn the runtime must:

1. append `user_input_submitted`;
2. resolve session, workspace, mode, provider and model;
3. append `turn_started`;
4. reconstruct model-visible history from the ledger;
5. append `model_request_started`;
6. stream model deltas into the ledger;
7. validate each tool call as a capability;
8. evaluate policy before execution;
9. append approval events when necessary;
10. execute through Fleet and append bounded results;
11. continue the model loop or settle the request;
12. append exactly one terminal turn event.

No model request may use a client-only transcript that has not been reconciled
with the ledger. No tool result may be sent to a provider before its event is
durably appended.

### 10.3 Cancellation

Cancellation is two-phase:

1. append `turn_cancel_requested` and signal the adapter/agent cancellation
   token;
2. wait for every in-flight capability to acknowledge stop or reach a bounded
   timeout;
3. append `turn_cancelled` only after the mutation guard confirms no worker can
   continue writing.

If acknowledgement cannot be proven, the runtime reports `cancellation_pending`
and keeps the turn non-terminal. The desktop must not display cancellation as
complete merely because the button was clicked.

### 10.4 Pause and resume

Pause stops scheduling new capability work, allows the current atomic operation
to settle, creates a checkpoint at a known event sequence, then appends
`turn_paused`. Resume loads the checkpoint, verifies the ledger, and appends
`turn_resumed` before continuing. A pause may not serialize credentials or raw
provider headers.

## 11. Provider contract

### 11.1 Provider metadata

```json
{
  "id": "hy4-local",
  "display_name": "hy4 local",
  "base_url": "http://127.0.0.1:7863/v1",
  "model_id": "hy4-preview",
  "wire_format": "openai_chat_completions",
  "streaming": true,
  "tool_calls": "openai_tools",
  "vision": false,
  "context_limit": null,
  "credential_source": "secret_store",
  "health_endpoint": "/models"
}
```

The configured test route from the user is represented as provider metadata and
must never be hardcoded into the runtime. The model identifier is selectable at
runtime; a failed health check must not silently substitute a different model.

### 11.2 Compatibility

The provider layer supports OpenAI-compatible endpoints first, then explicit
DeepSeek protocol differences, followed by configured Qwen/GLM/MiMo/OpenCode/
StepFun/SenseNova and local Ollama/vLLM routes. Each provider adapter declares
tool-call, vision, context and streaming support rather than relying on model
name heuristics.

### 11.3 Health and redaction tests

Contract tests must cover healthy, unconfigured, unauthorized, forbidden,
rate-limited, unavailable, malformed, and timeout responses. Test fixtures must
assert that API keys, authorization headers, and `${ENV:...}` values never occur
in event payloads, logs, error messages, or exported diagnostics.

## 12. Desktop workbench contract

### 12.1 Panel model

The desktop shell contains these panel roles:

- `chat`: model conversation and input;
- `editor`: file tree, tabs, read/edit/diff buffer;
- `terminal`: command and live output;
- `tasks`: plan, task state, subagent progress, pause/resume/cancel;
- `review`: diff, approval, rollback and commit preparation;
- `workspace`: local/SSH/WSL/Docker selection and connection state;
- `settings`: provider, policy, extension and appearance configuration.

Panels subscribe to event projections. They do not create parallel stream
handlers that invent state transitions. Each panel must render disconnected,
reconnecting, permission-required, failed, and stale-projection states.

### 12.2 Desktop client responsibilities

The client may:

- issue idempotent runtime commands;
- optimistically render a submitted input;
- maintain an event-id indexed render cache;
- reconnect from the last sequence;
- store UI layout and non-sensitive preferences;
- request user approval and return the decision.

The client may not:

- call Python AgentCore directly on the default path;
- spawn `ssh`, `wsl.exe`, `docker`, or workspace commands;
- write the runtime SQLite database;
- treat a local transcript as canonical;
- send a provider request outside the runtime provider service.

### 12.3 Workbench acceptance

The primary window must be usable with only the workspace and chat panels. Opening
Review or Terminal must not replace the session or create a second runtime turn.
Switching panels must preserve the same event cursor and session id.

## 13. Extension plane

### 13.1 Extension manifest

```json
{
  "id": "voice.celia",
  "version": "1.0.0",
  "protocol": "hakus.extension.v1",
  "entrypoint": "python -m celia_extension",
  "capabilities": ["audio.capture", "audio.playback"],
  "permissions": ["microphone", "network:provider"],
  "supported_platforms": ["windows"],
  "checksum": "sha256:..."
}
```

Installation is staged: inspect source, validate manifest, resolve dependencies,
record checksum and permissions, then activate. Activation is scoped to user or
project. Failed activation leaves the previous version active.

### 13.2 Extension protocol

Extensions communicate with request/response messages containing protocol,
request id, extension id, event type, and redacted payload. They can request a
runtime capability and receive events; they cannot mutate session tables or
replace the policy engine. A crashed extension is isolated and reported as an
extension event; the core turn remains recoverable.

### 13.3 Migration order

1. voice and Celia bridge;
2. VTuber/Live2D/VRM and streaming;
3. legacy Python provider adapters;
4. Android-specific integrations.

Each extension must have a no-op or unavailable implementation so the core
desktop binary remains launchable without Python.

## 14. Migration plan

Each phase has a deliverable, code boundary, compatibility behavior, tests, and
an exit gate. Work may proceed only when the previous phase's gate passes.

### Phase 0: freeze and instrumentation

Deliverables:

- record current runtime routes and session formats;
- add startup, memory, event-count, and provider-health metrics;
- add feature flags for Rust default path and Python compatibility path;
- stop introducing new Python transcript/checkpoint formats.

Exit gate:

- a clean launch can identify the active execution plane;
- every turn log includes session, turn, provider and workspace ids;
- diagnostics can export redacted state.

Rollback: disable the Rust-default feature flag; no data migration is destructive.

### Phase 1: protocol and ledger

Deliverables:

- implement the envelope and event registry in `protocol`;
- add SQLite ledger tables/migrations in `state`;
- expose append/read/replay/verify APIs;
- adapt Rust runtime events to the envelope;
- add Python read-only importer for legacy event/message rows.

Exit gate:

- local turn replay reproduces identical provider input;
- sequence gaps, duplicate events and invalid terminal states are rejected;
- desktop can reconnect from `after_seq` without duplicate visible messages.

### Phase 2: local execution and policy

Deliverables:

- make Local Fleet the only tool process boundary;
- route all local file/command/test/build operations through capabilities;
- map Rust policy decisions to approval events;
- block direct desktop and Python tool execution on the default path.

Exit gate:

- local file edit, command, test, cancellation and rollback pass contract tests;
- approval decisions are identical from desktop and TUI;
- no local tool call completes without a ledger record.

### Phase 3: SSH

Deliverables:

- complete SSH adapter and reconnect;
- implement key and interactive password handoff;
- verify host key policy and redaction;
- run fake tests, then one real smoke against the configured 43.* host.

Exit gate:

- connect, read, write, execute, stream, cancel, reconnect and dispose pass;
- password never persists;
- remote and local concurrent turns have independent sequence spaces.

### Phase 4: WSL

Deliverables:

- distro discovery and explicit selection;
- path conversion and process-tree cancellation;
- local real smoke test plus fake contract suite.

Exit gate:

- Windows path mapping round-trips for valid paths;
- escape and invalid distro cases fail closed;
- cancellation leaves no running WSL child.

### Phase 5: Docker adapter

Deliverables:

- fake contract and deterministic argv builder;
- mount/env/cleanup policy;
- real daemon test remains feature-gated until explicitly enabled.

Exit gate:

- fake tests cover all lifecycle failures;
- no real container is started by default CI or local validation.

### Phase 6: unified desktop workbench

Deliverables:

- panel registry and shared event cursor;
- editor/terminal/task/review projections;
- workspace lifecycle surface;
- reconnect, stale-state and permission-required UI.

Exit gate:

- one session can use Chat, Editor, Terminal, Tasks and Review without a second
  session or duplicate turn;
- layout state survives restart without storing transcript data;
- desktop uses Runtime API v1 only.

### Phase 7: extension migration

Deliverables:

- extension manifest/protocol/installer;
- move voice, VTuber, legacy providers and Android integrations behind it;
- make extension failure non-fatal to core workbench.

Exit gate:

- core starts with Python unavailable;
- extension permissions are visible and policy-checked;
- uninstall/failed upgrade is reversible.

### Phase 8: retirement and default switch

Deliverables:

- default all coding turns to Rust;
- keep Python compatibility read-only for one migration window;
- import legacy sessions/checkpoints;
- remove obsolete AgentCore/session paths and old UI routes.

Exit gate:

- migration diagnostics show no default-path Python turn;
- all supported recovery cases replay from Rust ledger;
- cold-start and memory budgets pass on the reference machine;
- deletion list is reviewed and backed by migration checks.

## 15. Testing specification

### 15.1 Unit tests

Required unit suites:

- envelope serialization/defaults/unknown fields;
- sequence allocation under concurrent append;
- event payload validation;
- ledger replay and verification;
- each policy rule and precedence order;
- path containment and Windows/WSL conversion;
- SSH/WSL/Docker command construction and redaction;
- provider health classification;
- cancellation state transitions;
- checkpoint base-sequence semantics;
- extension manifest validation.

### 15.2 Contract tests

Every workspace adapter runs the same matrix:

```text
discover_success
discover_empty
prepare_rejects_invalid_spec
connect_success
connect_timeout
read_file
write_file_requires_policy
execute_streams_stdout_stderr
bounded_output
cancel_before_spawn
cancel_during_process
stop_process_tree
observe_exit
reconnect_same_workspace
dispose_cleans_resources
```

The matrix runs against Local and hermetic fakes for SSH, WSL, and Docker. Real
smoke tests are separate and never replace fake coverage.

### 15.3 Integration tests

Required end-to-end cases:

1. local chat turn with a read tool and a write tool;
2. approval required, approved, denied, and timed out;
3. local and SSH turns streaming concurrently;
4. disconnect/reconnect while model deltas are streaming;
5. cancel a mutating tool and prove no post-ack mutation;
6. pause, restart runtime, resume and compare replayed model history;
7. provider unavailable then healthy without changing session history;
8. desktop reload during a stream and cursor catch-up;
9. Python extension crash while core turn remains usable;
10. migration import of a legacy Python session/checkpoint.

### 15.4 Performance tests

The benchmark harness records process tree, working set, startup phases, first
window paint, runtime ready, first event, and first provider request. It runs on
the reference Windows machine in clean and warm conditions. A result without
machine/build metadata is invalid evidence.

### 15.5 Static and release checks

Before a release candidate:

- `npm run build`;
- `cargo check --workspace`;
- Rust unit/integration tests for protocol, state, execpolicy, fleet and runtime;
- frontend unit tests and typecheck;
- Python compatibility/import tests;
- redaction scan over logs, events and diagnostics;
- dependency/license and extension manifest scan;
- migration dry-run on a copy of representative legacy data.

## 16. Security specification

The runtime is loopback-only by default. Exposing it on a non-loopback
interface requires an explicit configuration and authentication. Remote worker
credentials are references to a secret backend, never event payloads.

Workspace escape, credential reads, network egress, remote process control,
destructive commands, and Docker mounts are independently policy-classified.
The runtime fails closed when a capability declaration, policy result, host key,
or cancellation acknowledgement is missing.

All logs and events pass a redaction layer before persistence. Redaction tests
must include API keys, bearer tokens, SSH passwords, private key material,
environment values, `.env` contents, and command arguments containing secrets.

## 17. Observability and diagnostics

Every request and event carries a correlation id. Diagnostics expose:

- runtime version and protocol versions;
- active execution plane;
- session/turn/workspace counts;
- event sequence and projection lag;
- provider state and latency buckets;
- worker lifecycle counts;
- policy decision counts by rule id;
- startup phase timings;
- memory samples;
- extension status.

Diagnostics must use redacted identifiers and bounded values. A diagnostic export
must be safe to attach to a bug report without manual secret editing.

## 18. Compatibility and deletion rules

During migration, legacy paths are classified as one of:

- `active`: allowed on the default path;
- `compat-read`: may import/read but may not create new state;
- `compat-write`: temporary fallback behind an explicit feature flag;
- `retired`: unreachable and scheduled for deletion.

The Python AgentCore, Python checkpoint manager, long-task JSON state, rollout
transcripts, and old message persistence must move from `active` to
`compat-read` before retirement. A deletion requires:

1. import/replay tests;
2. feature-flag rollback evidence;
3. no default-path call sites from `rg`/static analysis;
4. a release note and migration diagnostic;
5. a backup/export path for user data.

## 19. Decision log

The following decisions are fixed for this refactor:

| ID | Decision | Reason |
|---|---|---|
| D-001 | Rust owns the default execution plane | startup, lifecycle and memory control |
| D-002 | Ledger is append-only source of truth | replay and cross-client convergence |
| D-003 | UI projections are rebuildable | prevents desktop state becoming authority |
| D-004 | SSH before WSL before Docker | user priority and remote utility |
| D-005 | Docker real smoke is gated | user explicitly deferred Docker testing |
| D-006 | OpenAI-compatible wire first | covers configured local endpoint and providers |
| D-007 | Python is extension/compatibility plane | preserve voice/VTuber/legacy features without default cost |
| D-008 | Policy returns allow/ask/deny | one approval vocabulary across clients |
| D-009 | Checkpoints index ledger state | eliminates transcript forks |
| D-010 | Extensions cannot mutate runtime DB | preserve state authority and rollback |

Any change to these decisions requires a new spec version and a migration note.

## 20. Open implementation questions

These are implementation choices, not permission requests. They must be settled
in code review before the corresponding phase begins:

- SSE versus WebSocket as the primary desktop event transport;
- exact SQLite WAL/checkpoint retention policy;
- secure Windows credential backend for interactive SSH password handoff;
- whether editor buffers are persisted as events or as bounded content refs;
- exact subagent concurrency and budget limits;
- whether jump-host support lands in the first SSH gate or a follow-up;
- reference Windows machine and benchmark automation location.

An unresolved question may not silently change a public contract. It must be
represented as a feature flag or an explicit `unsupported` capability.

## 21. Definition of done

The refactor is complete only when all of the following are true:

- the default desktop coding path does not instantiate Python AgentCore;
- local, SSH, WSL, and fake Docker use one workspace contract;
- all model-visible state is reconstructible from the Rust ledger;
- Desktop, TUI, and Web consume the same event envelope and sequence rules;
- policy decisions are centralized and auditable;
- provider health is redacted and stateful;
- pause/resume/cancel have tested lifecycle semantics;
- extensions are versioned, permissioned, and optional;
- legacy state has an import/rollback story;
- the workbench exposes Chat, Editor, Terminal, Tasks and Review as peers;
- startup, memory, concurrency and cancellation budgets have measured evidence;
- the deletion list has no default-path references;
- all phase exit gates in this document are green.

Until this definition is met, the project should describe itself as “Rust
runtime migration in progress”, not as a completed unified architecture.

