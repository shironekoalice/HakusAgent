"""SessionLogRecorder — append-only JSONL recorder for agent turns.

Borrows the design philosophy from DeepSeek Harness's "append-only session
log": every event the model sees, every tool call, every tool result,
every sub-agent spawn is recorded in an immutable, line-delimited JSON
file. This enables:

1. **Counterfactual replay** — re-run a turn from any checkpoint with
   different params (e.g. a different model, a different mode whitelist)
   and diff the outcomes.
2. **Crash recovery** — if the sidecar dies mid-turn, the next launch
   can read the JSONL and resume from the last persisted event.
3. **Audit & debugging** — when a user reports "the agent did X and I
   don't know why", the JSONL is the ground truth.
4. **Rewind correctness** — `rewind_to_message` on the backend can now
   truncate the JSONL at the corresponding turn boundary, so the log
   never contains events for messages that have been deleted.

Path layout:
  ~/.hakus/sessions/<session_id>/
    session_log.jsonl       ← the live log
    session_log.compacted.jsonl  ← archive of pre-compaction events

Event shape (one JSON object per line):
  {"type": "turn_start", "ts": 1736000000.0, "turn": 3,
   "user_message": "...", "system_prompt_hash": "sha256:...",
   "run_mode": "deep", "working_dir": "/path/to/project"}
  {"type": "text_delta", "ts": ..., "turn": 3, "text": "..."}
  {"type": "tool_call_started", "ts": ..., "turn": 3,
   "call_id": "...", "name": "read_file",
   "arguments": {"path": "..."}, "category": "filesystem"}
  {"type": "tool_call_finished", "ts": ..., "turn": 3,
   "call_id": "...", "success": true, "duration_ms": 12,
   "result_truncated": "first 500 chars..."}
  {"type": "turn_completed", "ts": ..., "turn": 3,
   "content": "...", "input_tokens": 1234, "output_tokens": 567}
  {"type": "turn_failed", "ts": ..., "turn": 3, "error": "...", "code": "..."}
  {"type": "cancelled", "ts": ..., "turn": 3, "reason": "user_interrupt"}
  {"type": "compacted", "ts": ..., "turn": 3,
   "reason": "size_limit", "events_archived": 500,
   "archive_path": "session_log.compacted.jsonl"}

Compaction policy:
  - When the live JSONL exceeds 5 MB OR 1000 events, the oldest 50%
    of events are moved to `session_log.compacted.jsonl` and a
    `compacted` event is written to the live log. The compacted file
    is append-only too — multiple compactions accumulate.
  - Compaction is lazy: it runs on the next `record_*` call after the
    threshold is crossed, not on a timer.
  - Tool results are *always* truncated to 500 chars in the JSONL.
    The full result stays in the agent's context window (which has its
    own compression) and in the SQLite messages table if it's part of
    a persisted message. The JSONL is for replay/audit, not for
    re-feeding the model.

This module is thread-safe (single RLock per session). All file I/O is
synchronous (JSONL writes are tiny — sub-millisecond) so we don't need
asyncio complexity here.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from utils.logger import get_logger
from .compat_writers import writers_frozen

logger = get_logger(__name__)

# ── Compaction thresholds ────────────────────────────────────────────
MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024   # 5 MB
MAX_LOG_EVENTS = 1000
COMPACTION_RATIO = 0.5                 # archive oldest 50%
TOOL_RESULT_PREVIEW_CHARS = 500
TEXT_DELTA_BATCH_THRESHOLD = 50        # if >50 text_deltas per turn, batch them


def _hakus_home() -> Path:
    """Return ~/.hakus (or $HAKUS_HOME if set)."""
    return Path(os.environ.get("HAKUS_HOME", "") or Path.home() / ".hakus")


def _session_dir(session_id: str) -> Path:
    return _hakus_home() / "sessions" / session_id


def _log_path(session_id: str) -> Path:
    return _session_dir(session_id) / "session_log.jsonl"


def _archive_path(session_id: str) -> Path:
    return _session_dir(session_id) / "session_log.compacted.jsonl"


def _now_ts() -> float:
    return datetime.now().timestamp()


class SessionLogRecorder:
    """Per-session JSONL recorder.

    One recorder per session_id. The sidecar holds a weakref cache so
    repeated calls reuse the same file handle. The recorder is lazy —
    the file is only opened on the first `record_*` call.
    """

    _instances: Dict[str, "SessionLogRecorder"] = {}
    _instances_lock = threading.Lock()

    @classmethod
    def get(cls, session_id: str) -> "SessionLogRecorder":
        """Get or create the singleton recorder for a session."""
        with cls._instances_lock:
            if session_id not in cls._instances:
                cls._instances[session_id] = SessionLogRecorder(session_id)
            return cls._instances[session_id]

    @classmethod
    def drop(cls, session_id: str) -> None:
        """Remove the cached instance (e.g. when session is deleted)."""
        with cls._instances_lock:
            cls._instances.pop(session_id, None)

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._lock = threading.RLock()
        self._path = _log_path(session_id)
        self._archive = _archive_path(session_id)
        self._event_count = 0
        self._current_turn = 0
        # Ensure the directory exists lazily on first write.
        self._dir_created = False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_dir(self) -> None:
        if writers_frozen():
            return
        if self._dir_created:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._dir_created = True
        except Exception as e:
            logger.warning(f"[session_log] mkdir failed for {self._path.parent}: {e}")

    def _write_line(self, obj: Dict[str, Any]) -> None:
        """Append one JSON line to the file. Must hold self._lock."""
        if writers_frozen():
            return
        try:
            line = json.dumps(obj, ensure_ascii=False, default=str)
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            self._event_count += 1
        except Exception as e:
            logger.warning(f"[session_log] write failed: {e}")

    def _maybe_compact(self) -> None:
        """If the log exceeds thresholds, archive the oldest half."""
        if writers_frozen():
            return
        try:
            size = self._path.stat().st_size
        except Exception:
            return
        if size < MAX_LOG_SIZE_BYTES and self._event_count < MAX_LOG_EVENTS:
            return
        try:
            # Read all lines, split at the midpoint
            with open(self._path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) < 10:
                return  # not worth compacting
            keep_count = len(lines) - int(len(lines) * COMPACTION_RATIO)
            archived = lines[:keep_count]
            kept = lines[keep_count:]

            # Append archived lines to the archive file
            with open(self._archive, "a", encoding="utf-8") as f:
                f.writelines(archived)

            # Rewrite the live log with only the kept lines
            with open(self._path, "w", encoding="utf-8") as f:
                f.writelines(kept)

            self._event_count = len(kept)

            # Write a compaction marker
            self._write_line({
                "type": "compacted",
                "ts": _now_ts(),
                "reason": "size_limit" if size >= MAX_LOG_SIZE_BYTES else "event_limit",
                "events_archived": len(archived),
                "archive_path": str(self._archive),
            })
            logger.info(
                f"[session_log] compacted {self.session_id}: "
                f"archived {len(archived)} events, kept {len(kept)}"
            )
        except Exception as e:
            logger.warning(f"[session_log] compaction failed: {e}")

    # ------------------------------------------------------------------
    # Public recording API
    # ------------------------------------------------------------------

    def record_turn_start(
        self,
        *,
        turn: int,
        user_message: str,
        system_prompt_hash: str = "",
        run_mode: str = "",
        working_dir: str = "",
        provider: str = "",
        model: str = "",
    ) -> None:
        with self._lock:
            self._ensure_dir()
            self._current_turn = turn
            self._write_line({
                "type": "turn_start",
                "ts": _now_ts(),
                "turn": turn,
                "user_message": user_message,
                "system_prompt_hash": system_prompt_hash,
                "run_mode": run_mode,
                "working_dir": working_dir,
                "provider": provider,
                "model": model,
            })

    def record_text_delta(self, *, turn: int, text: str) -> None:
        with self._lock:
            self._write_line({
                "type": "text_delta",
                "ts": _now_ts(),
                "turn": turn,
                "text": text,
            })

    def record_reasoning(self, *, turn: int, text: str) -> None:
        with self._lock:
            self._write_line({
                "type": "reasoning",
                "ts": _now_ts(),
                "turn": turn,
                "text": text,
            })

    def record_tool_call_started(
        self,
        *,
        turn: int,
        call_id: str,
        name: str,
        arguments: Dict[str, Any],
        category: str = "",
    ) -> None:
        with self._lock:
            self._write_line({
                "type": "tool_call_started",
                "ts": _now_ts(),
                "turn": turn,
                "call_id": call_id,
                "name": name,
                "arguments": arguments,
                "category": category,
            })

    def record_tool_call_finished(
        self,
        *,
        turn: int,
        call_id: str,
        name: str,
        success: bool,
        duration_ms: float,
        result: str = "",
        error: str = "",
    ) -> None:
        with self._lock:
            preview = (result or "")[:TOOL_RESULT_PREVIEW_CHARS]
            truncated = len(result or "") > TOOL_RESULT_PREVIEW_CHARS
            self._write_line({
                "type": "tool_call_finished",
                "ts": _now_ts(),
                "turn": turn,
                "call_id": call_id,
                "name": name,
                "success": success,
                "duration_ms": duration_ms,
                "result_preview": preview,
                "result_truncated": truncated,
                "result_full_length": len(result or ""),
                "error": error,
            })
            self._maybe_compact()

    def record_subagent_spawned(
        self,
        *,
        turn: int,
        sub_agent_id: str,
        task: str,
        allowed_tools: Optional[list] = None,
    ) -> None:
        with self._lock:
            self._write_line({
                "type": "subagent_spawned",
                "ts": _now_ts(),
                "turn": turn,
                "sub_agent_id": sub_agent_id,
                "task": task,
                "allowed_tools": allowed_tools or [],
            })

    def record_token_usage(
        self,
        *,
        turn: int,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_hit_tokens: int = 0,
        cache_miss_tokens: int = 0,
    ) -> None:
        with self._lock:
            self._write_line({
                "type": "token_usage",
                "ts": _now_ts(),
                "turn": turn,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_hit_tokens": cache_hit_tokens,
                "cache_miss_tokens": cache_miss_tokens,
            })

    def record_turn_completed(
        self,
        *,
        turn: int,
        content: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        with self._lock:
            self._write_line({
                "type": "turn_completed",
                "ts": _now_ts(),
                "turn": turn,
                "content": content,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            })
            self._maybe_compact()

    def record_turn_failed(self, *, turn: int, error: str, code: str = "") -> None:
        with self._lock:
            self._write_line({
                "type": "turn_failed",
                "ts": _now_ts(),
                "turn": turn,
                "error": error,
                "code": code,
            })

    def record_cancelled(self, *, turn: int, reason: str = "user_interrupt") -> None:
        with self._lock:
            self._write_line({
                "type": "cancelled",
                "ts": _now_ts(),
                "turn": turn,
                "reason": reason,
            })

    def record_custom(self, *, turn: int, event_type: str, **data: Any) -> None:
        """Escape hatch for ad-hoc events (e.g. permission_decision)."""
        with self._lock:
            obj = {
                "type": event_type,
                "ts": _now_ts(),
                "turn": turn,
            }
            obj.update(data)
            self._write_line(obj)

    # ------------------------------------------------------------------
    # Rewind support
    # ------------------------------------------------------------------

    def rewind_to_turn(self, *, keep_turns: int) -> None:
        """Truncate the log so only events from turns 1..keep_turns remain.

        Used by the backend's `rewind_to_message` endpoint: when the
        user rewinds to a message in turn N, all events from turn N+1
        onwards are deleted from the log (they correspond to messages
        that have been deleted from the store). Events from turn N
        itself are kept (the user message + the partial AI response
        that was being generated).

        This is the only operation that *deletes* from the log. It's
        not append-only in the strict sense, but it's necessary to keep
        the log consistent with the message store after a rewind.
        """
        if writers_frozen():
            return
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            except FileNotFoundError:
                return
            kept = []
            for line in lines:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("turn", 0) <= keep_turns:
                    kept.append(line)
            with open(self._path, "w", encoding="utf-8") as f:
                f.writelines(kept)
            self._event_count = len(kept)

    def clear(self) -> None:
        """Delete both the live log and the archive. Used when a session
        is deleted entirely."""
        if writers_frozen():
            return
        with self._lock:
            for p in [self._path, self._archive]:
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass
                except Exception as e:
                    logger.warning(f"[session_log] unlink {p} failed: {e}")
            self._event_count = 0

    # ------------------------------------------------------------------
    # Read API (for /api/sessions/{id}/log endpoint)
    # ------------------------------------------------------------------

    def read_events(self, *, since_turn: int = 0, limit: int = 500) -> list[dict]:
        """Return events from the live log (and archive if requested).

        Args:
            since_turn: only return events with turn >= this value.
                0 means "all turns".
            limit: max events to return. The most recent `limit` events
                are returned (so the caller sees the tail of the log).
        """
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            except FileNotFoundError:
                return []
            events = []
            for line in lines:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if since_turn and obj.get("turn", 0) < since_turn:
                    continue
                events.append(obj)
            if limit and len(events) > limit:
                events = events[-limit:]
            return events

    def stats(self) -> dict:
        """Return basic stats about the log."""
        with self._lock:
            try:
                size = self._path.stat().st_size
            except Exception:
                size = 0
            try:
                archive_size = self._archive.stat().st_size
            except Exception:
                archive_size = 0
            return {
                "session_id": self.session_id,
                "log_path": str(self._path),
                "archive_path": str(self._archive),
                "live_size_bytes": size,
                "archive_size_bytes": archive_size,
                "event_count": self._event_count,
                "current_turn": self._current_turn,
            }


# ── Convenience module-level functions ──────────────────────────────

def get_recorder(session_id: str) -> SessionLogRecorder:
    return SessionLogRecorder.get(session_id)


def drop_recorder(session_id: str) -> None:
    SessionLogRecorder.drop(session_id)
