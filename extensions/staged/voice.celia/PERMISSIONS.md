# voice.celia permission review

Status: **owner-confirmed; trusted and enabled for the Windows Runtime**

| Capability | Requested permission | Decision |
|---|---|---|
| Audio input | `microphone` | approved for the owner-controlled Windows smoke/runtime |
| Audio output | `audio.output` | approved for the owner-controlled Windows runtime; no bundled device data |
| Extension lifecycle | `extension.lifecycle` | Runtime controlled; trusted receipt is bound to the staged content hash |

The user confirmed ownership of the Celia source snapshot. The bundle contains
runtime code only; the FunASR/SenseVoice model, audio, credentials, and user
state stay external. The reviewed host may provide only the documented
`HAKUS_CELIA_*` settings. No credential is embedded in this bundle.

The current receipt was created through the Runtime trust/enable flow. This
approval covers the Windows desktop bridge only. The manifest's Android
platform declaration is not an Android implementation or device-smoke claim.
