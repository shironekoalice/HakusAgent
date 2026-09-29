"""Thread-as-tool suite for internal thread operations.

This module registers an MCP server exposing ``create_thread`` / ``fork_thread`` /
``send_message_to_thread`` / ``handoff_thread`` so the agent can
orchestrate sub-conversations as first-class objects.

Tools in this module let HakusAI's agent do the same:

  - ``create_thread``           — spawn a child session and run a task in it
  - ``fork_thread``             — copy a session's history into a new branch
  - ``send_message_to_thread``  — continue an existing (child) session
  - ``handoff_thread``          — hand the current task context to another thread

Sessions created here get ``origin`` = ``agent`` / ``fork`` and
``parent_id`` pointing at the caller's session (session tree support,
schema v2). The actual agent execution is delegated to a *runner*
callback installed by the sidecar (``src/hakusai_server/agent_bridge``)
— this module stays sidecar-free so the CLI/TUI can install its own
runner (or none, in which case the tools return a graceful error).
"""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any, Awaitable, Callable, Dict, Optional

from ..base import Tool

# Runner signature: async (action, payload) -> dict
Runner = Callable[[str, Dict[str, Any]], Awaitable[Dict[str, Any]]]

_runner: Optional[Runner] = None

# The session the current turn belongs to. Set by the sidecar's
# run_turn_stream via set_thread_session() so the tools know which
# session is the parent without extra plumbing through ToolExecutor.
_current_session: ContextVar[str] = ContextVar("hakus_thread_session", default="")

_TOOL_CATEGORY = "threads"


def set_runner(fn: Runner) -> None:
    """Install the thread-execution runner (done by agent_bridge)."""
    global _runner
    _runner = fn


def set_thread_session(session_id: str):
    """Bind the current turn's session id. Returns a token for reset()."""
    return _current_session.set(session_id)


def reset_thread_session(token) -> None:
    _current_session.reset(token)


def _parent_session() -> str:
    return _current_session.get()


async def _arun(action: str, payload: Dict[str, Any]) -> str:
    if _runner is None:
        return (
            "Error: thread tools are not available in this runtime "
            "(no runner installed). Use the desktop sidecar."
        )
    parent = _parent_session()
    if not parent:
        return "Error: no parent session context. Thread tools require a session."
    payload = {**payload, "parent_session_id": parent}
    import json as _json

    result = await _runner(action, payload)
    return _json.dumps(result, ensure_ascii=False)


class CreateThread(Tool):
    name = "create_thread"
    description = (
        "Spawn a new child conversation (thread) and run a task in it. "
        "Use this to delegate a self-contained subtask (research, a fix in "
        "another area, a long analysis) without polluting the current "
        "conversation. Returns the child session id and the task's final "
        "assistant response."
    )
    parameters_schema: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the new thread (shown in the sidebar).",
            },
            "task": {
                "type": "string",
                "description": "The complete task/prompt to run in the new thread.",
            },
        },
        "required": ["title", "task"],
    }
    is_concurrency_safe = False
    is_dangerous = False
    category: str = _TOOL_CATEGORY
    tags: list = []

    async def execute(self, title: str = "", task: str = "", **kwargs) -> str:
        if not task:
            return "Error: task is required."
        return await _arun("create", {"title": title or task[:40], "task": task})


class ForkThread(Tool):
    name = "fork_thread"
    description = (
        "Fork the current conversation (or a given session) into a new "
        "branch: the full message history is copied to a new session so an "
        "alternative approach can be tried without touching the original. "
        "Optionally continue the fork with a prompt."
    )
    parameters_schema: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "session_id": {
                "type": "string",
                "description": "Session to fork. Defaults to the current session.",
            },
            "title": {"type": "string", "description": "Title for the fork."},
            "prompt": {
                "type": "string",
                "description": "Optional prompt to run in the fork right after copying.",
            },
        },
        "required": [],
    }
    is_concurrency_safe = False
    is_dangerous = False
    category: str = _TOOL_CATEGORY
    tags: list = []

    async def execute(self, session_id: str = "", title: str = "",
                      prompt: str = "", **kwargs) -> str:
        return await _arun("fork", {
            "session_id": session_id, "title": title, "prompt": prompt,
        })


class SendMessageToThread(Tool):
    name = "send_message_to_thread"
    description = (
        "Send a follow-up message to an existing thread (e.g. one created "
        "by create_thread) and return its reply. Use for iterative "
        "collaboration with a child conversation."
    )
    parameters_schema: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "session_id": {
                "type": "string",
                "description": "Target thread's session id.",
            },
            "message": {"type": "string", "description": "Message to send."},
        },
        "required": ["session_id", "message"],
    }
    is_concurrency_safe = False
    is_dangerous = False
    category: str = _TOOL_CATEGORY
    tags: list = []

    async def execute(self, session_id: str = "", message: str = "", **kwargs) -> str:
        if not session_id or not message:
            return "Error: session_id and message are required."
        return await _arun("send", {"session_id": session_id, "message": message})


class HandoffThread(Tool):
    name = "handoff_thread"
    description = (
        "Hand off the current task to another thread: the target thread "
        "receives the message and takes over execution. Use when a "
        "different context (e.g. a specialized child thread) should "
        "continue the work."
    )
    parameters_schema: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "session_id": {
                "type": "string",
                "description": "Thread that will take over.",
            },
            "message": {
                "type": "string",
                "description": "Handoff message describing what to continue.",
            },
        },
        "required": ["session_id", "message"],
    }
    is_concurrency_safe = False
    is_dangerous = False
    category: str = _TOOL_CATEGORY
    tags: list = []

    async def execute(self, session_id: str = "", message: str = "", **kwargs) -> str:
        if not session_id or not message:
            return "Error: session_id and message are required."
        return await _arun("handoff", {"session_id": session_id, "message": message})
