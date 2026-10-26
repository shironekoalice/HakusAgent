"""
Session history persistence — SQLite-backed sessions & messages store.

Replaces the frontend's localStorage-only persistence (5–10 MB cap, no
cross-machine sync, lost on browser cache clear) with a server-side DB
that lives at ``~/.hakus/sessions.db``.

Why SQLite (and why in the sidecar, not Electron main):
  - The sidecar already owns every other piece of user data
    (``~/.hakus/config.yaml``, ``~/.hakus/recovery.db``,
    ``~/.hakus/user_states/``), so adding ``sessions.db`` there keeps
    all user data in one place — backup is "copy ~/.hakus".
  - sqlite3 is in the Python stdlib; no native rebuild dance like
    better-sqlite3 would impose on Electron upgrades.
  - The sidecar is the natural owner of session metadata because
    AgentCore's ContextManager (``hakus.agent``) already keys its
    in-memory cache by ``session_id`` — having the canonical
    session_id list server-side makes "list sessions" trivial.

Concurrency:
  - SQLite is opened with ``check_same_thread=False`` + a module-level
    ``threading.RLock``. FastAPI async endpoints call the sync functions
    directly — DB ops are sub-millisecond for our row counts (hundreds
    to low thousands), so blocking the event loop briefly is fine.
  - WAL mode is enabled for better read concurrency (so a slow
    ``GET /api/sessions`` doesn't block a concurrent write).

Schema versioning:
  - ``schema_version`` row in ``meta`` table. Future migrations add
    ``ALTER TABLE`` / ``CREATE INDEX`` blocks below the version check.
  - Current version: 2.
    v2 (Codex-inspired refactor):
      - sessions: + parent_id (thread tree), origin (user|agent|fork|automation)
      - events: append-only timeline ledger (id, session_id, seq, type, ...)
      - automations / automation_runs: scheduled agent tasks
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from hakus.compat_writers import (
    PythonWritersFrozen,
    assert_writers_open as _assert_writers_open,
    writers_frozen,
)

logger = logging.getLogger(__name__)

# Phase 0 migration gate (REFACTOR_STATUS "freeze new Python
# transcript/checkpoint writers"). Once the Rust Runtime owns the canonical
# ledger, new Python transcript rows must not appear: every extra row
# widens the drift the Phase 1 importer has to reconcile. Setting
# HAKUS_FREEZE_PYTHON_WRITERS freezes the new-data writers (messages, events,
# truncation markers, sessions, and compatibility automations) — reads remain
# available, while state mutations (including updates to existing rows) raise
# PythonWritersFrozen. The Rust Runtime owns the default automation path, so
# the Python scheduler is disabled while this compatibility boundary is read-
# only. The bulk importer is the one deliberate write exception because it is
# the sanctioned migration path. Checkpoint disk persistence
# (hakus.checkpoint.CheckpointManager.persist) enforces the same flag.


# Where the DB file lives. Respects $HAKUS_HOME override (used by tests
# and by the Electron launcher when running portably).
_DEFAULT_HAKUS_HOME = os.path.expanduser("~/.hakus")


def _hakus_home() -> Path:
    env = os.environ.get("HAKUS_HOME")
    if env:
        return Path(env)
    return Path(_DEFAULT_HAKUS_HOME)


def _db_path() -> Path:
    return _hakus_home() / "sessions.db"


# Module-level connection + lock. We keep one connection for the lifetime
# of the sidecar process — sqlite3 handles concurrency via the lock + WAL.
_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None


SCHEMA_VERSION = 2


def _schema_sql() -> str:
    return """
    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL DEFAULT 'New Chat',
        remote_session_id TEXT,
        provider          TEXT,
        pinned            INTEGER NOT NULL DEFAULT 0,
        parent_id         TEXT,
        origin            TEXT NOT NULL DEFAULT 'user',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        role             TEXT NOT NULL,
        content          TEXT NOT NULL DEFAULT '',
        reasoning        TEXT,
        tool_calls_json  TEXT,
        input_tokens     INTEGER,
        output_tokens    INTEGER,
        error            TEXT,
        streaming        INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON sessions(parent_id);

    CREATE TABLE IF NOT EXISTS events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        type         TEXT NOT NULL,
        payload_json TEXT,
        turn_id      TEXT,
        created_at   INTEGER NOT NULL,
        UNIQUE (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, seq);

    CREATE TABLE IF NOT EXISTS automations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        schedule    TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        prompt      TEXT NOT NULL,
        session_id  TEXT,
        created_at  INTEGER NOT NULL,
        next_run_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
        id            TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'running',
        session_id    TEXT,
        error         TEXT,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER,
        FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runs_automation
        ON automation_runs(automation_id, started_at DESC);
    """


def _get_conn() -> sqlite3.Connection:
    """Lazily open the DB connection and run migrations if needed."""
    global _conn
    if _conn is not None:
        return _conn

    with _lock:
        if _conn is not None:
            return _conn

        db_path = _db_path()
        db_path.parent.mkdir(parents=True, exist_ok=True)

        # check_same_thread=False because FastAPI's threadpool will call us.
        # We do our own locking via _lock.
        conn = sqlite3.connect(
            str(db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we wrap multi-step ops in BEGIN/COMMIT
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA synchronous=NORMAL;")  # WAL + NORMAL is safe & fast

        # Pre-migration: if a legacy sessions table exists (v1), add the
        # v2 columns BEFORE running _schema_sql() — the script creates
        # idx_sessions_parent ON sessions(parent_id), which would fail on
        # a table that lacks the column.
        legacy = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
        ).fetchone()
        if legacy:
            existing_cols = {
                r["name"] for r in conn.execute("PRAGMA table_info(sessions)")
            }
            if "parent_id" not in existing_cols:
                conn.execute("ALTER TABLE sessions ADD COLUMN parent_id TEXT")
            if "origin" not in existing_cols:
                conn.execute(
                    "ALTER TABLE sessions ADD COLUMN origin TEXT"
                    " NOT NULL DEFAULT 'user'"
                )

        conn.executescript(_schema_sql())

        # Record schema version (idempotent — INSERT OR IGNORE)
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        row = conn.execute(
            "SELECT value FROM meta WHERE key=?", ("schema_version",)
        ).fetchone()
        current = int(row["value"]) if row else 0

        if current < SCHEMA_VERSION:
            # v1 -> v2: add thread-tree columns to existing sessions table
            if current < 2:
                existing_cols = {
                    r["name"]
                    for r in conn.execute(
                        "PRAGMA table_info(sessions)"
                    ).fetchall()
                }
                if "parent_id" not in existing_cols:
                    conn.execute(
                        "ALTER TABLE sessions ADD COLUMN parent_id TEXT"
                    )
                if "origin" not in existing_cols:
                    conn.execute(
                        "ALTER TABLE sessions ADD COLUMN origin TEXT"
                        " NOT NULL DEFAULT 'user'"
                    )
            conn.execute(
                "UPDATE meta SET value=? WHERE key=?",
                (str(SCHEMA_VERSION), "schema_version"),
            )
            logger.info(
                f"session_store: migrated schema v{current} -> v{SCHEMA_VERSION}"
            )

        _conn = conn
        logger.info(f"session_store: opened {db_path}")
        return conn


# ============================================================================
# Sessions
# ============================================================================


def _row_to_session(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "remote_session_id": row["remote_session_id"],
        "provider": row["provider"],
        "pinned": bool(row["pinned"]),
        "parent_id": row["parent_id"],
        "origin": row["origin"] if "origin" in row.keys() else "user",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_sessions() -> List[Dict[str, Any]]:
    """Return all sessions, newest first (by updated_at)."""
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC"
        ).fetchall()
    return [_row_to_session(r) for r in rows]


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    with _lock:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id=?", (session_id,)
        ).fetchone()
    return _row_to_session(row) if row else None


def create_session(
    session_id: str,
    title: str = "New Chat",
    remote_session_id: Optional[str] = None,
    provider: Optional[str] = None,
    pinned: bool = False,
    created_at: Optional[int] = None,
    updated_at: Optional[int] = None,
    parent_id: Optional[str] = None,
    origin: str = "user",
) -> Dict[str, Any]:
    """Insert a new session row. Idempotent on id (raises if collision)."""
    _assert_writers_open("create_session", f"session={session_id}")
    import time as _time
    now = int(_time.time() * 1000)
    conn = _get_conn()
    with _lock:
        conn.execute(
            """
            INSERT INTO sessions
                (id, title, remote_session_id, provider, pinned,
                 parent_id, origin, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                title,
                remote_session_id,
                provider,
                1 if pinned else 0,
                parent_id,
                origin,
                created_at if created_at is not None else now,
                updated_at if updated_at is not None else now,
            ),
        )
    result = get_session(session_id)
    assert result is not None, "just inserted"
    return result


