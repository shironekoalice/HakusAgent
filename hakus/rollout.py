"""RolloutRecorder — JSONL session recording and resume (aligned with Codex CLI).

Codex CLI's Rollout system provides:
  1. **JSONL recording**: Every turn, tool call, and event is recorded to JSONL
  2. **Resume**: A recorded session can be resumed from any point
  3. **Replay**: Recorded sessions can be replayed for debugging/audit
  4. **Diff tracking**: File changes are tracked as unified diffs

This implementation records:
  - Turn start/end events with timestamps
  - LLM requests and responses (input/output tokens)
  - Tool calls and results
  - Permission decisions
  - File changes (before/after diffs)
  - Compression events
  - Memory extractions

File format:
  Each line is a JSON object with:
    - "type": event type (turn_start, llm_call, tool_call, turn_end, etc.)
    - "ts": ISO timestamp
    - "session_id": session identifier
    - "turn": turn number
    - ...: event-specific fields
"""
from __future__ import annotations

import difflib
import json
import os
import time
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Iterator

from utils.logger import get_logger
from .compat_writers import writers_frozen

logger = get_logger(__name__)


@dataclass
class RolloutEvent:
    """A single recorded event."""
    type: str
    ts: str = ""
    session_id: str = ""
    turn: int = 0
    data: Dict[str, Any] = field(default_factory=dict)

    def to_jsonl(self) -> str:
        """Serialize to a JSONL line."""
        d = {
            "type": self.type,
            "ts": self.ts or datetime.now(timezone.utc).isoformat(),
            "session_id": self.session_id,
            "turn": self.turn,
            **self.data,
        }
        return json.dumps(d, ensure_ascii=False, default=str)


@dataclass
class FileChange:
    """A file change recorded during the session."""
    path: str
    change_type: str  # "create", "modify", "delete"
    diff: str = ""
    before_hash: str = ""
    after_hash: str = ""


