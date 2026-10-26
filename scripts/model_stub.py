"""Deterministic OpenAI-compatible model stub used by the golden-replay gate.

It answers /v1/chat/completions with a fixed, content-addressed reply and
records every inbound request body so a test can prove the runtime sent
byte-identical model input across a restart.

Usage:
    python scripts/model_stub.py --port 48999 --out .dsh-smoke/model-calls.jsonl
"""

import argparse
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_lock = threading.Lock()
_seq = 0


def canonical_json(value) -> str:
    """Stable serialization so two logically equal payloads hash identically."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    out_path = None

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _record(self, record: dict) -> None:
        global _seq
        with _lock:
            _seq += 1
            record["call_index"] = _seq
            with open(self.out_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {"_unparsed": raw.decode("utf-8", "replace")}

        digest = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
        self._record({
            "path": self.path,
            "sha256": digest,
            "body": body,
        })

        if not self.path.rstrip("/").endswith("/chat/completions"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        stream = bool(body.get("stream"))
        model = body.get("model") or "stub-model"
        text = "GOLDEN_REPLAY_OK"

        if stream:
            chunks = [
                {"id": "chatcmpl-stub", "object": "chat.completion.chunk", "created": 0,
                 "model": model, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
                {"id": "chatcmpl-stub", "object": "chat.completion.chunk", "created": 0,
                 "model": model, "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]},
                {"id": "chatcmpl-stub", "object": "chat.completion.chunk", "created": 0,
                 "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}},
            ]
            payload = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
            encoded = payload.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        else:
            encoded = json.dumps({
                "id": "chatcmpl-stub",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            encoded = json.dumps({
                "object": "list",
                "data": [{"id": "golden-stub", "object": "model", "owned_by": "stub"}],
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=48999)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    Handler.out_path = args.out
    open(args.out, "w", encoding="utf-8").close()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"model stub listening on http://{args.host}:{args.port} -> {args.out}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
