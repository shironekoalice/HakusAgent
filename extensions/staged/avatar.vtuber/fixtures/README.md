# avatar.vtuber fixtures

The fixture runner uses the Runtime extension protocol and keeps the copied
source isolated from user model assets.

- `success.json`: protocol ping and expected candidate response.
- `malformed.json`: malformed input must terminate without a response.
- `crash.json`: explicit crash event must terminate the child process.
- `stop.json`: stop event must return a terminal response and exit cleanly.
- `uninstall.json`: temporary snapshot removal must preserve the source tree.
- `failed-upgrade.json`: invalid upgrade must restore the previous snapshot.
