"""Minimal reviewed bridge for the staged legacy.provider candidate.

The Rust Runtime owns provider execution. This candidate only exposes the
versioned extension protocol and reports the compatibility boundary; it does
not read provider configuration or make network requests.
"""

from __future__ import annotations

import json
import os
import sys


PROTOCOL = "hakus.extension.v1"
EXTENSION_ID = "legacy.provider"


def response(request: dict, *, ok: bool, event_type: str, payload: dict) -> None:
    output = {
        "protocol": PROTOCOL,
        "request_id": request.get("request_id", ""),
        "extension_id": EXTENSION_ID,
        "event_type": event_type,
        "ok": ok,
        "payload": payload,
    }
    sys.stdout.write(json.dumps(output, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            return 2
        if not isinstance(request, dict):
            return 2
        if (
            request.get("protocol") != PROTOCOL
            or request.get("extension_id") != EXTENSION_ID
            or not isinstance(request.get("request_id"), str)
        ):
            return 3

        event_type = request.get("event_type")
        if event_type == "extension.ping":
            response(
                request,
                ok=True,
                event_type=event_type,
                payload={
                    "state": "candidate",
                    "source": "hakus.models.legacy_provider_adapter",
                    "canonical_plane": "rust_runtime",
                    "fallback_policy": "disabled",
                    "runtime_ready": False,
                },
            )
        elif event_type in {"provider.health", "provider.bind", "provider.request"}:
            response(
                request,
                ok=False,
                event_type=event_type,
                payload={
                    "state": "unavailable",
                    "reason": "Rust Runtime provider binding is required",
                },
            )
        elif event_type == "extension.stop":
            response(request, ok=True, event_type=event_type, payload={"state": "stopped"})
            return 0
        elif event_type == "extension.crash":
            os._exit(17)
        else:
            response(
                request,
                ok=False,
                event_type=str(event_type or "unknown"),
                payload={"state": "rejected", "reason": "unsupported event"},
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
