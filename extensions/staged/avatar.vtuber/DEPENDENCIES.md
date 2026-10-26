# avatar.vtuber review inventory

## Source

- `D:\项目\live2dControl\Auto-live2D-beta`: WebView/PSD renderer and
  tracking host, copied without model PSD assets.
- `D:\项目\live2dControl\live-server`: WebSocket, LLM, emotion, and TTS
  service source, copied without its config, data, audio, or logs.
- Auto-live2D-beta includes an MIT `LICENSE` and documents ag-psd as MIT and
  MediaPipe as Apache-2.0 when loaded from its CDN.
- The copied `lib/ag-psd.min.js` is a bundled distribution artifact and carries
  embedded Apache-2.0, MIT, and BSD-3-Clause notices for transitive code. A
  complete generated NOTICE file is still required before redistribution.
- No license file was found for the selected `live-server` source. The owner
  has confirmed that this `live-server` source is self-developed and owned by
  the user; record it as proprietary, owner-confirmed source. This confirms
  source ownership, but does not grant a public redistribution license.

## Runtime dependencies

The renderer expects Python `pywebview` and the browser-side `ag-psd` bundle.
The live server expects `fastapi`, `uvicorn`, `aiohttp`, `pyyaml`, and optional
TTS/provider SDKs. No dependency wheels, model assets, audio, or CDN cache are
bundled here.

`config_loader.py` is retained as source code but its `config.yaml` input is
excluded. When explicitly enabled, the staged adapter loads an external
operator-created config and starts the live-server through the reviewed
`HAKUS_AVATAR_LIVE_SERVER_*` settings. The `LIVE_TEST.md` instructions refer
to the same external config and do not contain a credential.

## Exclusions

PSD/model assets, audio files, `config.yaml`, `data/`, logs, voice ids, virtual
environments, caches, and launch batch files were excluded. This prevents user
assets and provider credentials from entering the staged snapshot.

## License decision

`license_review: partial-owner-confirmed`. The selected `live-server` source
is `source_ownership: owner-confirmed` and proprietary. Auto-live2D-beta and
the bundled `ag-psd` artifact retain their independent MIT/Apache-2.0/
BSD-3-Clause obligations, including the generated NOTICE requirement. PSD,
Live2D, VRM, sample art, CDN, and other runtime assets remain separate review
items. The Windows Runtime trust and enablement receipt is recorded separately
and is bound to the exact bundle content hash; it does not approve public
redistribution of external assets.