def update_session(
    session_id: str,
    *,
    title: Optional[str] = None,
    remote_session_id: Optional[str] = None,
    provider: Optional[str] = None,
    pinned: Optional[bool] = None,
    touch_updated: bool = True,
) -> Optional[Dict[str, Any]]:
    """Patch a session. Only non-None fields are updated."""
    sets: List[str] = []
    args: List[Any] = []
    if title is not None:
        sets.append("title=?")
        args.append(title)
    if remote_session_id is not None:
        sets.append("remote_session_id=?")
        args.append(remote_session_id)
    if provider is not None:
        sets.append("provider=?")
        args.append(provider)
    if pinned is not None:
        sets.append("pinned=?")
        args.append(1 if pinned else 0)
    if not sets and not touch_updated:
        return get_session(session_id)
    _assert_writers_open("update_session", f"session={session_id}")
    if touch_updated:
        import time as _time
        sets.append("updated_at=?")
        args.append(int(_time.time() * 1000))
    args.append(session_id)

    conn = _get_conn()
    with _lock:
        conn.execute(
            f"UPDATE sessions SET {', '.join(sets)} WHERE id=?", tuple(args)
        )
    return get_session(session_id)


def delete_session(session_id: str) -> bool:
    """Delete a session + cascade messages. Returns True if a row was deleted."""
    _assert_writers_open("delete_session", f"session={session_id}")
    conn = _get_conn()
    with _lock:
        cur = conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        return cur.rowcount > 0


