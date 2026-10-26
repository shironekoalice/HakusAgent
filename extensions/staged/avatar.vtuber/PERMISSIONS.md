# avatar.vtuber permission review

Status: **owner-confirmed; trusted and enabled for the Windows Runtime**

| Capability | Requested permission | Decision |
|---|---|---|
| Avatar rendering | `avatar.render` | approved for the owner-controlled Windows runtime |
| Streaming | `avatar.stream` | approved for the owner-controlled local runtime |
| Camera input | `camera` | approved for the runtime boundary; capture remains opt-in |
| Microphone input | `microphone` | approved for the runtime boundary; capture remains opt-in |
| Local service transport | `network:local` | approved only for the configured local live-server endpoint |

The user confirmed ownership of the `Auto-live2D-beta` and `live-server`
source snapshots. The bundle contains reviewed runtime code only; PSD/model
assets, configuration, credentials, and user data stay external through the
documented `HAKUS_AVATAR_*` settings.

The current receipt was created through the Runtime trust/enable flow. The
Runtime owns child processes and redacts payloads before ledger storage. This
approval covers the Windows desktop bridge and its local live-server; it does
not claim Android support.
