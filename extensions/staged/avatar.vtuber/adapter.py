"""Runtime bridge for Auto-live2D-beta and the optional live-server.

The browser UI is served from the reviewed snapshot. PSD/model assets and a
live-server config remain external inputs selected by reviewed HAKUS_* env
variables, so the bundle does not absorb user assets or credentials.
"""

from __future__ import annotations

import http.server
import importlib
import json
import os
import socketserver
import sys
import threading
import types
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


PROTOCOL = "hakus.extension.v1"
EXTENSION_ID = "avatar.vtuber"
PROTOCOL_STREAM = sys.stdout


class _SilentStdout:
    def write(self, _value: str) -> int:
        return 0

    def flush(self) -> None:
        return


# The live-server may log to stdout; reserve the channel for protocol JSON.
sys.stdout = _SilentStdout()


class OverlayHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, directory: str, asset_dir: Path | None, **kwargs: Any) -> None:
        self.asset_dir = asset_dir
        super().__init__(*args, directory=directory, **kwargs)

    def translate_path(self, path: str) -> str:
        relative = unquote(urlparse(path).path).lstrip("/")
        if self.asset_dir is not None:
            root = self.asset_dir.resolve()
            candidate = (root / relative).resolve()
            if candidate.is_file() and candidate.is_relative_to(root):
                return str(candidate)
        return super().translate_path(path)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class AvatarRuntime:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.httpd: socketserver.ThreadingTCPServer | None = None
        self.backend_thread: threading.Thread | None = None
        self.state = "stopped"
        self.error: str | None = None
        self.url: str | None = None
        self.backend_url: str | None = None

    @property
    def source_root(self) -> Path:
        return Path(__file__).resolve().parent / "source" / "Auto-live2D-beta"

    def asset_dir(self) -> Path | None:
        value = os.environ.get("HAKUS_AVATAR_ASSET_DIR", "").strip()
        if not value:
            return None
        candidate = Path(value).expanduser()
        return candidate if candidate.is_dir() else None

    def health(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "runtime_ready": self.httpd is not None,
            "url": self.url,
            "backend_url": self.backend_url,
            "asset_overlay": self.asset_dir() is not None,
            **({"reason": self.error} if self.error else {}),
        }

    def _start_backend(self) -> None:
        config_name = os.environ.get("HAKUS_AVATAR_LIVE_SERVER_CONFIG", "").strip()
        server_dir_name = os.environ.get("HAKUS_AVATAR_LIVE_SERVER_DIR", "").strip()
        if not config_name or not server_dir_name:
            return
        config_path = Path(config_name).expanduser()
        server_dir = Path(server_dir_name).expanduser()
        if not config_path.is_file() or not server_dir.is_dir():
            self.error = "live-server configuration is unavailable"
            return
        try:
            import yaml
            import uvicorn

            config_loader = types.ModuleType("config_loader")
            config_loader.CFG = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            sys.modules["config_loader"] = config_loader
            sys.path.insert(0, str(server_dir))
            server = importlib.import_module("server")
            port = int(os.environ.get("HAKUS_AVATAR_LIVE_SERVER_PORT", "9091"))
            host = os.environ.get("HAKUS_AVATAR_LIVE_SERVER_HOST", "127.0.0.1")
            self.backend_url = f"http://{host}:{port}"
            config = uvicorn.Config(
                server.app,
                host=host,
                port=port,
                log_level="warning",
                log_config=None,
                access_log=False,
            )
            backend = uvicorn.Server(config)
            # Uvicorn's convenience runner installs process signal handlers;
            # the extension owns a daemon thread instead of the main thread.
            backend.install_signal_handlers = lambda: None
            backend.run()
        except Exception as error:
            detail = str(error).strip()
            self.error = f"live-server failed to start: {type(error).__name__}{(': ' + detail) if detail else ''}"

    def start(self) -> tuple[bool, dict[str, Any]]:
        if self.httpd is not None:
            return True, self.health()
        try:
            host = os.environ.get("HAKUS_AVATAR_HTTP_HOST", "127.0.0.1")
            port = int(os.environ.get("HAKUS_AVATAR_HTTP_PORT", "0"))
            asset_dir = self.asset_dir()
            handler = lambda *args, **kwargs: OverlayHandler(
                *args, directory=str(self.source_root), asset_dir=asset_dir, **kwargs
            )
            self.httpd = socketserver.ThreadingTCPServer((host, port), handler)
            self.httpd.daemon_threads = True
            actual_port = self.httpd.server_address[1]
            self.url = f"http://{host}:{actual_port}/index.html"
            threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
            self.state = "ready"
            if os.environ.get("HAKUS_AVATAR_ENABLE_LIVE_SERVER", "").strip().lower() in {"1", "true", "yes"}:
                self.backend_thread = threading.Thread(target=self._start_backend, daemon=True)
                self.backend_thread.start()
            return True, self.health()
        except Exception as error:
            self.state = "unavailable"
            self.error = f"avatar runtime failed to start: {type(error).__name__}"
            return False, self.health()

    def stop(self) -> None:
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
        self.state = "stopped"
        self.stop_event.set()


runtime = AvatarRuntime()


def response(request: dict[str, Any], *, ok: bool, event_type: str, payload: dict[str, Any]) -> None:
    output = {
        "protocol": PROTOCOL,
        "request_id": request.get("request_id", ""),
        "extension_id": EXTENSION_ID,
        "event_type": event_type,
        "ok": ok,
        "payload": payload,
    }
    PROTOCOL_STREAM.write(json.dumps(output, separators=(",", ":")) + "\n")
    PROTOCOL_STREAM.flush()


def main() -> int:
    keep_alive = False
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
            response(request, ok=True, event_type=event_type, payload={"state": "ready", "source": "live2dControl/Auto-live2D-beta + live-server", "renderer": "WebView/PSD"})
        elif event_type == "avatar.health":
            response(request, ok=True, event_type=event_type, payload=runtime.health())
        elif event_type == "avatar.start":
            ok, result = runtime.start()
            response(request, ok=ok, event_type=event_type, payload=result)
            keep_alive = ok
        elif event_type == "avatar.render":
            if runtime.httpd is None:
                ok, result = runtime.start()
            else:
                ok, result = True, runtime.health()
            response(request, ok=ok, event_type=event_type, payload={"state": result.get("state", "unavailable"), "url": result.get("url")})
        elif event_type == "extension.stop":
            runtime.stop()
            response(request, ok=True, event_type=event_type, payload={"state": "stopped"})
            return 0
        elif event_type == "extension.crash":
            os._exit(17)
        else:
            response(request, ok=False, event_type=str(event_type or "unknown"), payload={"state": "rejected", "reason": "unsupported event"})
    if keep_alive:
        runtime.stop_event.wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
