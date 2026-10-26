# Android ASR Review Boundary

Status: **Android entrypoint staged; runtime remains unavailable until the
external sherpa-onnx AAR/model and a device smoke are supplied**.

## Selected direction

The selected implementation direction is `sherpa-onnx` with the SenseVoice
model family for offline Android speech-to-text. The repository now contains an
Android-targeted Tauri plugin boundary. It only checks an external model
directory, requests microphone permission, and probes for the optional
sherpa-onnx Java runtime. It fails closed with `unavailable` until the exact
AAR/runtime and model terms are recorded. It does not copy weights, audio, or a
native binary into the APK.

The remaining activation gate is the exact sherpa-onnx Android runtime bridge,
install/rollback evidence, and a real Android device or emulator smoke.

## License evidence found

- The official `sherpa-onnx` source license is Apache-2.0:
  <https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE>.
- The official SenseVoice source repository is MIT, but its README states that
  model weights are governed separately by each model card and the FunASR
  Model Open Source License Agreement v1.1:
  <https://github.com/QwenAudio/SenseVoice>.
- The official FunASR model agreement requires attribution and retaining the
  relevant model names. The exact SenseVoice weight revision and its model
  card must be recorded before redistribution is approved:
  <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>.

## Fixed reference candidate

The user approved an evidence-only reference without copying model files:

- FunASR / ModelScope model card: `iic/SenseVoiceSmall`,
  <https://www.modelscope.cn/models/iic/SenseVoiceSmall>.
- sherpa-onnx release family: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`.
  The selected upper-directory configuration names `model.int8.onnx` and
  `tokens.txt` under that release family and points to the sherpa-onnx ASR
  model release page:
  <https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models>.
- The matching official int8 archive is
  `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`, reported
  by the GitHub release API with archive digest
  `sha256:7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`.
  This is an upstream archive digest, not a hash of a local file.

## License discrepancy requiring review

The current ModelScope API metadata for `iic/SenseVoiceSmall` reports
`Apache License 2.0`, while the FunASR repository publishes the separate
FunASR Model Open Source License Agreement v1.1 for model weights. The
repository also has MIT-licensed source code. These are distinct evidence
records and are not collapsed into one final redistribution conclusion here.
Until the model card and upstream owner clarify which terms govern the exact
weight artifact, the weight remains external and unavailable for staged
redistribution.

## Distribution decision

The user chose the conservative handling: keep the model weights external and
do not redistribute them with this repository or an extension bundle. The
archive identity is retained for reproducibility only; its digest does not
authorize download, bundling, or activation.

This fixes the review reference, not a distributable artifact. No model or
token file is staged, and the exact downloaded artifact hashes plus the
applicable model-card terms must still be reconciled and recorded if weights
are ever redistributed.

These links are evidence for review, not an approval or a license grant. No
model weights are copied into this repository.

## Staged Android entrypoint

The staged bridge lives at
`HakusAgent/frontend/desktop-tauri/src-tauri/plugins/android-asr/`. Its
`status`, `start`, and `stop` commands preserve the `voice.celia` extension
identity for the existing UI. `start` requires `model.int8.onnx` and
`tokens.txt` under an operator-provided directory, then requires the optional
`com.k2fsa.sherpa.onnx.OfflineRecognizer` class. Missing inputs return a
redacted `unavailable` status; `stop` is idempotent.

The Android manifest declares `RECORD_AUDIO`. The model directory defaults to
the app-private `models/sensevoice` directory but is never populated by the
repository. The selected model card and sherpa release remain the fixed
evidence-only references above.

The plugin's Gradle module links the sherpa-onnx Android runtime as a local
`libs/sherpa-onnx-1.13.8.aar` file dependency, so `OfflineRecognizer` is
present in a built APK. That AAR is a 50 MB third-party binary; it is currently
untracked and not covered by `.gitignore`, and no decision has been recorded to
redistribute it in this repository.

## Existing code that is not the implementation

- `HakusAgent/frontend/desktop-tauri/src/lib/androidFeatureAdapter.ts` is a
  redacted Runtime status projection for `voice.celia`; it does not perform
  transcription.
- `tts/sherpa_onnx_tts.py` is a desktop Python TTS wrapper. It must not be
  reused as Android ASR or treated as SenseVoice support.
- The staged `voice.celia` adapter now has a desktop external-runtime bridge;
  it contains no model weights, audio, Android native library, or device
  configuration. The Android bridge is separate and fails closed until its
  native runtime is supplied.

## Required evidence before staging Android runtime code

1. Exact Android sherpa-onnx AAR/JNI version and ABI/runtime dependency inventory.
2. SenseVoice model, VAD weights, and sherpa-onnx redistribution terms.
3. Permission review for microphone capture and local model access.
4. Install, failed-upgrade, uninstall, and rollback fixture.
5. A real Android device or emulator smoke covering capture, transcription,
   stop, and unavailable fallback.

No Android model, native library, or user audio is copied by the current
migration.

## Verification record (2026-10-11)

- `npm run build`: **pass**.
- Desktop Rust target check: **pass** (`cargo check` for `desktop-tauri`).
- Android Rust build reached the new `hakus-android-asr` crate, but the
  repository's existing `rquickjs-sys` Android bindgen step still needs a
  correctly wired NDK sysroot/compiler environment; no APK was produced.
- `adb devices`: **no connected device or emulator**, so microphone,
  transcription, stop, and install/rollback smoke remain unverified.

## Verification record (2026-10-22) — APK build superseded

The 2026-10-11 build blocker above is historical. Commit `f39ec77` (2026-10-19)
added the Chinese-path linker fix and the loopback cleartext exemption, and a
signed release APK now exists at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-signed.apk`
(versionName `0.3.0`, versionCode `3000`, `targetSdk 36`, `minSdk 24`,
`native-code: arm64-v8a`).

Inspecting the archive confirms the boundary is compiled in rather than stubbed:

- the single `classes.dex` contains `HakusAndroidAsrPlugin`,
  `com/k2fsa/sherpa/onnx`, `OfflineRecognizer`, and `hakus-android-asr`;
- the manifest declares `INTERNET` and `RECORD_AUDIO`;
- `lib/arm64-v8a/` carries `libonnxruntime.so`, `libsherpa-onnx-c-api.so`,
  `libsherpa-onnx-cxx-api.so`, and `libsherpa-onnx-jni.so`, all sourced from the
  external `sherpa-onnx-1.13.8.aar` referenced by the plugin's Gradle module.

The APK contains no `.onnx` weights and no `tokens.txt`, consistent with the
decision to keep SenseVoice weights external. Required evidence items 1 and 3
are therefore satisfied by the artifact; items 2, 4, and 5 remain open because
no model pair, install/rollback fixture run, or device smoke is available on
this host.

Host search for a usable model pair (scoped to the real filesystems, not the
Git Bash root): no `model.int8.onnx` exists under `C:\Users\Think` or
`D:\项目` at depth 10, and the generated app-private `models/sensevoice`
directory does not exist. The closest local asset is
`D:\项目\Celia\models\asr\fun_asr`, which is the FunASR PyTorch export
(`model.pt`, `tokens.json`, `config.yaml`) used by the desktop `voice.celia`
bridge. That is a different runtime and format from the sherpa-onnx int8 ONNX
pair this Android adapter requires, so it cannot satisfy the Android start
path. The device smoke is therefore blocked on an external input, not on code.

The `sherpa-onnx-1.13.8.aar` is a 50 MB binary currently untracked and not
ignored by `.gitignore`. Committing it is a distribution decision that has not
been made; it is left uncommitted and unreferenced by any trust receipt.

