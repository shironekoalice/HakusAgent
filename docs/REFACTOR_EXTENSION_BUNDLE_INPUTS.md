# Phase 7 Extension Bundle Inputs

This is the review packet for the remaining Phase 7 feature migrations. It
lists the material required before a feature can be marked migrated. It does
not create, activate, or approve a bundle.

## Shared review packet

Every feature bundle must provide:

1. A staged bundle tree and `plugin.json` (or legacy `plugin.toml`) with a
   matching plugin and extension id/version, `protocol = "hakus.extension.v1"`,
   entrypoint, capabilities, permissions, supported platforms, and a
   `sha256:<64 hex>` checksum. Dot-qualified extension ids such as
   `voice.celia` and `avatar.vtuber` use the standard `plugin.json` form.
2. A dependency and license inventory, including the redistribution terms for
   model, audio, Live2D, or VRM assets.
3. A success, malformed-response, crash, stop, uninstall, and failed-upgrade
   fixture. The fixtures must prove that the Runtime owns the child process and
   that all ledger payloads are redacted.
4. A permission review naming each requested capability and the human trust
   decision. Trust is granted through the command layer; the desktop API does
   not grant trust.
5. A rollback receipt showing that a failed activation or upgrade restores the
   previous reviewed version and leaves the core workbench usable.

Owner confirmation may satisfy the source-ownership portion for a self-
developed proprietary snapshot when it is recorded in the bundle inventory.
It does not satisfy third-party package, model-weight, CDN, PSD, Live2D, VRM,
sample-art, or other asset license review, and it is not a public
redistribution grant.

## Feature inputs

| Feature | Required reviewed input | Current state | Blocking evidence |
|---|---|---|---|
| `voice.celia` | Windows extension entrypoint, microphone/audio permissions, protocol fixtures, and a real response/crash smoke | Bridge implemented; candidate staged | Trust/enablement remains explicit; model weights and Android/device work remain external; `celia_live` source ownership is confirmed |
| `avatar.vtuber` | VTuber/Live2D/VRM host adapter, asset licenses and hashes, streaming protocol fixtures, and a real response/crash smoke | Bridge implemented; candidate staged | Trust/enablement remains explicit; PSD/Live2D/CDN assets remain external; `live-server` source ownership is confirmed |
| Legacy provider | Provider adapter bundle, strict provider binding, health/error fixtures, and credential-redaction review | Candidate staged | No external runtime dependency is bundled; repository distribution policy, trust, and reviewed activation remain open |
| Android voice integration | Android-targeted `voice.celia` entrypoint or an explicitly reviewed platform adapter, plus Android install/rollback smoke | Boundary only; model reference and upstream archive digest fixed; weights external by decision | Android bundle/runtime and device smoke remain open; weights are intentionally not redistributed; see `docs/ANDROID_ASR_REVIEW.md` |

The Android row does not invent a new extension id. It is satisfied by an
explicitly reviewed Android implementation of `voice.celia` or by a separately
named manifest supplied by the feature owner.

## Acceptance order

1. Review the bundle packet and trust decision.
2. Install into a staged snapshot and verify the manifest/checksum.
3. Run the Runtime-owned lifecycle and redaction fixtures.
4. Exercise the feature through its real desktop or Android surface while the
   core workbench remains usable if the extension is absent or crashes.
5. Record the migration result in `REFACTOR_STATUS.md`.

Until the remaining inputs arrive, the compatibility facades remain explicit
`unavailable` implementations. Candidate source snapshots are review-only and
are not discovered, trusted, or activated by the default Runtime. No legacy
component or user data is deleted as part of this packet.

The no-bundle boundary can be checked with
`node scripts/phase7-extension-fallback-audit.mjs`. A passing result verifies
fallback wiring only; it is not evidence that any feature bundle has been
reviewed, installed, trusted, or migrated.

