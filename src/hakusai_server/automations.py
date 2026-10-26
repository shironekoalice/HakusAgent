"""Automation scheduler — Codex-style scheduled agent turns.

A tiny asyncio-native scheduler (no APScheduler dependency). Every
30s it scans ``session_store.due_automations(now_ms)`` for enabled
automations whose ``next_run_at`` has passed, then runs each due
automation's prompt through :func:`agent_bridge.run_turn_collect` in
a dedicated ``origin='automation'`` child session, recording the
outcome in the ``automation_runs`` table.

Schedule format (kept deliberately simple — a full cron parser is
overkill for v1):
  - ``"30m"`` / ``"1h"`` / ``"2d"``  → interval from each run
  - ``"@hourly"`` / ``"@daily"``     → aliases for 1h / 1d
  - ``"@startup"``                   → never schedules (manual runs only)

Lifecycle: started from FastAPI lifespan (``start_scheduler()``),
stopped on shutdown (``stop_scheduler()``). Pause/resume is just the
``enabled`` flag; toggling recomputes ``next_run_at`` from now.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Dict, Optional

from . import session_store

logger = logging.getLogger("hakus.automations")

SCAN_INTERVAL_S = 30

_UNIT_S = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_interval_seconds(schedule: str) -> Optional[int]:
    """Parse a schedule string into a repeat interval in seconds.

    Returns None for non-repeating schedules ("@startup", garbage).
    """
    s = (schedule or "").strip().lower()
    if not s:
        return None
    if s == "@hourly":
        return 3600
    if s == "@daily":
        return 86400
    if s in ("@startup", "@manual", "@none"):
        return None
    # "<N><unit>" e.g. 30m / 1h / 2d
    if len(s) >= 2 and s[-1] in _UNIT_S:
        try:
            n = int(s[:-1])
        except ValueError:
            return None
        if n > 0:
            return n * _UNIT_S[s[-1]]
    return None


def compute_next_run(schedule: str, from_ms: Optional[int] = None) -> Optional[int]:
    """Compute the next run timestamp (ms since epoch), or None."""
    interval = parse_interval_seconds(schedule)
    if interval is None:
        return None
    base = from_ms if from_ms is not None else int(time.time() * 1000)
    return base + interval * 1000


def validate_schedule(schedule: str) -> bool:
    """A schedule is valid if it's either repeating or an explicit alias."""
    s = (schedule or "").strip().lower()
    if not s:
        return False
    if s in ("@startup", "@manual", "@none", "@hourly", "@daily"):
        return True
    return parse_interval_seconds(s) is not None


class AutomationScheduler:
    """Asyncio task loop that fires due automations."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stopping = asyncio.Event()
        self._running: set[str] = set()  # automation ids currently executing

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        if session_store.writers_frozen():
            logger.info(
                "automation scheduler disabled: Python compatibility writers are frozen"
            )
            self._task = None
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="automation-scheduler")
        logger.info("automation scheduler started (scan every %ss)", SCAN_INTERVAL_S)

    async def stop(self) -> None:
        self._stopping.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None
        logger.info("automation scheduler stopped")

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self._scan_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("automation scan failed")
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=SCAN_INTERVAL_S
                )
            except asyncio.TimeoutError:
                pass

    async def _scan_once(self) -> None:
        if session_store.writers_frozen():
            return
        now_ms = int(time.time() * 1000)
        for auto in session_store.due_automations(now_ms):
            aid = auto["id"]
            if aid in self._running:
                continue
            self._running.add(aid)
            # Schedule the next occurrence first so a long run doesn't
            # starve subsequent scans (no drift accumulation).
            nxt = compute_next_run(auto["schedule"], now_ms)
            session_store.update_automation(aid, next_run_at=nxt)
            asyncio.create_task(self._run_automation(auto), name=f"auto-{aid}")

    async def _run_automation(self, auto: Dict[str, Any]) -> None:
        if session_store.writers_frozen():
            logger.info(
                "automation %s skipped: Python compatibility writers are frozen",
                auto.get("id", "unknown"),
            )
            return
        aid = auto["id"]
        run_id = f"run_{uuid.uuid4().hex[:12]}"
        started_ms = int(time.time() * 1000)
        session_id: Optional[str] = None
        try:
            # Lazy import avoids a circular dep at module load.
            from . import agent_bridge

            session_id = f"sess_{uuid.uuid4().hex[:16]}"
            session_store.create_session(
                session_id,
                origin="automation",
                title=f"⏰ {auto['name']}",
            )
            session_store.create_automation_run(
                run_id, aid, session_id=session_id, started_at=started_ms
            )
            result = await agent_bridge.run_turn_collect(
                auto["prompt"], session_id=session_id
            )
            session_store.finish_automation_run(run_id, status="completed")
            reply = result.get("content") or ""
            logger.info(
                "automation %s run ok (session %s, %d chars reply)",
                aid, session_id, len(reply),
            )
        except Exception as e:
            session_store.finish_automation_run(
                run_id, status="failed", error=str(e)[:500]
            )
            logger.exception("automation %s run failed", aid)
        finally:
            self._running.discard(aid)


_scheduler = AutomationScheduler()


def get_scheduler() -> AutomationScheduler:
    return _scheduler