class RolloutRecorder:
    """JSONL session recorder for audit, debug, and resume.

    Usage::
        recorder = RolloutRecorder(session_id="abc123", project_root="/project")
        recorder.start()

        # Record events (called by agent.py main loop)
        recorder.record_turn_start(user_message="Fix the bug")
        recorder.record_llm_call(model="gpt-4", input_tokens=500, output_tokens=200)
        recorder.record_tool_call(name="read_file", args={"path": "src/main.py"}, result="...")
        recorder.record_turn_end(response="I fixed the bug by...")

        # Stop and flush
        recorder.stop()

        # Resume from a recorded session
        events = RolloutRecorder.load_events("rollout_abc123.jsonl")
    """

    def __init__(
        self,
        session_id: str,
        project_root: str = "",
        rollout_dir: Optional[str] = None,
        record_file_changes: bool = True,
        max_file_size_mb: int = 50,
    ):
        self._session_id = session_id
        self._project_root = project_root
        self._record_file_changes = record_file_changes
        self._max_file_size = max_file_size_mb * 1024 * 1024

        # Rollout file
        if rollout_dir is None:
            rollout_dir = os.path.join(project_root or ".", ".hakus", "rollouts")
        self._rollout_dir = rollout_dir
        if not writers_frozen():
            os.makedirs(rollout_dir, exist_ok=True)

        self._filepath = os.path.join(
            rollout_dir, f"rollout_{session_id}.jsonl"
        )

        self._turn = 0
        self._started = False
        self._file: Optional[Any] = None
        self._lock = threading.RLock()  # RLock: _write_event called inside start() which holds the lock
        self._events_count = 0

        # Track file states for diff computation
        self._file_states: Dict[str, str] = {}  # path → content hash

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start recording."""
        if writers_frozen():
            return
        with self._lock:
            os.makedirs(self._rollout_dir, exist_ok=True)
            self._file = open(self._filepath, "a", encoding="utf-8")
            self._started = True
            self._write_event(RolloutEvent(
                type="session_start",
                data={"project_root": self._project_root},
            ))
        logger.info(f"Rollout recording started: {self._filepath}")

    def stop(self) -> None:
        """Stop recording and flush to disk."""
        with self._lock:
            if not self._started:
                return
            self._write_event(RolloutEvent(type="session_end"))
            if self._file:
                self._file.close()
                self._file = None
            self._started = False
        logger.info(f"Rollout recording stopped: {self._filepath} ({self._events_count} events)")

    @property
    def filepath(self) -> str:
        return self._filepath

    @property
    def is_recording(self) -> bool:
        return self._started

    # ------------------------------------------------------------------
    # Turn events
    # ------------------------------------------------------------------

    def record_turn_start(self, user_message: str = "", **kwargs: Any) -> None:
        """Record the start of a turn."""
        self._turn += 1
        self._write_event(RolloutEvent(
            type="turn_start",
            turn=self._turn,
            data={"user_message": user_message[:500], **kwargs},
        ))

    def record_turn_end(
        self,
        response: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        tool_calls_count: int = 0,
        duration_ms: int = 0,
        compressed: bool = False,
        **kwargs: Any,
    ) -> None:
        """Record the end of a turn."""
        self._write_event(RolloutEvent(
            type="turn_end",
            turn=self._turn,
            data={
                "response_length": len(response),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "tool_calls_count": tool_calls_count,
                "duration_ms": duration_ms,
                "compressed": compressed,
                **kwargs,
            },
        ))

    def record_turn_failed(self, error: str = "", code: str = "unknown") -> None:
        """Record a turn failure."""
        self._write_event(RolloutEvent(
            type="turn_failed",
            turn=self._turn,
            data={"error": error[:500], "code": code},
        ))

    # ------------------------------------------------------------------
    # LLM events
    # ------------------------------------------------------------------

    def record_llm_call(
        self,
        model: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        duration_ms: int = 0,
        cached: bool = False,
        **kwargs: Any,
    ) -> None:
        """Record an LLM API call."""
        self._write_event(RolloutEvent(
            type="llm_call",
            turn=self._turn,
            data={
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "duration_ms": duration_ms,
                "cached": cached,
                **kwargs,
            },
        ))

    # ------------------------------------------------------------------
    # Tool events
    # ------------------------------------------------------------------

    def record_tool_call(
        self,
        name: str,
        args: Optional[Dict[str, Any]] = None,
        result: str = "",
        success: bool = True,
        duration_ms: int = 0,
        call_id: str = "",
    ) -> None:
        """Record a tool call and result."""
        # Truncate long results
        result_str = (result or "")[:2000]
        self._write_event(RolloutEvent(
            type="tool_call",
            turn=self._turn,
            data={
                "name": name,
                "call_id": call_id,
                "args_keys": list(args.keys()) if args else [],
                "success": success,
                "duration_ms": duration_ms,
                "result_length": len(result or ""),
                "result_preview": result_str[:200] if success else result_str,
            },
        ))

        # Track file changes
        if self._record_file_changes and name in ("write_file", "edit_file", "read_file"):
            self._track_file_change(name, args or {}, result)

    # ------------------------------------------------------------------
    # Permission events
    # ------------------------------------------------------------------

    def record_permission_decision(
        self,
        tool_name: str,
        allowed: bool,
        reason: str = "",
        mode: str = "",
    ) -> None:
        """Record a permission decision."""
        self._write_event(RolloutEvent(
            type="permission",
            turn=self._turn,
            data={
                "tool_name": tool_name,
                "allowed": allowed,
                "reason": reason[:200],
                "mode": mode,
            },
        ))

    # ------------------------------------------------------------------
    # Compression events
    # ------------------------------------------------------------------

    def record_compression(
        self,
        stage: str = "",
        before_tokens: int = 0,
        after_tokens: int = 0,
        before_messages: int = 0,
        after_messages: int = 0,
    ) -> None:
        """Record a compression event."""
        self._write_event(RolloutEvent(
            type="compression",
            turn=self._turn,
            data={
                "stage": stage,
                "before_tokens": before_tokens,
                "after_tokens": after_tokens,
                "before_messages": before_messages,
                "after_messages": after_messages,
                "savings_pct": f"{(1 - after_tokens / max(before_tokens, 1)) * 100:.1f}%",
            },
        ))

    # ------------------------------------------------------------------
    # Memory events
    # ------------------------------------------------------------------

    def record_memory_extraction(
        self,
        memory_ids: Optional[List[str]] = None,
        content_preview: str = "",
    ) -> None:
        """Record memory extraction events."""
        self._write_event(RolloutEvent(
            type="memory_extraction",
            turn=self._turn,
            data={
                "count": len(memory_ids or []),
                "preview": content_preview[:200],
            },
        ))

    # ------------------------------------------------------------------
    # File change tracking
    # ------------------------------------------------------------------

    def record_file_change(self, change: FileChange) -> None:
        """Record a file change with diff."""
        self._write_event(RolloutEvent(
            type="file_change",
            turn=self._turn,
            data={
                "path": change.path,
                "change_type": change.change_type,
                "diff": change.diff[:5000],
                "before_hash3": change.before_hash[:8],
                "after3": change.after_hash[:8],
            },
        ))

    def _track_file_change(self, tool_name: str, args: Dict[str, Any], result: str) -> None:
        """Track file changes from tool calls."""
        path = args.get("file_path") or args.get("path") or args.get("directory", "")
        if not path:
            return

        import hashlib
        current_hash = hashlib.sha256(result.encode("utf-8")).hexdigest()[:16] if result else ""
        previous_hash = self._file_states.get(path, "")

        if tool_name == "write_file":
            change_type = "modify" if previous_hash else "create"
        elif tool_name == "edit_file":
            change_type = "modify"
        elif tool_name == "read_file":
            self._file_states[path] = current_hash
            return  # Read doesn't change files
        else:
            return

        self._file_states[path] = current_hash

        # Compute diff if possible
        diff = ""
        if tool_name == "edit_file" and "old_string" in args and "new_string" in args:
            old = args.get("old_string", "")
            new = args.get("new_string", "")
            diff_lines = difflib.unified_diff(
                old.splitlines(keepends=True),
                new.splitlines(keepends=True),
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
            )
            diff = "".join(diff_lines)

        self.record_file_change(FileChange(
            path=path,
            change_type=change_type,
            diff=diff,
            before_hash=previous_hash,
            after_hash=current_hash,
        ))

    # ------------------------------------------------------------------
    # Generic event
    # ------------------------------------------------------------------

    def record_custom(self, event_type: str, **data: Any) -> None:
        """Record a custom event."""
        self._write_event(RolloutEvent(
            type=event_type,
            turn=self._turn,
            data=data,
        ))

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _write_event(self, event: RolloutEvent) -> None:
        """Write an event to the JSONL file."""
        if writers_frozen():
            return
        if not self._session_id:
            event.session_id = self._session_id

        with self._lock:
            if not self._started or not self._file:
                return

            try:
                line = event.to_jsonl()
                self._file.write(line + "\n")
                self._file.flush()
                self._events_count += 1

                # Check file size limit
                if self._file.tell() > self._max_file_size:
                    logger.warning("Rollout file size limit reached, stopping recording")
                    self._file.close()
                    self._file = None
                    self._started = False

            except Exception as e:
                logger.warning(f"Failed to write rollout event: {e}")

    # ------------------------------------------------------------------
    # Static: Load and replay
    # ------------------------------------------------------------------

    @staticmethod
    def load_events(filepath: str) -> List[Dict[str, Any]]:
        """Load all events from a JSONL rollout file."""
        events = []
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            logger.warning(f"Rollout file not found: {filepath}")
        return events

    @staticmethod
    def iter_events(filepath: str) -> Iterator[Dict[str, Any]]:
        """Iterate over events in a JSONL rollout file (memory-efficient)."""
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            pass

    @staticmethod
    def get_session_summary(filepath: str) -> Dict[str, Any]:
        """Get a summary of a recorded session."""
        events = RolloutRecorder.load_events(filepath)
        if not events:
            return {"error": "No events found"}

        summary = {
            "filepath": filepath,
            "total_events": len(events),
            "session_id": events[0].get("session_id", ""),
            "start_time": events[0].get("ts", ""),
            "end_time": events[-1].get("ts", "") if len(events) > 1 else "",
            "turns": 0,
            "tool_calls": 0,
            "llm_calls": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "file_changes": 0,
            "compressions": 0,
        }

        for event in events:
            event_type = event.get("type", "")
            if event_type == "turn_start":
                summary["turns"] += 1
            elif event_type == "tool_call":
                summary["tool_calls"] += 1
            elif event_type == "llm_call":
                summary["llm_calls"] += 1
                summary["total_input_tokens"] += event.get("input_tokens", 0)
                summary["total_output_tokens"] += event.get("output_tokens", 0)
            elif event_type == "file_change":
                summary["file_changes"] += 1
            elif event_type == "compression":
                summary["compressions"] += 1

        return summary

    @staticmethod
    def find_rollouts(rollout_dir: str) -> List[Dict[str, Any]]:
        """Find all rollout files in a directory."""
        rollouts = []
        rollout_path = Path(rollout_dir)
        if not rollout_path.exists():
            return rollouts

        for f in sorted(rollout_path.glob("rollout_*.jsonl"), reverse=True):
            summary = RolloutRecorder.get_session_summary(str(f))
            summary["filename"] = f.name
            rollouts.append(summary)

        return rollouts
