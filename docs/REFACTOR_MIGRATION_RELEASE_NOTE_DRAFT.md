# HakusAgent Runtime Migration

> Draft for the release that starts the Rust Runtime migration window. This
> note is not a release announcement until the corresponding build is shipped.

## What Changes

New coding turns run through the embedded Rust Runtime. It owns the session
ledger, event ordering, workspace operations, approvals, checkpoints, and
recovery. The desktop remains a client and rebuildable projection of that
state.

The Python compatibility path remains available for one migration window. It
is read-only for transcript and checkpoint writes on the default desktop
path. It can still expose legacy data and optional integrations while they are
being moved to the extension contract.

## Before Updating

1. Export a user-data backup from the Runtime session export action.
2. Keep the exported file outside the application data directory.
3. Open Runtime diagnostics and save the redacted migration section with the
   backup. It contains counts and migration status, never credentials.

The export is a portability backup for user message history. The Rust ledger
remains the complete source for tool, reasoning, approval, and recovery events.

## Migration Window

On first startup, HakusAgent discovers legacy session stores without mutating
them. A user can review the discovered sessions and explicitly import selected
data into the Rust ledger. Imports are checksum-bound and retry-safe.

During the window:

- new desktop coding turns use the Rust Runtime;
- legacy Python transcript and checkpoint writers are frozen on the default
  path;
- reconnect and recovery resume from the Rust ledger sequence;
- the compatibility path can be disabled and re-enabled with the documented
  feature flags if rollback evidence is required;
- no legacy files are deleted automatically.

## Optional Features

Voice/Celia, VTuber/Live2D/VRM, legacy provider, and Android integrations are
optional extensions. Candidate bundles may be present for review while their
runtime remains unavailable until trust, dependency/license, and device/host
evidence is complete. The core workbench remains launchable when reviewed
bundles are absent. An unavailable extension is reported in Settings and does
not block local workspace, chat, review, or recovery flows.

Do not copy credentials into extension configuration or migration files.
Extension permissions and trust state are shown by the Runtime extension
inventory and are checked before activation.

## Rollback

If a migration needs to be paused, keep the backup and redacted diagnostics,
restore the previous application build, and leave the compatibility feature
flag enabled for the migration window. Re-importing the same source is
idempotent; it does not duplicate ledger events.

The migration does not delete the legacy source. Deletion requires a later
release note, a reviewed deletion list, successful import/replay checks, a
backup, and explicit confirmation of the feature migration.

## Current Limitations

The current packaged Windows build meets the desktop cold-start and idle-memory
budgets (10 clean launches, 540 ms median / 863 ms p95 usable window, 421.5 MB
median / 430.6 MB p95 process-tree working set). The memory result depends on
the WebView2 production settings recorded in the status ledger. Reviewed voice,
VTuber/Live2D/VRM, legacy-provider, and Android activation evidence is still
incomplete. Until those feature migrations and the deletion-list review are
complete, this document remains a draft and no legacy component is removed as
part of the migration.

The latest qualifying packaged run is recorded in
`REFACTOR_STATUS.md` (one-hundred-first pass). The `normal` memory-target
rollback smoke and invalid-target fallback are recorded there as well. The
remaining bundle inputs and review evidence are listed in
`REFACTOR_EXTENSION_BUNDLE_INPUTS.md`.

The no-bundle compatibility boundary is checked by
`scripts/phase7-extension-fallback-audit.mjs`; this audit confirms unavailable
behavior and redaction wiring but does not represent a feature migration.