# ============================================================================
# Messages
# ============================================================================


def _row_to_message(row: sqlite3.Row) -> Dict[str, Any]:
    tool_calls_raw = row["tool_calls_json"]
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "role": row["role"],
        "content": row["content"],
        "reasoning": row["reasoning"],
        "tool_calls": json.loads(tool_calls_raw) if tool_calls_raw else [],
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "error": row["error"],
        "streaming": bool(row["streaming"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_messages(session_id: str) -> List[Dict[str, Any]]:
    """Visible messages for a session (projection over the messages table).

    The timeline ledger is append-only: rewind/clear append a
    ``truncation`` event instead of physically deleting rows, and this
    projection excludes every message id listed in a truncation event.
    Return shape is unchanged."""
    hidden = _hidden_message_ids(session_id)
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC",
            (session_id,),
        ).fetchall()
    return [_row_to_message(r) for r in rows if r["id"] not in hidden]


def _hidden_message_ids(session_id: str) -> set:
    """Union of deleted_ids across all truncation events of a session."""
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT payload_json FROM events WHERE session_id=? AND type='truncation'",
            (session_id,),
        ).fetchall()
    hidden: set = set()
    for row in rows:
        try:
            payload = json.loads(row["payload_json"]) if row["payload_json"] else {}
        except (ValueError, TypeError):
            continue
        for mid in payload.get("deleted_ids") or []:
            hidden.add(mid)
    return hidden


