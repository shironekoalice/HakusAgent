# Phase 8 Deletion Review

Status: **draft, awaiting explicit user review**

This list is a review artifact. It does not authorize or perform deletion.
Legacy components and user data remain in place until every condition below is
met and the user approves the exact batch.

## Batch A: Python compatibility state plane

Delete together only after Phase 7 feature migration and a shipped migration
release:

| Component | Path | Coupling that must be removed first |
|---|---|---|
| AgentCore | `hakus/agent.py` | `agent_bridge.py`, `orchestrator.py`, `sub_agents.py`, `long_running_agent.py`, `p1_integration.py`, `voice_bridge.py`, package exports |
| Checkpoint manager | `hakus/checkpoint.py` | `agent.py`, `long_running_agent.py`, `p3_api.py`, package exports |
| Long-task state | `hakus/long_task_context.py` | `orchestrator.py` |
| Rollout transcripts | `hakus/rollout.py` | `long_running_agent.py`, `p1_integration.py`, validation scripts |
| Session log recorder | `hakus/session_log.py` | sidecar server and `agent_bridge.py` |
| Message persistence | `src/hakusai_server/session_store.py` | sidecar server, `agent_bridge.py`, automations |

The six state writers and their compatibility-plane importers are one batch.
Splitting the batch would leave dangling imports and an ambiguous compatibility
authority.

## Batch B: optional feature survivors

Move each feature to a reviewed `hakus.extension.v1` bundle before removing
its compatibility implementation:

- `voice_bridge.py` and `voice_cmds.rs` for `voice.celia`;
- VTuber/Live2D/VRM WebSocket and rendering surfaces for `avatar.vtuber`;
- legacy provider adapters inside AgentCore after the Rust provider route is
  the only supported execution path.

Android voice integration follows the reviewed `voice.celia` bundle or a
separately named, reviewed Android adapter. No new bundle is inferred here.

## Required evidence before deletion

1. Phase 7 bundle review, trust receipt, permissions, dependency/license review,
   and successful/failed lifecycle fixtures.
2. Rust import/replay and backup/export checks remain green.
3. `scripts/phase8-call-site-audit.mjs` reports zero default-path references
   immediately before deletion.
4. The migration diagnostic and a user-facing release note ship together.
5. The compatibility feature flag is disabled by default for one migration
   window with rollback evidence.
6. The user explicitly approves the exact files and data scope.

The deletion operation must preserve user exports and must not remove legacy
data automatically. If any feature bundle or evidence item is missing, retain
the relevant compatibility component and report it as `yellow` or `red`.

