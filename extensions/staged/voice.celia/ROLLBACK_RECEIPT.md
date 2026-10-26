# voice.celia rollback receipt

This bundle is a staged review candidate, not an active installation.

- Previous-version slot: `previous/` in the Runtime installer snapshot.
- Upgrade rule: validate manifest, source digest, permissions, and protocol
  fixtures before replacing the active snapshot.
- Failure rule: retain the previous snapshot and leave the core workbench
  usable; do not delete the source or user data.
- Fixture: `python scripts/extension_bundle_fixtures.py --bundle voice.celia`
  exercises failed-upgrade restoration in a temporary directory.

The receipt is evidence of the rollback procedure only. The external
FunASR/microphone smoke is recorded separately in `docs/REFACTOR_STATUS.md`;
this receipt is not a trust grant.
