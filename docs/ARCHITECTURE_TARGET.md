# HakusAgent Target Architecture

> This file is the short architectural direction. The implementation contract,
> schemas, state machines, migration gates, tests, and deletion rules live in
> [REFACTOR_SPEC.md](REFACTOR_SPEC.md). A change is not considered specified by
> this summary alone.

This document records the agreed first product direction and the migration
boundary for the unified coding workbench. It is intentionally independent of
the current in-progress desktop UI changes.

## Product direction

HakusAgent is a Windows-first coding workbench with a configurable workspace
surface. The primary user is an individual developer working locally. Remote
workspaces are first-class and are delivered in this order: SSH, WSL, Docker.
Voice, Live2D/VRM, streaming, and Android remain optional extensions and must
not be required to start or use the coding workbench.

The first usable vertical slice must cover:

- local, SSH, WSL, and Docker workspace selection;
- file search, read, edit, and batch changes;
- command, test, build, and log execution;
- Git diff, review, rollback, and commit preparation;
- plan, long-running execution, pause/resume, cancellation, and subagents;
- MCP, Skills, plugins, provider health checks, and model selection.

The primary desktop experience is an extensible workbench surface. Chat,
editor, terminal, task progress, and review are peer panels rather than a chat
page with secondary dialogs.

## Runtime decisions

### Canonical execution plane

Rust is the canonical local execution plane. It owns process lifecycle,
workspace transports, filesystem and command execution, sandbox integration,
session durability, event ordering, and the runtime HTTP/SSE or WebSocket
boundary already present in `frontend/terminal`.

TypeScript owns the desktop/web presentation, panel composition, provider and
plugin management UX, and workflow authoring. It consumes the Rust runtime
protocol and must not independently execute workspace tools.

Python is an optional extension plane. It may provide voice, VTuber, legacy
model adapters, or domain-specific plugins, but it is not on the default coding
turn path. A Python extension communicates through a versioned protocol and may
not mutate the session store directly.

### Event and session model

The runtime event ledger is the sole source of truth for model-visible state.
At minimum it contains user input, model request, assistant stream settlement,
tool call, approval, tool result, error, cancellation, checkpoint, subagent
lifecycle, and turn completion events.

UI projections, transcripts, task boards, metrics, and recovery views are
derived from that ledger. A checkpoint is a bounded recovery snapshot or an
index into durable events; it is not a second authoritative conversation
history.

Every event has a schema version, session id, workspace id, monotonic sequence,
wall-clock timestamp, and correlation id. New model-visible data must be
represented as an event before it is sent to a provider.

### Capability and permission model

Tools, providers, workspace transports, sandboxes, MCP servers, Skills, and
subagents are capabilities. Each capability declares its side-effect scope,
risk level, required approval mode, and supported workspace types.

The permission decision is centralized and returns `allow`, `ask`, or `deny`
with a stable rule id and a human-readable reason. Desktop, TUI, remote
workers, and Python extensions all call this policy boundary. No adapter may
silently bypass it.

The default user-facing mode is selected by policy, but the runtime must
support restricted, developer, and fully automated profiles. Destructive
operations, workspace escape, credential access, network egress, and remote
process control remain independently classifiable.

## Workspace transport contract

All workspace types implement the same contract:

```text
discover -> prepare -> connect -> execute/read/write -> observe -> stop -> dispose
```

The first adapters are:

1. SSH: host key policy, password or key authentication, jump host and port
   forwarding hooks, remote process execution, file transfer, and reconnect.
2. WSL: distro discovery, launch/attach, Windows path translation, and process
   cancellation. The Rust Fleet HostSpec now has a WSL adapter that launches
   workers through `wsl.exe`, preserves the approval boundary, and maps
   `C:\\...` paths to `/mnt/...`.
3. Docker: the first adapter creates an ephemeral worker with `docker run`,
   allowlisted environment injection, logs, and explicit stop/rm cleanup.
   Existing-container attach, bind-mount presets, rebuild, and Compose project
   support remain the next Docker increment.

The transport owns the remote process boundary. The Agent runtime only sees a
workspace capability and does not contain SSH/WSL/Docker-specific branches.

## Model and provider contract

OpenAI-compatible chat is the default wire contract. Provider metadata contains
base URL, model id, authentication source, streaming support, tool-call format,
vision support, context limit, and health-check endpoint.

The configured GPT candidate is `aisz / gpt-5.6-luna`. Provider startup must
resolve `${ENV:default}` placeholders, accept both provider-local and legacy
top-level credentials, classify unresolved credentials as unconfigured, and
expose a redacted health result. No key is logged or stored in session events.
The provider layer must also support DeepSeek, OpenAI-compatible
Qwen/GLM/MiMo/OpenCode/StepFun/SenseNova, and local Ollama/vLLM endpoints.

## Extension lifecycle

Plugins and Skills are installable from local directories, Git repositories, or
approved package sources. Installation is staged, inspected, and recorded with
source, version, checksum, declared capabilities, and permissions. Activation
is scoped to user or project. Removal and failed upgrades must be reversible.

MCP servers are treated as external capabilities with their own approval and
network policy. A plugin may contribute tools, provider metadata, UI panels, or
Python services, but it cannot silently replace the runtime event ledger.

## Migration sequence

1. **Runtime boundary:** stabilize the existing Rust Runtime API and event
   envelopes; add contract tests for local workspaces and provider health.
2. **Workspace adapters:** finish SSH, WSL, then Docker behind one transport
   interface. Validate each adapter with a hermetic fake and one real smoke
   environment.
3. **Session convergence:** route TUI, desktop, and Web through one event ledger;
   freeze new Python session/checkpoint formats.
4. **Desktop workbench:** replace the current page-oriented layout with a panel
   workbench while preserving the runtime protocol.
5. **Extension plane:** move voice, VTuber, legacy Python providers, and Android
   integration behind versioned optional protocols.
6. **Retirement:** remove the old Python AgentCore, duplicate session stores,
   and legacy Vue paths after the vertical slice and migration diagnostics pass.

## Acceptance targets

- Windows desktop cold start: at most 5 seconds on the reference machine.
- Idle desktop memory: at most 450 MB, excluding an explicitly running model
  server or remote container.
- One local task and one remote task can stream concurrently without event
  sequence collisions.
- A cancelled tool cannot continue mutating the workspace after cancellation
  acknowledgement.
- Pause/resume reconstructs the same model-visible history from the ledger.
- Provider health checks never expose credentials and distinguish unavailable,
  unauthorized, rate-limited, and healthy states.
- SSH, WSL, and Docker adapters pass contract tests before real-environment
  smoke tests are enabled.

