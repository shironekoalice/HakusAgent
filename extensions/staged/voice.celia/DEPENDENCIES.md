# voice.celia review inventory

## Source

- `D:\项目\Celia\celia_live`: copied Python source snapshot.
- ASR implementation: FunASR with `SenseVoiceSmall` defaults.
- VAD implementation: Silero, with the source energy fallback.
- The source directory did not contain a license file. The owner has confirmed
  that this `celia_live` source is self-developed and owned by the user; record
  it as proprietary, owner-confirmed source. This confirms source ownership,
  but does not grant a public redistribution license.

## Runtime dependencies

The copied source imports or expects `numpy`, `torch`, `funasr`, `pyaudio`,
`fastapi`, `starlette`, `soundfile`, `websockets`, `pyyaml`, and the selected
Silero model. None of these packages or model weights are bundled here.

The staged `config.py` and `unified_config.py` are code-only configuration
schemas/loaders retained for source completeness: their credential and cookie
defaults are empty, and their model/audio/state paths are relative placeholders.
The actual `config.yaml`/`config.json`, environment values, and user state are
excluded. The adapter constructs the minimal `Config` object in memory and
loads only the external model directory selected through the reviewed
`HAKUS_CELIA_ASR_MODEL`, `HAKUS_CELIA_MODEL_DIR`, or `HAKUS_CELIA_ROOT`
environment settings.

FunASR source code is MIT-licensed, while FunASR model weights are governed
separately by the FunASR Model Open Source License Agreement v1.1. The exact
review reference is now fixed to ModelScope `iic/SenseVoiceSmall`; the selected
Android sherpa reference is release family
`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` with the upper-directory
configuration's `model.int8.onnx` and `tokens.txt`. The staged bundle contains
neither source weights nor model metadata. Artifact hashes and the exact model
card terms remain required before any weight redistribution. The upstream
int8 archive currently has the GitHub API digest
`sha256:7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`;
this digest was recorded without downloading the archive.

ModelScope metadata currently reports Apache-2.0 for `iic/SenseVoiceSmall`,
while FunASR publishes a separate model-weight agreement v1.1. This license
discrepancy remains open and is not treated as redistribution approval.
The user decision is conservative: keep the weights external and do not
redistribute them with this bundle.

## Exclusions

Models, audio, user data, virtual environments, caches, logs, configuration
files containing credentials, and platform device state were excluded. The
adapter does not read copied credential/configuration data during its protocol
smoke.

## License decision

`source_ownership: owner-confirmed` and `license_review:
owner-confirmed-proprietary` apply only to the copied `celia_live` source.
Third-party packages, FunASR/SenseVoice and Silero model weights, and their
model cards or license terms remain separate review items. The Windows Runtime
trust and enablement receipt is recorded separately and is bound to the exact
bundle content hash; it does not approve redistribution of external weights.
