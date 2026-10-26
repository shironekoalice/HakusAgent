# avatar.vtuber rollback receipt

This bundle is a staged review candidate, not an active installation.

- Previous-version slot: `previous/` in the Runtime installer snapshot.
- Upgrade rule: validate manifest, source digest, permissions, license notes,
  and protocol fixtures before replacement.
- Failure rule: restore the previous snapshot and keep the core workbench
  usable; retain all user model files outside the bundle.
- Fixture: `python scripts/extension_bundle_fixtures.py --bundle avatar.vtuber`
  exercises failed-upgrade restoration in a temporary directory.

The receipt does not grant trust. The external Auto-live2D/live-server smoke is
recorded separately in `docs/REFACTOR_STATUS.md`.
