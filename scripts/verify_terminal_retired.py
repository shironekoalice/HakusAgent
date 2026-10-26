"""Prove the retired Python `/ws/terminal` route no longer spawns a shell.

The Phase 2 work order called for deleting the Python PTY terminal because the
Rust Runtime already owns `/ws/terminal` with a stricter check. Deleting a
handler is easy to get wrong in a way that reads as fixed but is not: an
overlooked second registration, a subclass re-adding the route, or a stale
`winpty` import would all leave a working shell behind.

This script builds a minimal FastAPI app that registers the *same* handler the
real server registers, connects a real WebSocket client, and asserts:

  1. the connection is refused rather than handed a shell (no raw terminal
     bytes ever arrive);
  2. the refusal is the explicit retirement message, not a generic error;
  3. sending the legacy `{"type":"stdin", ...}` protocol does NOT execute
     anything — the canary file is never created.

The canary is the part that matters. A refusal message could still be sent
*after* spawning a shell; only the absence of the side effect proves no
process ran.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_PY = REPO_ROOT / "src" / "hakusai_server" / "server.py"

# Overridable so the check can be pointed at another revision of the file — the
# control run that proves this check has teeth uses
# `git show HEAD:src/hakusai_server/server.py`.
if len(sys.argv) > 1:
    SERVER_PY = Path(sys.argv[1]).resolve()

CANARY_MARKER = "HAKUS_TERMINAL_RETIRED_CANARY"


def load_retired_handler():
    """Extract the retired handler from the real source without importing it.

    Importing `server.py` pulls in the whole product (agents, providers, MCP),
    which needs credentials and config this check should not require. The
    handler is small and self-contained, so it is exec'd in isolation -- but it
    is exec'd from the *real file text*, so this check fails if someone
    reintroduces a shell spawn in that function.
    """
    import ast

    source = SERVER_PY.read_text(encoding="utf-8")
    tree = ast.parse(source)

    # Find the `@app.websocket("/ws/terminal")` decorated function.
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            func = decorator.func
            if not (isinstance(func, ast.Attribute) and func.attr == "websocket"):
                continue
            args = decorator.args
            if args and isinstance(args[0], ast.Constant) and args[0].value == "/ws/terminal":
                segment = ast.get_source_segment(source, node)
                return node.name, segment, node.lineno
    raise SystemExit("FAIL: no /ws/terminal handler found in server.py")


def build_app(handler_source: str, handler_name: str) -> FastAPI:
    app = FastAPI()

    # The handler body is exec'd in isolation, so the names the *old* version
    # needed have to be available or the comparison is unfair: without them the
    # old handler dies on `os is not defined` and never reaches its spawn call,
    # which would make this check look like it passed for the wrong reason. The
    # retired handler needs none of these.
    import asyncio as _asyncio
    import json as _json
    import os as _os

    namespace: dict = {
        "WebSocket": WebSocket,
        "WebSocketDisconnect": __import__("fastapi").WebSocketDisconnect,
        "app": app,
        "asyncio": _asyncio,
        "json": _json,
        "os": _os,
        "List": list,
        "__file__": str(SERVER_PY),
        # The old handler hardcoded the agent workdir; without it the control
        # run dies before reaching its spawn, which would make the canary
        # assertion vacuous.
        "_WORKDIR": str(REPO_ROOT),
    }
    exec(compile(handler_source, str(SERVER_PY), "exec"), namespace)
    handler = namespace[handler_name]
    app.websocket("/ws/terminal")(handler)
    return app


async def exercise(port: int, canary: Path) -> list[str]:
    import websockets

    failures: list[str] = []
    # The server sends its refusal and closes immediately. If the client lets
    # the library auto-close on context exit, `recv()` can raise instead of
    # returning the frame, and the message-content assertions below would be
    # skipped — a test that passes whether or not the refusal is sent. Keep the
    # socket open long enough to read the frame, and treat "closed with no
    # frame" as the failure it is.
    uri = f"ws://127.0.0.1:{port}/ws/terminal"
    received: list = []

    async with websockets.connect(uri) as ws:
        # The legacy protocol's first move: if a shell were alive, this would
        # run it. The refusal can arrive before this send completes, so a
        # closed connection here is expected and must not abort the run — the
        # point is that the payload never reached a shell, and the canary below
        # is what proves that.
        try:
            await ws.send(json.dumps({"type": "stdin", "data": f"echo {CANARY_MARKER} > {canary}\r"}))
        except websockets.exceptions.ConnectionClosed:
            print("  connection closed before the payload was sent (expected for a refusal)")

        deadline = asyncio.get_running_loop().time() + 3.0
        while asyncio.get_running_loop().time() < deadline:
            try:
                frame = await asyncio.wait_for(
                    ws.recv(), timeout=max(0.05, deadline - asyncio.get_running_loop().time())
                )
            except asyncio.TimeoutError:
                break
            except websockets.exceptions.ConnectionClosed:
                break
            if isinstance(frame, bytes):
                failures.append(
                    f"binary terminal bytes received — a PTY is still attached: {frame[:80]!r}"
                )
                return failures
            received.append(frame)

    if not received:
        failures.append(
            "the route closed without sending a refusal frame, so a legacy client "
            "cannot tell retirement from a transport failure"
        )
        return failures

    for raw in received:
        print(f"  received: {raw[:200]!r}")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            failures.append(f"response was not a control message: {raw[:120]!r}")
            continue
        if payload.get("type") != "error":
            failures.append(f"expected a type=error refusal, got {payload!r}")
            continue
        message = str(payload.get("message", ""))
        if "retired" not in message.lower():
            failures.append(f"refusal does not name retirement: {message!r}")
        else:
            print(f"  refusal is explicit: {message[:90]}...")

    # The decisive assertion: no shell, so no canary.
    await asyncio.sleep(0.5)
    if canary.exists():
        failures.append(f"CANARY CREATED — a shell executed the payload: {canary}")
    else:
        print("  canary absent — no shell executed the payload")

    return failures


async def main() -> int:
    handler_name, handler_source, lineno = load_retired_handler()
    print(f"handler: {handler_name}() at server.py:{lineno}")
    print(f"source excerpt: {handler_source.strip().splitlines()[1].strip()[:80]}")

    # A reintroduced spawn would have to appear in this function's body.
    body_lower = handler_source.lower()
    for forbidden in ("ptyprocess", "winpty", "create_subprocess", "os.system", "popen"):
        if forbidden in body_lower:
            print(f"FAIL: handler still references {forbidden!r}")
            return 1
    print("no process-spawn primitive in the handler body")

    app = build_app(handler_source, handler_name)

    with tempfile.TemporaryDirectory() as tmp:
        canary = Path(tmp) / "pwned.txt"
        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        task = asyncio.create_task(server.serve())

        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        else:
            print("FAIL: server did not start")
            return 1

        port = server.servers[0].sockets[0].getsockname()[1]
        print(f"listening on 127.0.0.1:{port}")
        try:
            failures = await exercise(port, canary)
        finally:
            server.should_exit = True
            await task

    if failures:
        print("\nFAIL:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nPASS: /ws/terminal refuses without spawning a shell")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
