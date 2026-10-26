"""Shared migration gate for legacy Python state writers."""

from __future__ import annotations

import os


class PythonWritersFrozen(RuntimeError):
    """A frozen Python compatibility writer refused to write."""


def writers_frozen() -> bool:
    """Return whether legacy Python disk writers are frozen."""
    return os.environ.get("HAKUS_FREEZE_PYTHON_WRITERS", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def assert_writers_open(operation: str, detail: str = "") -> None:
    """Raise the shared freeze error when a compatibility write is blocked."""
    if writers_frozen():
        suffix = f"; {detail}" if detail else ""
        raise PythonWritersFrozen(
            f"{operation} refused: Python compatibility writers are frozen "
            f"(HAKUS_FREEZE_PYTHON_WRITERS){suffix}"
        )
