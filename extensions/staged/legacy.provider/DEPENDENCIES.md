# Dependency and license inventory

- Runtime bridge: Python standard library only (`json`, `os`, `sys`).
- Source boundary: `hakus.models.legacy_provider_adapter` in this repository.
- No provider SDK, model, credential, cache, or user data is bundled.
- The Rust Runtime remains the only network execution authority for this
  candidate.
- Third-party runtime dependency review: **clear for this adapter**; it uses
  only the Python standard library and contains no provider SDK, model, or
  asset.
- Repository-level redistribution policy and human trust decision: **open**;
  this inventory does not infer ownership or a public license for the host
  repository.
