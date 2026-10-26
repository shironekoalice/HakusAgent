"""Recording reverse proxy for the live model endpoint.

Sits between the Hakus Runtime and the real OpenAI-compatible endpoint, forwards
every request and response byte-for-byte, and records each request body so a test
can prove the model input is byte-identical across a Runtime restart.

The upstream response is relayed verbatim (including SSE), so the model behavior
under test is the real one — only the destination port changes.

Usage:
    python scripts/recording_proxy.py --listen 48998 \
        --upstream http://127.0.0.1:7863 --out CAPTURE.jsonl
"""

import argparse
import hashlib
import json
import sys
import threading
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_lock = threading.Lock()
_seq = 0

# Hop-by-hop headers must not be forwarded.
SKIP_REQUEST_HEADERS = {
    "host", "content-length", "connection", "keep-alive", "transfer-encoding",
    "upgrade", "proxy-connection", "te", "trailer",
}
SKIP_RESPONSE_HEADERS = {
    "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade",
}


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    upstream = ""
    out_path = None

    def log_message(self, fmt, *args):
        pass

    def _record(self, record: dict) -> None:
        global _seq
        with _lock:
            _seq += 1
            record["call_index"] = _seq
            with open(self.out_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _forward(self, method: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if method == "POST" and self.path.rstrip("/").endswith("/chat/completions"):
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {"_unparsed": raw.decode("utf-8", "replace")}
            self._record({
                "path": self.path,
                "sha256": hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest(),
                "body": body,
            })

        target = self.upstream.rstrip("/") + self.path
        headers = {
            key: value for key, value in self.headers.items()
            if key.lower() not in SKIP_REQUEST_HEADERS
        }
        request = urllib.request.Request(
            target, data=raw if raw else None, headers=headers, method=method
        )

        try:
            response = urllib.request.urlopen(request, timeout=300)
            status = response.status
            response_headers = response.headers
            stream = response
        except urllib.error.HTTPError as error:
            status = error.code
            response_headers = error.headers
            stream = error
        except Exception as error:  # upstream unreachable
            payload = json.dumps({"error": {"message": str(error)}}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(status)
        for key, value in response_headers.items():
            if key.lower() not in SKIP_RESPONSE_HEADERS:
                self.send_header(key, value)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        # Relay verbatim, chunked, flushing as bytes arrive so SSE stays live.
        try:
            while True:
                chunk = stream.read(1)
                if not chunk:
                    break
                buffer = bytearray(chunk)
                # Coalesce whatever is already buffered to keep frames whole.
                while len(buffer) < 8192:
                    more = stream.read1(8192 - len(buffer)) if hasattr(stream, "read1") else stream.read(8192 - len(buffer))
                    if not more:
                        break
                    buffer.extend(more)
                self.wfile.write(b"%X\r\n" % len(buffer))
                self.wfile.write(bytes(buffer))
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    def do_POST(self):
        self._forward("POST")

    def do_GET(self):
        self._forward("GET")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", type=int, default=48998)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    Handler.upstream = args.upstream
    Handler.out_path = args.out
    open(args.out, "w", encoding="utf-8").close()

    server = ThreadingHTTPServer((args.host, args.listen), Handler)
    server.daemon_threads = True
    print(
        f"recording proxy {args.host}:{args.listen} -> {args.upstream} (capture {args.out})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