def append_truncation(
    session_id: str,
    *,
    deleted_ids: Optional[List[str]] = None,
    cutoff_ts: Optional[int] = None,
    reason: str = "rewind",
) -> Dict[str, Any]:
    """Record a truncation marker in the ledger (Codex rewind style).

    Does NOT delete anything — :func:`list_messages` projects over
    ``deleted_ids`` instead, so the ledger stays append-only and rewind
    remains reversible in principle. ``cutoff_ts`` is kept for
    informational purposes only."""
    return append_event(
        session_id,
        "truncation",
        {"cutoff_ts": cutoff_ts, "deleted_ids": deleted_ids or [], "reason": reason},
    )


def add_message(
    session_id: str,
    message_id: str,
    role: str,
    content: str = "",
    *,
    reasoning: Optional[str] = None,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    error: Optional[str] = None,
    streaming: bool = False,
    created_at: Optional[int] = None,
    updated_at: Optional[int] = None,
) -> Dict[str, Any]:
    import time as _time
    if writers_frozen():
        raise PythonWritersFrozen(
            f"add_message refused: Python transcript writers are frozen "
            f"(HAKUS_FREEZE_PYTHON_WRITERS); session={session_id}"
        )
    now = int(_time.time() * 1000)
    conn = _get_conn()
    with _lock:
        conn.execute(
            """
            INSERT INTO messages
                (id, session_id, role, content, reasoning, tool_calls_json,
                 input_tokens, output_tokens, error, streaming,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                session_id,
                role,
                content,
                reasoning,
                json.dumps(tool_calls) if tool_calls else None,
                input_tokens,
                output_tokens,
                error,
                1 if streaming else 0,
                created_at if created_at is not None else now,
                updated_at if updated_at is not None else now,
            ),
        )
        # Bump session.updated_at so list_sessions ordering reflects new msg
        conn.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?",
            (updated_at if updated_at is not None else now, session_id),
        )
    # Re-read to return canonical row
    with _lock:
        row = conn.execute(
            "SELECT * FROM messages WHERE id=?", (message_id,)
        ).fetchone()
    # Timeline ledger: record the message addition (append-only).
    try:
        append_event(
            session_id,
            "message.added",
            {"id": message_id, "role": role, "content_chars": len(content or "")},
            created_at=created_at if created_at is not None else now,
        )
    except Exception:
        pass  # ledger is best-effort; the message row is authoritative
    return _row_to_message(row)


def update_message(
    message_id: str,
    *,
    content: Optional[str] = None,
    reasoning: Optional[str] = None,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    error: Optional[str] = None,
    streaming: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    sets: List[str] = []
    args: List[Any] = []
    if content is not None:
        sets.append("content=?")
        args.append(content)
    if reasoning is not None:
        sets.append("reasoning=?")
        args.append(reasoning)
    if tool_calls is not None:
        sets.append("tool_calls_json=?")
        args.append(json.dumps(tool_calls))
    if input_tokens is not None:
        sets.append("input_tokens=?")
        args.append(input_tokens)
    if output_tokens is not None:
        sets.append("output_tokens=?")
        args.append(output_tokens)
    if error is not None:
        sets.append("error=?")
        args.append(error)
    if streaming is not None:
        sets.append("streaming=?")
        args.append(1 if streaming else 0)
    if not sets:
        return None
    if writers_frozen():
        raise PythonWritersFrozen(
            f"update_message refused: Python transcript writers are frozen "
            f"(HAKUS_FREEZE_PYTHON_WRITERS); message={message_id}"
        )

    import time as _time
    sets.append("updated_at=?")
    args.append(int(_time.time() * 1000))
    args.append(message_id)

    conn = _get_conn()
    with _lock:
        conn.execute(
            f"UPDATE messages SET {', '.join(sets)} WHERE id=?", tuple(args)
        )
        # Also bump session.updated_at (cheap; keeps list ordering fresh)
        sid_row = conn.execute(
            "SELECT session_id FROM messages WHERE id=?", (message_id,)
        ).fetchone()
        if sid_row:
            conn.execute(
                "UPDATE sessions SET updated_at=? WHERE id=?",
                (int(_time.time() * 1000), sid_row["session_id"]),
            )

    with _lock:
        row = conn.execute(
            "SELECT * FROM messages WHERE id=?", (message_id,)
        ).fetchone()
    if row:
        # Timeline ledger: record which fields were mutated (append-only).
        try:
            changed = {
                k: True for k, v in
                {
                    "content": content is not None,
                    "reasoning": reasoning is not None,
                    "tool_calls": tool_calls is not None,
                    "input_tokens": input_tokens is not None,
                    "output_tokens": output_tokens is not None,
                    "error": error is not None,
                    "streaming": streaming is not None,
                }.items() if v
            }
            append_event(
                row["session_id"],
                "message.updated",
                {"id": message_id, "changed": list(changed.keys())},
            )
        except Exception:
            pass  # ledger is best-effort
    return _row_to_message(row) if row else None


def delete_message(message_id: str) -> bool:
    _assert_writers_open("delete_message", f"message={message_id}")
    conn = _get_conn()
    with _lock:
        cur = conn.execute("DELETE FROM messages WHERE id=?", (message_id,))
        return cur.rowcount > 0


def clear_session_messages(session_id: str) -> int:
    """Hide all messages belonging to a session via a truncation event
    (append-only ledger — rows are NOT physically deleted). Returns the
    number of messages now hidden. Used by the TopBar 'clear conversation'
    button — user wants to start fresh in the same session without deleting it."""
    _assert_writers_open("clear_session_messages", f"session={session_id}")
    import time as _time
    now = int(_time.time() * 1000)
    visible = list_messages(session_id)  # projection before truncation
    append_truncation(
        session_id,
        deleted_ids=[m["id"] for m in visible],
        cutoff_ts=now,
        reason="clear",
    )
    conn = _get_conn()
    with _lock:
        # Bump session.updated_at so it floats to the top of the sidebar
        conn.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?",
            (now, session_id),
        )
    return len(visible)


# ============================================================================
# Bulk operations
# ============================================================================


def bulk_import(
    sessions: List[Dict[str, Any]],
    messages: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, int]:
    """Import sessions + messages (used by the migration endpoint).

    Idempotent: existing rows are replaced (INSERT OR REPLACE).
    Returns counts of inserted/replaced rows.
    """
    conn = _get_conn()
    n_sessions = 0
    n_messages = 0
    with _lock:
        conn.execute("BEGIN")
        try:
            for s in sessions:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO sessions
                        (id, title, remote_session_id, provider, pinned,
                         parent_id, origin, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        s["id"],
                        s.get("title", "New Chat"),
                        s.get("remote_session_id"),
                        s.get("provider"),
                        1 if s.get("pinned") else 0,
                        s.get("parent_id"),
                        s.get("origin", "user"),
                        s.get("created_at"),
                        s.get("updated_at"),
                    ),
                )
                n_sessions += 1
            for sid, msgs in messages.items():
                for m in msgs:
                    tc = m.get("tool_calls")
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO messages
                            (id, session_id, role, content, reasoning,
                             tool_calls_json, input_tokens, output_tokens,
                             error, streaming, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            m["id"],
                            sid,
                            m.get("role", "user"),
                            m.get("content", ""),
                            m.get("reasoning"),
                            json.dumps(tc) if tc else None,
                            m.get("input_tokens"),
                            m.get("output_tokens"),
                            m.get("error"),
                            1 if m.get("streaming") else 0,
                            m.get("created_at"),
                            m.get("updated_at"),
                        ),
                    )
                    n_messages += 1
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return {"sessions": n_sessions, "messages": n_messages}


def wipe_all() -> int:
    """Delete ALL sessions + messages. Used by the dangerous reset button.
    Returns number of sessions deleted."""
    _assert_writers_open("wipe_all", "all sessions")
    conn = _get_conn()
    with _lock:
        cur = conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()
        n = cur["n"] if cur else 0
        conn.execute("DELETE FROM messages")
        conn.execute("DELETE FROM sessions")
    return n


def export_all() -> Dict[str, Any]:
    """Export the entire sessions + messages DB as a JSON-serializable dict.

    Format:
        {
            "schema_version": 1,
            "exported_at": 1784384195428,
            "sessions": [...],
            "messages": { session_id: [messages], ... }
        }

    This is the inverse of bulk_import — the same payload shape can be
    POSTed back to /api/sessions/migrate to restore.
    """
    conn = _get_conn()
    with _lock:
        sess_rows = conn.execute(
            "SELECT * FROM sessions ORDER BY updated_at DESC"
        ).fetchall()
        msg_rows = conn.execute(
            "SELECT * FROM messages ORDER BY created_at ASC"
        ).fetchall()

    sessions = [_row_to_session(r) for r in sess_rows]
    messages: Dict[str, List[Dict[str, Any]]] = {}
    for r in msg_rows:
        m = _row_to_message(r)
        sid = m["session_id"]
        messages.setdefault(sid, []).append(m)

    import time as _time
    return {
        "schema_version": SCHEMA_VERSION,
        "exported_at": int(_time.time() * 1000),
        "sessions": sessions,
        "messages": messages,
    }


# ============================================================================
# Events — append-only timeline ledger (Codex thread_timeline_ledger style)
# ============================================================================


def append_event(
    session_id: str,
    type: str,
    payload: Optional[Dict[str, Any]] = None,
    *,
    turn_id: Optional[str] = None,
    created_at: Optional[int] = None,
) -> Dict[str, Any]:
    """Append one event to the session's timeline ledger.

    Events are append-only: nothing ever mutates or deletes a row here
    (rewind appends a ``truncation`` marker instead — see P5). The seq is
    per-session monotonically increasing.
    """
    import time as _time
    if writers_frozen():
        raise PythonWritersFrozen(
            f"append_event refused: Python transcript writers are frozen "
            f"(HAKUS_FREEZE_PYTHON_WRITERS); session={session_id} type={type}"
        )
    now = int(_time.time() * 1000)
    conn = _get_conn()
    with _lock:
        row = conn.execute(
            "SELECT MAX(seq) AS m FROM events WHERE session_id=?",
            (session_id,),
        ).fetchone()
        seq = (row["m"] or 0) + 1
        conn.execute(
            """
            INSERT INTO events
                (session_id, seq, type, payload_json, turn_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                seq,
                type,
                json.dumps(payload) if payload else None,
                turn_id,
                created_at if created_at is not None else now,
            ),
        )
    return {
        "session_id": session_id,
        "seq": seq,
        "type": type,
        "payload": payload,
        "turn_id": turn_id,
        "created_at": created_at if created_at is not None else now,
    }


