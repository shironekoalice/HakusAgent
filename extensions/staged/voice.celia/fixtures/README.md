# voice.celia fixtures

The fixture runner uses the same newline-delimited request shape as the
Runtime extension host. `success` means a protocol ping, not a claim that ASR
models or microphone capture are available.

- `success.json`: protocol ping and expected redacted-safe response.
- `malformed.json`: malformed input must terminate without a response.
- `crash.json`: explicit crash event must terminate the child process.
- `stop.json`: stop event must return a terminal response and exit cleanly.
- `uninstall.json`: temporary snapshot removal must not touch the source tree.
- `failed-upgrade.json`: invalid upgrade must restore the previous snapshot.