def list_events(session_id: str, after_seq: int = 0) -> List[Dict[str, Any]]:
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC",
            (session_id, after_seq),
        ).fetchall()
    return [
        {
            "session_id": r["session_id"],
            "seq": r["seq"],
            "type": r["type"],
            "payload": json.loads(r["payload_json"]) if r["payload_json"] else None,
            "turn_id": r["turn_id"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


# ============================================================================
# Automations — scheduled agent tasks (Codex automations style)
# ============================================================================


def _row_to_automation(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "schedule": row["schedule"],
        "enabled": bool(row["enabled"]),
        "prompt": row["prompt"],
        "session_id": row["session_id"],
        "created_at": row["created_at"],
        "next_run_at": row["next_run_at"],
    }


def list_automations() -> List[Dict[str, Any]]:
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM automations ORDER BY created_at ASC"
        ).fetchall()
    return [_row_to_automation(r) for r in rows]


def get_automation(automation_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    with _lock:
        row = conn.execute(
            "SELECT * FROM automations WHERE id=?", (automation_id,)
        ).fetchone()
    return _row_to_automation(row) if row else None


def create_automation(
    automation_id: str,
    name: str,
    schedule: str,
    prompt: str,
    *,
    session_id: Optional[str] = None,
    enabled: bool = True,
    next_run_at: Optional[int] = None,
    created_at: Optional[int] = None,
) -> Dict[str, Any]:
    import time as _time
    _assert_writers_open("create_automation", f"automation={automation_id}")
    conn = _get_conn()
    with _lock:
        conn.execute(
            """
            INSERT INTO automations
                (id, name, schedule, enabled, prompt, session_id,
                 created_at, next_run_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                automation_id,
                name,
                schedule,
                1 if enabled else 0,
                prompt,
                session_id,
                created_at if created_at is not None else int(_time.time() * 1000),
                next_run_at,
            ),
        )
    result = get_automation(automation_id)
    assert result is not None, "just inserted"
    return result


def update_automation(
    automation_id: str,
    *,
    name: Optional[str] = None,
    schedule: Optional[str] = None,
    enabled: Optional[bool] = None,
    prompt: Optional[str] = None,
    session_id: Optional[str] = None,
    next_run_at: Optional[int] = None,
    clear_next_run: bool = False,
) -> Optional[Dict[str, Any]]:
    sets: List[str] = []
    args: List[Any] = []
    if name is not None:
        sets.append("name=?")
        args.append(name)
    if schedule is not None:
        sets.append("schedule=?")
        args.append(schedule)
    if enabled is not None:
        sets.append("enabled=?")
        args.append(1 if enabled else 0)
    if prompt is not None:
        sets.append("prompt=?")
        args.append(prompt)
    if session_id is not None:
        sets.append("session_id=?")
        args.append(session_id)
    if next_run_at is not None or clear_next_run:
        sets.append("next_run_at=?")
        args.append(None if clear_next_run else next_run_at)
    if not sets:
        return get_automation(automation_id)
    _assert_writers_open("update_automation", f"automation={automation_id}")
    args.append(automation_id)
    conn = _get_conn()
    with _lock:
        conn.execute(
            f"UPDATE automations SET {', '.join(sets)} WHERE id=?", tuple(args)
        )
    return get_automation(automation_id)


def delete_automation(automation_id: str) -> bool:
    _assert_writers_open("delete_automation", f"automation={automation_id}")
    conn = _get_conn()
    with _lock:
        cur = conn.execute("DELETE FROM automations WHERE id=?", (automation_id,))
        return cur.rowcount > 0


def due_automations(now_ms: int) -> List[Dict[str, Any]]:
    """Automations that are enabled and whose next_run_at has passed."""
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM automations WHERE enabled=1 AND next_run_at IS NOT NULL"
            " AND next_run_at<=? ORDER BY next_run_at ASC",
            (now_ms,),
        ).fetchall()
    return [_row_to_automation(r) for r in rows]


def create_automation_run(
    run_id: str,
    automation_id: str,
    *,
    session_id: Optional[str] = None,
    started_at: Optional[int] = None,
) -> Dict[str, Any]:
    import time as _time
    _assert_writers_open("create_automation_run", f"run={run_id}")
    now = int(_time.time() * 1000)
    conn = _get_conn()
    with _lock:
        conn.execute(
            """
            INSERT INTO automation_runs
                (id, automation_id, status, session_id, started_at)
            VALUES (?, ?, 'running', ?, ?)
            """,
            (
                run_id,
                automation_id,
                session_id,
                started_at if started_at is not None else now,
            ),
        )
    return {
        "id": run_id,
        "automation_id": automation_id,
        "status": "running",
        "session_id": session_id,
        "error": None,
        "started_at": now,
        "finished_at": None,
    }


def finish_automation_run(
    run_id: str,
    *,
    status: str = "completed",
    error: Optional[str] = None,
) -> None:
    import time as _time
    _assert_writers_open("finish_automation_run", f"run={run_id}")
    conn = _get_conn()
    with _lock:
        conn.execute(
            "UPDATE automation_runs SET status=?, error=?, finished_at=? WHERE id=?",
            (status, error, int(_time.time() * 1000), run_id),
        )


def list_automation_runs(automation_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM automation_runs WHERE automation_id=?"
            " ORDER BY started_at DESC LIMIT ?",
            (automation_id, limit),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "automation_id": r["automation_id"],
            "status": r["status"],
            "session_id": r["session_id"],
            "error": r["error"],
            "started_at": r["started_at"],
            "finished_at": r["finished_at"],
        }
        for r in rows
    ]
