import asyncio
import json
import os
import re
import time
import threading
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple

from utils.config import BASE_CONFIG
from utils.logger import get_logger
from utils.turn_debug import get_debug_logger as _get_dbg, EVT_STEP_RECORD
from .context import ContextManager, CompressionLevel
from .permission import PermissionManager, PermissionMode
from .permissions.checker import PermissionChecker
from .permissions.modes import PermissionMode as NewPermissionMode
from .checkpoint import CheckpointManager
from .tools import IntentRouter, Tool, ToolRegistry
from .tools.base import StepState, AgentStep, ToolCall as BaseToolCall, ToolResult as BaseToolResult
from .tools.executor import ToolExecutor
from .complexity_scorer import TaskComplexityScorer
from .harness import TrajectoryRecorder, HarnessGuard, HarnessEvaluator, create_harness_components

from .models.client_factory import create_client_from_config
from .models.base_client import BaseLLMClient, LLMProvider, LLMMessage, LLMResponse
from .models.legacy_provider_adapter import LegacyProviderAdapter, redact_provider_diagnostic
try:
    from .memory_vector import MemoryManager
except ImportError:
    MemoryManager = None

# Enhanced modules (soft-stop, doom loop detection, context monitoring)
from .improved_loop import DoomLoopDetector, ContextMonitor, SOFT_STOP_PROMPT, DOOM_LOOP_PROMPT
from .timeout import SSEChunkTimeout, RetryManager, TimeoutConfig
from .recovery import RecoveryManager, SessionSnapshot, ToolState, recovery_manager

logger = get_logger(__name__)
# 专用 logger 用于 LLM 调用日志 (路由到 llm.log)
llm_logger = get_logger("haku.llm.call")
# 专用 logger 用于工具执行日志 (路由到 tools.log)
tool_logger = get_logger("haku.tools.subagent")

# #region debug-point helper
_DEBUG_ENV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".dbg", "agent-stalls-after-tools.env",
)
_DEBUG_URL = "http://127.0.0.1:7777/event"
_DEBUG_SESSION = "agent-stalls-after-tools"


def _debug_log(hypothesis_id: str, location: str, msg: str, data: Optional[Dict[str, Any]] = None) -> None:
    try:
        url = _DEBUG_URL
        session = _DEBUG_SESSION
        try:
            with open(_DEBUG_ENV_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("DEBUG_SERVER_URL="):
                        url = line.split("=", 1)[1].strip()
                    elif line.startswith("DEBUG_SESSION_ID="):
                        session = line.split("=", 1)[1].strip()
        except Exception:
            pass
        payload = {
            "sessionId": session,
            "runId": "pre",
            "hypothesisId": hypothesis_id,
            "location": location,
            "msg": f"[DEBUG] {msg}",
            "data": data or {},
            "ts": time.time(),
        }
        body = json.dumps(payload).encode("utf-8")
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=1).read()
        except Exception:
            pass
        try:
            local_log = os.path.join(
                os.path.dirname(_DEBUG_ENV_PATH),
                f"trae-debug-log-{session}.ndjson.local",
            )
            with open(local_log, "a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception:
            pass
    except Exception:
        pass


# #endregion

_PLAN_MODE_BLOCKED_TOOLS = frozenset({
    "Write", "Edit", "MultiEdit", "Bash", "BashOutput", "PowerShell", "GitCommit",
    "write_file", "write", "edit_file", "edit", "bash", "computer_control",
})


# ============================================================
# Op queue interrupt helper (P0.4)
# ============================================================
# Centralized helper used by run_turn / _do_streaming_turn_events /
# _non_streaming_turn_events. Replaces three identical ``_check_interrupt``
# closures that all did the same op_receiver.poll + InterruptOp dispatch.
#


async def _check_op_interrupt(
    op_receiver: "Optional[asyncio.Queue]",
    cancelled_flag: bool,
    interrupt_reason: "Optional[str]",
) -> "Optional[str]":
    """Poll the op_receiver (and/or the agent's interrupt state) for an interrupt.

    Returns the interrupt reason string if one is pending, else None.

    Args:
        op_receiver: The asyncio.Queue that the frontend pushes
            :class:`Op` instances into. If None, the function falls back
            to ``cancelled_flag`` + ``interrupt_reason`` (legacy non-TUI
            callers that still set ``self._cancelled = True``).
        cancelled_flag: The legacy bool flag (self._cancelled). Only
            consulted when op_receiver is None.
        interrupt_reason: The current ``self._interrupt_reason`` value.
            Only consulted when op_receiver is None.
    """
    from .protocol import InterruptOp  # local import — break circular dep
    if op_receiver is None:
        if cancelled_flag:
            return interrupt_reason or "user_cancelled"
        return None
    try:
        op = op_receiver.get_nowait()
    except asyncio.QueueEmpty:
        return None
    if isinstance(op, InterruptOp):
        return op.reason
    # Not for us — put it back (best-effort; might fail if full)
    try:
        op_receiver.put_nowait(op)
    except asyncio.QueueFull:
        logger.warning("op_receiver full when requeueing op")
    return None


# ============================================================
# DSML (DeepSeek Markup Language) tool-call handling
# ============================================================
# DeepSeek models sometimes emit tool calls as raw text in their native
# DSML XML format instead of using the OpenAI `tools` API. Examples:
#   <｜｜DSML｜｜tool_calls>
#   <｜｜DSML｜｜invoke name="Tree">
#   <｜｜DSML｜｜parameter name="dir_path" string="true">...</｜｜DSML｜｜parameter>
#   </｜｜DSML｜｜invoke>
#   </｜｜DSML｜｜tool_calls>
# We must hide this leaked XML from the user and convert it into structured
# tool_calls that the agent can execute.

import re as _re

_DSML_INVOKE_RE = _re.compile(
    r'<｜｜DSML｜｜invoke\s+name=["\']([^"\']+)["\']\s*>(.*?)</｜｜DSML｜｜invoke>',
    _re.DOTALL,
)
_DSML_PARAM_RE = _re.compile(
    r'<｜｜DSML｜｜parameter\s+name=["\']([^"\']+)["\']\s+string=["\']([^"\']*)["\']\s*>(.*?)</｜｜DSML｜｜parameter>',
    _re.DOTALL,
)
_DSML_TOOL_CALLS_BLOCK_RE = _re.compile(
    r'<｜｜DSML｜｜tool_calls\s*>.*?</｜｜DSML｜｜tool_calls\s*>',
    _re.DOTALL,
)
# Any leftover DSML directive fragments (e.g. when streaming gets cut off)
_DSML_FRAGMENT_RE = _re.compile(
    r'<｜｜DSML｜｜(?:tool_calls|invoke|parameter|/invoke|/tool_calls|/parameter)[^>]*>'
)


def _parse_dsml_calls(text: str) -> Tuple[List[Dict[str, Any]], str]:
    """Parse DSML XML tool calls out of a model response.

    Returns:
        (tool_calls, leftover_text) where:
          - tool_calls is a list of {"id", "name", "arguments"} dicts
          - leftover_text is the original text with all DSML blocks removed
    """
    if not text or "DSML" not in text:
        return [], text

    tool_calls: List[Dict[str, Any]] = []
    for idx, m in enumerate(_DSML_INVOKE_RE.finditer(text)):
        name = m.group(1)
        inner = m.group(2)
        args: Dict[str, Any] = {}
        for pm in _DSML_PARAM_RE.finditer(inner):
            pname = pm.group(1)
            pstring_attr = pm.group(2)
            pval = pm.group(3)
            # If string="true" the inner text is the literal value
            if pstring_attr == "true":
                args[pname] = pval.strip()
            else:
                try:
                    args[pname] = json.loads(pval)
                except (json.JSONDecodeError, ValueError):
                    args[pname] = pval.strip()
        tool_calls.append({
            "id": f"dsml_{idx}",
            "name": name,
            "arguments": args,
        })

    leftover = _DSML_TOOL_CALLS_BLOCK_RE.sub("", text)
    leftover = _DSML_FRAGMENT_RE.sub("", leftover).rstrip()
    return tool_calls, leftover


# Track how many characters of cleaned output have been emitted so far.
# This prevents _strip_dsml_xml from re-emitting text that was already
# yielded in a previous call when a DSML block closes.
_dsml_emitted_offset = 0


def _strip_dsml_xml(delta_chunk: str, full_so_far: str) -> str:
    """Filter streamed delta to hide DSML XML as it streams through.

    The DeepSeek API may stream DSML XML character-by-character inside
    `delta.content`. We don't want those `<｜｜DSML｜｜...>` tokens reaching
    the user. The strategy: only emit text after the last fully-closed
    DSML block, suppressing anything that's still inside a partial block.

    Returns only the **incremental** new text that hasn't been emitted yet,
    to avoid duplicate output when a DSML block closes and we need to
    release previously suppressed text.
    """
    global _dsml_emitted_offset

    if not delta_chunk:
        return delta_chunk
    if "DSML" not in delta_chunk and "DSML" not in full_so_far:
        # No DSML at all — pass through the delta directly
        _dsml_emitted_offset += len(delta_chunk)
        return delta_chunk

    last_close = full_so_far.rfind("</｜｜DSML｜｜tool_calls>")
    if last_close < 0:
        # No closed block yet — check whether we are inside a partial one
        last_open = full_so_far.rfind("<｜｜DSML｜｜")
        if last_open < 0:
            # Not inside a block — pass through
            _dsml_emitted_offset += len(delta_chunk)
            return delta_chunk
        # Inside an unclosed block — suppress until the close tag appears
        return ""

    # We have at least one closed block. Emit text that comes after the close.
    cut = last_close + len("</｜｜DSML｜｜tool_calls>")
    trailing = full_so_far[cut:]
    if trailing:
        # Only emit the portion we haven't emitted yet
        if cut > _dsml_emitted_offset:
            new_text = trailing
            _dsml_emitted_offset = cut + len(trailing)
            return new_text
        else:
            _dsml_emitted_offset = cut + len(trailing)
            return ""
    return ""


def _strip_tool_directives(text: str) -> str:
    """Remove any tool-calling directives from model output (defense in depth)."""
    if not text:
        return text
    text = _DSML_TOOL_CALLS_BLOCK_RE.sub("", text)
    text = _DSML_FRAGMENT_RE.sub("", text)
    return text.strip()


async def _iter_with_timeout(async_iter, timeout: float, label: str = "stream"):
    """Async-iterate an async-iterable with a wall-clock cap.

    Why this exists: the OpenAI client returns a `Stream` object whose
    `__anext__` waits indefinitely if the underlying HTTP socket goes
    silent (this is what produced the "Tool 649s list_dir" hang the
    user reported — the model API silently stopped sending bytes mid-
    turn). `asyncio.wait_for` on a single `__anext__` would only bound
    *one* chunk, so we wrap each call in a coroutine and bound them
    individually. The cap is per-chunk, not per-stream — the previous
    chunk having arrived doesn't reset the budget. Total wait is bounded
    by `timeout * number_of_chunks`, which is the conservative safe
    bound; in practice chunks arrive faster than `timeout` so the
    effective wall-clock cap is just `timeout` (the gap between
    chunks).
    """
    if not timeout or timeout <= 0:
        async for item in async_iter:
            yield item
        return

    from utils.turn_debug import get_debug_logger as _get_dbg
    chunk_count = 0
    last_chunk_time = time.time()
    
    while True:
        try:
            item = await asyncio.wait_for(async_iter.__anext__(), timeout=timeout)
            chunk_count += 1
            current_time = time.time()
            elapsed_since_last = current_time - last_chunk_time
            last_chunk_time = current_time
            
            # Log every 10th chunk or slow chunks
            if chunk_count % 10 == 0 or elapsed_since_last > 5:
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_raw(f"\n  [STREAM] {label}: chunk #{chunk_count}, gap={elapsed_since_last:.1f}s\n")
            
        except StopAsyncIteration:
            _dbg = _get_dbg()
            if _dbg:
                _dbg.log_raw(f"\n  [STREAM] {label}: completed after {chunk_count} chunks\n")
            return
        except asyncio.TimeoutError:
            _dbg = _get_dbg()
            if _dbg:
                _dbg.log_raw(f"\n  [STREAM] {label}: TIMEOUT after {timeout}s (got {chunk_count} chunks)\n")
            logger.error(
                f"{label} 单 chunk 等待超时 ({timeout:.1f}s) — "
                "模型 API 已停止发送数据."
            )
            raise
        yield item


# _MODEL_MAP 已迁移到 hakus/models/client_factory.py
# 新代码使用 create_client_from_config(model_type) 替代


@dataclass
class ToolCallResult:
    tool_name: str
    arguments: Dict[str, Any]
    result: str
    success: bool = True
    execution_time: float = 0.0
    error: Optional[str] = None


@dataclass
class ReflectionResult:
    should_continue: bool = False
    feedback: str = ""
    reason: str = ""


@dataclass
class AgentResponse:
    content: str = ""
    tool_calls: List[ToolCallResult] = field(default_factory=list)
    iterations: int = 0
    total_time: float = 0.0
    compressed: bool = False
    checkpoint_id: str = ""
    # Token accounting. Populated from the OpenAI `usage` block on the
    # last stream chunk (requires `stream_options.include_usage=true`).
    # Streaming sinks and the orchestrator both rely on this to keep
    # the status-bar counter in sync.
    input_tokens: int = 0
    output_tokens: int = 0


class SubAgent:
    def __init__(self, parent: "AgentCore", task: str, max_depth: int = 15,
                 allowed_tools: Optional[List[str]] = None,
                 llm_timeout: float = 120.0):
        self._parent = parent
        self._task = task
        self._max_depth = max_depth
        self._allowed_tools = allowed_tools
        self._llm_timeout = llm_timeout
        self._context = ContextManager(
            max_tokens=parent._context.max_tokens,
            reserved_output_tokens=parent._context.reserved_output_tokens,
            working_dir=parent._context.working_dir,
        )
        self._context.set_static_system_prompt(
            f"You are a sub-agent handling a specific task. Focus only on: {task}"
        )
        self._tool_registry = ToolRegistry()
        self._tool_registry.register_builtin()
        self._tool_executor = ToolExecutor(self._tool_registry)
        self._router = IntentRouter()
        self._permission = PermissionManager(
            mode=parent._permission.mode,
            confirm_callback=parent._permission._confirm_callback,
        )
        self._result: Optional[str] = None
        self._completed = False

    @property
    def completed(self) -> bool:
        return self._completed

    @property
    def result(self) -> Optional[str]:
        return self._result

    async def run(self) -> str:
        self._context.add_message("user", self._task)
        for iteration in range(self._max_depth):
            messages = self._context.build_messages()
            response, tool_calls = await self._parent._call_model(messages, timeout=self._llm_timeout)

            # Detect LLM-level errors that were returned as content strings.
            # Without this, the sub-agent would "complete successfully" with
            # content like "[Error: 模型调用失败: RateLimitError]", causing
            # Orchestrator to waste tests/fixes on an error message.
            if isinstance(response, str) and response.lstrip().startswith("[Error:"):
                raise RuntimeError(
                    f"Sub-agent LLM call returned an error: {response}"
                )

            if not tool_calls:
                self._result = response
                self._completed = True
                return response

            # --- 1. Store assistant message WITH tool_calls ---
            # Critical: the OpenAI API requires the assistant message to
            # carry the tool_calls field so that subsequent tool messages
            # can reference them by tool_call_id.  Without this the model
            # sees orphaned tool results and enters an infinite loop.
            api_tool_calls: List[Dict[str, Any]] = []
            for tc in tool_calls:
                api_tool_calls.append({
                    "id": tc.get("id", f"call_{iteration}_{len(api_tool_calls)}"),
                    "type": "function",
                    "function": {
                        "name": tc.get("name", ""),
                        "arguments": json.dumps(tc.get("arguments", {}), ensure_ascii=False),
                    },
                })
            self._context.add_assistant_with_tool_calls(response, api_tool_calls)

            # --- 2. Execute tools and store results with tool_call_id ---
            for tc, api_tc in zip(tool_calls, api_tool_calls):
                tool_name = tc.get("name", "")
                args = tc.get("arguments", {})
                if self._allowed_tools and tool_name not in self._allowed_tools:
                    self._context.add_tool_result(
                        tool_name, f"Tool '{tool_name}' not available",
                        tool_call_id=api_tc["id"],
                    )
                    continue
                tool = self._tool_registry.get(tool_name)
                if not tool:
                    self._context.add_tool_result(
                        tool_name, f"Unknown tool: {tool_name}",
                        tool_call_id=api_tc["id"],
                    )
                    continue
                # Inject working_dir for tools that need it
                args = self._inject_working_dir(tool_name, args)
                _sub_tool_start = time.time()
                tool_logger.info(
                    f"[tool.start] agent=sub name={tool_name} "
                    f"args_keys={list(args.keys())}"
                )
                try:
                    result = await tool.execute(**args)
                    _sub_tool_elapsed = int((time.time() - _sub_tool_start) * 1000)
                    tool_logger.info(
                        f"[tool.done] agent=sub name={tool_name} "
                        f"success=True elapsed_ms={_sub_tool_elapsed} "
                        f"result_len={len(str(result or ''))}"
                    )
                    self._context.add_tool_result(
                        tool_name, result,
                        tool_call_id=api_tc["id"],
                    )
                except Exception as e:
                    _sub_tool_elapsed = int((time.time() - _sub_tool_start) * 1000)
                    tool_logger.error(
                        f"[tool.error] agent=sub name={tool_name} "
                        f"error={type(e).__name__} elapsed_ms={_sub_tool_elapsed}: {e}"
                    )
                    self._context.add_tool_result(
                        tool_name, f"Error: {e}",
                        tool_call_id=api_tc["id"],
                    )
        self._result = "Sub-agent reached maximum iterations"
        self._completed = True
        return self._result

    def _inject_working_dir(self, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """Inject working_dir into tool args so files/commands use the workspace."""
        wd = self._context.working_dir
        if not wd:
            return args
        args = dict(args)  # don't mutate original
        # Match both snake_case and PascalCase tool names
        tool_lower = tool_name.lower()
        if tool_lower == "bash" and "cwd" not in args:
            args["cwd"] = wd
        elif tool_lower in ("write_file", "read_file", "edit_file", "write", "read", "edit"):
            path = args.get("path", "")
            if path and not os.path.isabs(path):
                args["path"] = os.path.join(wd, path)
        return args


class AgentCore:
    def __init__(self, model_type: Optional[str] = None,
                 permission_mode: PermissionMode = PermissionMode.ASK,
                 confirm_callback: Optional[Callable[[str, str], bool]] = None,
                 max_iterations: int = 100, max_context_tokens: int = 200000,
                 working_dir: Optional[str] = None, session_id: Optional[str] = None,
                 llm_timeout: float = 180.0,
                 tool_timeout: float = 120.0,
                 follow_up_timeout: float = 180.0,
                 allow_provider_fallback: bool = True):
        self._model_type = model_type or BASE_CONFIG.get("DEFAULT_MODEL", "deepseek")
        # CLI callers historically allowed a best-effort provider fallback.
        # Compatibility bridges pass False so an explicit provider failure is
        # visible to the caller instead of changing the selected route.
        self._allow_provider_fallback = allow_provider_fallback
        self._provider_adapter: Optional[LegacyProviderAdapter] = None
        self._model: Any = None
        self._llm_client: Optional[BaseLLMClient] = None
        self._max_iterations = max_iterations
        self._session_id = session_id or f"session_{int(time.time())}"
        # Per-call timeouts. These guard against hung network sockets (e.g.
        # DeepSeek's API silently stalling mid-stream) so the user is never
        # stranded with a "Tool 649s" phase and a dead input box.
        self._llm_timeout = float(llm_timeout)
        self._tool_timeout = float(tool_timeout)
        self._follow_up_timeout = float(follow_up_timeout)
        self._context = ContextManager(max_tokens=max_context_tokens, working_dir=working_dir)
        self._tool_registry = ToolRegistry()
        self._tool_registry.register_builtin()
        self._tool_executor = ToolExecutor(self._tool_registry)

        # Mode → allowed-tools policy (DeepSeek-Harness-style preset).
        # `None` means "no mode set yet, all tools available" (backward
        # compat for direct-API users who never specify a mode). Once a
        # mode is set via `set_run_mode()`, the schema builder and the
        # tool-call dispatcher both enforce the whitelist.
        self._run_mode: Optional[str] = None

        # System-level routing: catches mis-routed tool calls (e.g. model
        # calls `web_search` for a local CSV file) before they execute.
        # This replaces the four layers of defense that used to live
        # in the WebSearch class and `_reflect_on_results`.
        self._router = IntentRouter()

        # Multi-agent orchestrator (set externally by entry.py).
        # Initialized to None so `_should_use_orchestrator` can safely
        # check `not self._orchestrator` without AttributeError.
        self._orchestrator = None

        # Deterministic complexity scorer for orchestrator routing.
        self._complexity_scorer = TaskComplexityScorer()

        self._permission = PermissionManager(mode=permission_mode, confirm_callback=confirm_callback)
        # New decision-based permission checker (Phase 5)
        _mode_map = {
            PermissionMode.AUTO: NewPermissionMode.DEFAULT,
            PermissionMode.ASK: NewPermissionMode.DEFAULT,
            PermissionMode.BYPASS: NewPermissionMode.FULL_AUTO,
        }
        self._permission_checker = PermissionChecker(
            mode=_mode_map.get(permission_mode, NewPermissionMode.DEFAULT),
        )
        self._checkpoint = CheckpointManager()
        self._memory: Optional[MemoryManager] = None
        self._sub_agents: List[SubAgent] = []
        self._max_sub_agent_depth = 2
        self._running = False
        self._cancelled = False
        # When True, all model API calls are proactively isolated to
        # a separate thread with its own event loop, avoiding the
        # ``asyncio.run() cannot be called from a running event loop``
        # conflict that occurs inside the openai library when called
        # from within the Textual TUI event loop.
        self._tui_mode: bool = False
        self._last_response: Optional[AgentResponse] = None
        # The streaming turn now uses a single while loop (codex-rs
        # ``submission_loop`` style) — no recursive re-entry, so this
        # guard is no longer needed. Kept as a vestigial attribute for
        # backward-compat with any test that introspects it.
        self._stream_recursion_depth = 0
        # Lazy-initialized QueryEngine facade (Phase 1 engine split)
        self._query_engine = None
        # Agent Harness — runtime guard and trajectory recording
        self._trajectory: Optional[TrajectoryRecorder] = None
        self._harness_guard: Optional[HarnessGuard] = None
        self._harness_enabled: bool = True  # can be toggled
        # Step state machine (trae-agent AgentStep 风格)
        self._steps: List[AgentStep] = []
        self._current_step: Optional[AgentStep] = None
        self._task_done: bool = False  # 检测 task_done 工具调用
        
        # Enhanced loop control (soft-stop, doom loop detection, context monitoring)
        self._doom_loop_detector = DoomLoopDetector(window_size=3, threshold=3)
        self._context_monitor = ContextMonitor(max_tokens=max_context_tokens, threshold=0.5)
        self._soft_stop_threshold = max_iterations - 10  # 软停止在硬停止前10轮触发
        
        # Retry manager for LLM calls
        self._retry_manager = RetryManager(TimeoutConfig(
            retry_enabled=True,
            retry_max_attempts=3,
            retry_initial_delay=2.0,
        ))
        
        # Recovery manager for session snapshots
        self._recovery_manager = recovery_manager
        self._last_snapshot_iteration = 0
        self._snapshot_interval = 5  # Save snapshot every 5 iterations

        # ── DeepSeek thinking-mode / reasoning_effort ──────────────────
        # Per-turn reasoning effort. ``None`` = don't send reasoning_effort
        # (model default, which is "high" for deepseek-v4). When set to
        # "low" / "high" / "max", the value is forwarded to DeepSeek's
        # chat.completions.create(reasoning_effort=...) AND
        # extra_body={"thinking": {"type": "enabled"}} is sent to opt into
        # thinking mode (required by DeepSeek's OpenAI-compat endpoint).
        # See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
        self._reasoning_effort: Optional[str] = None

        self._init_model()
        # P1 Enhancement integration (CodexMemories, GuardianAI, RolloutRecorder, etc.)
        self._p1: Optional[Any] = None  # type: P1Enhancements | None
        logger.info(f"AgentCore initialized (model: {self._model_type}, "
                     f"permission: {permission_mode.value}, session: {self._session_id}, "
                     f"tools: {self._tool_registry.list_tools()})")

    def _init_model(self) -> None:
        """使用 ClientFactory 创建 LLM Client (trae-agent 风格)."""
        try:
            self._provider_adapter = LegacyProviderAdapter(
                self._model_type,
                allow_fallback=self._allow_provider_fallback,
                # Keep the historical module-level seam injectable for CLI
                # integrations and tests while routing creation through the
                # explicit compatibility adapter.
                factory=create_client_from_config,
            )
            self._llm_client = self._provider_adapter.bind()
            # 保持 self._model 向后兼容 (部分代码仍访问 self._model.client / .model_name)
            self._model = self._llm_client
            # 同步 model_type 以防 fallback 改变了 provider
            self._model_type = self._llm_client.provider.value
            logger.info(f"LLM Client initialized: {self._llm_client.provider.value} / {self._llm_client.model_name}")
        except RuntimeError:
            raise
        except Exception as e:
            logger.error(f"Failed to init LLM client: {redact_provider_diagnostic(e)}")
            raise RuntimeError("All LLM client initializations failed") from e

    @property
    def provider_adapter_status(self) -> Dict[str, Any]:
        """Return a credential-free diagnostic for the legacy provider route."""
        adapter = getattr(self, "_provider_adapter", None)
        if adapter is None:
            return {
                "requested_provider": getattr(self, "_model_type", "unknown"),
                "bound_provider": None,
                "state": "uninitialized",
                "fallback_policy": "enabled" if getattr(self, "_allow_provider_fallback", True) else "disabled",
                "canonical_plane": "rust_runtime",
            }
        return adapter.status.to_dict()

    # ── DeepSeek thinking-mode / reasoning_effort ──────────────────
    def set_reasoning_effort(self, effort: Optional[str]) -> None:
        """Set the reasoning effort for subsequent DeepSeek calls.

        Accepts ``"low"`` / ``"high"`` / ``"max"`` / ``None``.
        ``None`` clears the override and lets the model use its default
        (which is ``"high"`` for deepseek-v4-*).

        Per the DeepSeek thinking-mode guide, when ``reasoning_effort``
        is set we also send ``extra_body={"thinking": {"type": "enabled"}}``
        because the OpenAI-compat endpoint requires opting into thinking
        mode explicitly. See:
        https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

        Non-DeepSeek providers ignore this setting — the value is only
        forwarded when ``self._llm_client.provider == LLMProvider.DEEPSEEK``.
        """
        if effort is not None and effort not in ("low", "high", "max"):
            logger.warning(f"Invalid reasoning_effort '{effort}', ignoring. Valid: low/high/max/None")
            return
        self._reasoning_effort = effort

    # ── Run mode → tool whitelist (DeepSeek-Harness-style preset) ──
    def set_run_mode(self, mode: Optional[str]) -> None:
        """Set the run mode for subsequent turns.

        The mode controls which tool categories are sent to the LLM and
        which tool calls are allowed to execute. See `hakus/modes.py`
        for the full policy table.

        Passing ``None`` clears the mode (all tools available, backward
        compat for direct-API callers).
        """
        if mode is None:
            self._run_mode = None
            return
        from .modes import normalize_run_mode
        self._run_mode = normalize_run_mode(mode)
        logger.debug(f"[agent] run_mode set to {self._run_mode}")

    def _allowed_tool_names(self) -> Optional[list[str]]:
        """Return the tool names allowed by the current run mode, or
        None if no mode is set (meaning "all tools, no filtering").

        Intersects the mode whitelist with the registry's
        `disabled_categories` set.
        """
        if self._run_mode is None:
            return None
        from .modes import mode_allowed_tools, RunMode  # noqa: F401
        return mode_allowed_tools(self._run_mode, self._tool_registry)

    def _is_deepseek(self) -> bool:
        """True if the active LLM client is a DeepSeek provider."""
        try:
            from .models.base_client import LLMProvider
            return (
                self._llm_client is not None
                and self._llm_client.provider == LLMProvider.DEEPSEEK
            )
        except Exception:
            return False

    def _deepseek_reasoning_kwargs(self) -> Dict[str, Any]:
        """Build kwargs to merge into chat.completions.create() for DeepSeek.

        Returns ``{}`` when the active provider isn't DeepSeek or when
        no reasoning_effort override is set. Otherwise returns:
            {
                "reasoning_effort": <effort>,
                "extra_body": {"thinking": {"type": "enabled"}},
            }

        Merging this into the existing kwargs dict is safe —
        ``reasoning_effort`` is a top-level OpenAI SDK param, and
        ``extra_body`` is the standard escape hatch for provider-specific
        fields.
        """
        if not self._is_deepseek() or not self._reasoning_effort:
            return {}
        return {
            "reasoning_effort": self._reasoning_effort,
            "extra_body": {"thinking": {"type": "enabled"}},
        }

    def enable_p1_enhancements(
        self,
        *,
        enable_memories: bool = True,
        enable_guardian: bool = True,
        enable_rollout: bool = True,
        enable_worldstate: bool = True,
        enable_compression: bool = True,
        enable_sandbox: bool = True,
        enable_agents_md: bool = True,
        guardian_model_client: Any = None,
        sandbox_config: Any = None,
    ) -> "P1Enhancements":
        """Enable P1 enhancements (CodexMemories, Guardian, Rollout, WorldState, etc.).
        
        Returns the P1Enhancements instance for further configuration.
        """
        from .p1_integration import P1Enhancements
        self._p1 = P1Enhancements(
            agent_core=self,
            working_dir=self._context._working_dir or os.getcwd(),
            session_id=self._session_id,
            enable_memories=enable_memories,
            enable_guardian=enable_guardian,
            enable_rollout=enable_rollout,
            enable_worldstate=enable_worldstate,
            enable_compression=enable_compression,
            enable_sandbox=enable_sandbox,
            enable_agents_md=enable_agents_md,
            guardian_model_client=guardian_model_client,
            sandbox_config=sandbox_config,
        )
        self._p1.initialize()
        return self._p1

    @property
    def p1(self) -> Any:
        """Access P1 enhancements (None if not enabled)."""
        return self._p1

    def shutdown_p1(self) -> None:
        """Shutdown P1 enhancements (Rollout, Guardian, etc.) if enabled."""
        if self._p1:
            try:
                self._p1.shutdown()
            except Exception as e:
                logger.debug(f"P1 shutdown failed: {e}")
            finally:
                self._p1 = None

    def _get_oa_client(self):
        """获取底层 OpenAI 兼容客户端.

        兼容新 BaseLLMClient (get_openai_client()) 和旧 _BaseModel (.client)。
        """
        if hasattr(self._model, "get_openai_client"):
            client = self._model.get_openai_client()
            if client is not None:
                return client
        if hasattr(self._model, "client"):
            return self._model.client
        return None

    @property
    def query_engine(self):
        """Lazy-initialized :class:`hakus.engine.QueryEngine` facade.

        Provides the new ``submit_message()`` / ``continue_pending()``
        API while delegating to the existing ``run_turn()`` internally.
        """
        if self._query_engine is None:
            from hakus.engine.query_engine import QueryEngine
            self._query_engine = QueryEngine(self)
        return self._query_engine

    @property
    def permission_checker(self) -> PermissionChecker:
        """Decision-based permission checker (Phase 5)."""
        return self._permission_checker

    @property
    def hook_executor(self):
        """Access the :class:`HookExecutor` from the QueryEngine."""
        return self.query_engine._hook_executor

    def set_system_prompt(self, prompt: str) -> None:
        self._context.set_static_system_prompt(prompt)

    def set_memory(self, memory_manager: Any) -> None:
        self._memory = memory_manager
        self._context.set_memory_manager(memory_manager)

    def register_tool(self, tool: Tool) -> None:
        self._tool_registry.register(tool)

    def register_lazy_tool(self, name: str, loader: Callable[[], Tool]) -> None:
        self._tool_registry.register_lazy(name, loader)

    # Track current iteration for system prompt awareness
    _current_iteration: int = 0

    def _build_messages(self) -> List[Dict[str, Any]]:
        messages = self._context.build_messages()
        plan_mgr = getattr(self, "_plan_manager", None)
        if plan_mgr:
            suffix = plan_mgr.get_system_prompt_suffix()
            if suffix and messages and messages[0].get("role") == "system":
                messages = list(messages)
                messages[0] = {
                    "role": "system",
                    "content": messages[0].get("content", "") + suffix,
                }

        # ── Context-aware iteration control ──
        # Instead of a fixed iteration cap, use context usage to drive
        # the model's behavior. This prevents the "hard wall" problem
        # where the model hits the iteration limit mid-exploration.
        if messages and messages[0].get("role") == "system":
            hint = self._get_iteration_hint()
            if hint:
                messages = list(messages)
                messages[0] = {
                    "role": "system",
                    "content": messages[0].get("content", "") + hint,
                }
        return messages

    def _get_iteration_hint(self) -> str:
        """Generate a context-aware hint for the model.

        Strategy:
        - context < 40%: no hint (full freedom)
        - 40-60%: mild hint to start wrapping up
        - 60-75%: strong hint to summarize now
        - 75%+: force stop — inject "STOP calling tools, give answer NOW"
        - Also factor in remaining iterations as a secondary signal

        Note: Our estimate tends to underestimate actual API token usage,
        so these thresholds are lower than the raw percentages suggest.
        """
        try:
            estimated = self._context._total_estimated_tokens()
            budget = self._context.budget
            pct = int(estimated * 100 / max(1, budget))
        except Exception:
            pct = 0

        remaining = self._max_iterations - self._current_iteration

        # Context-driven hints (primary control)
        # Thresholds are calibrated for post-calibration estimates.
        # Before calibration converges, estimates may still be low,
        # so the hard guard at 70% (in the streaming loop) acts as backup.
        if pct >= 60:
            return (
                "\n\n[CRITICAL] Context is nearly full. "
                "You MUST stop calling tools NOW and provide your final "
                "answer based on what you've already gathered. "
                "Do NOT call any more tools."
            )
        elif pct >= 45:
            return (
                "\n\n[IMPORTANT] Context usage is high. "
                "Prioritize giving a comprehensive answer now rather than "
                "calling more tools. Only call tools if absolutely essential."
            )
        elif pct >= 30:
            return (
                "\n\n[NOTE] Context usage is moderate. "
                "Consider starting to summarize your findings. "
                "Avoid calling tools that return large outputs."
            )

        # Iteration-driven hints (secondary safety net)
        if remaining <= 3:
            return (
                "\n\n[IMPORTANT] Only %d iteration(s) remaining. "
                "Prioritize giving a comprehensive answer now rather than "
                "calling more tools. Summarize what you've found." % remaining
            )
        elif remaining <= 6:
            return (
                "\n\n[NOTE] %d iterations remaining. "
                "Start wrapping up your analysis." % remaining
            )

        return ""

    def get_step_summary(self) -> str:
        """生成 Lakeview 风格的步骤摘要 (trae-agent Lakeview 借鉴).

        每步一行, 格式: Step N: [emoji] ToolName(args) — result摘要
        用于 ActivityStrip 或 debug 日志中显示简洁进度.
        """
        if not self._steps:
            return ""
        lines = []
        emoji_map = {
            StepState.THINKING: "🧠",
            StepState.STREAMING: "📡",
            StepState.TOOL_CALL: "⚙️",
            StepState.TOOL_RESULT: "✅",
            StepState.REFLECTING: "🔄",
            StepState.COMPLETED: "✨",
            StepState.ERROR: "❌",
            StepState.ABORTED: "⛔",
        }
        for s in self._steps:
            emoji = emoji_map.get(s.state, "•")
            if s.tool_calls:
                tools_str = ", ".join(f"{tc.name}({list(tc.arguments.keys())})" for tc in s.tool_calls[:3])
                if len(s.tool_calls) > 3:
                    tools_str += f" +{len(s.tool_calls)-3} more"
            else:
                tools_str = "thinking"
            result_preview = ""
            if s.tool_results:
                ok = sum(1 for r in s.tool_results if r.success)
                total = len(s.tool_results)
                result_preview = f" ({ok}/{total} ok)"
            elif s.error:
                result_preview = f" ERR: {s.error[:40]}"
            dur = f"{s.duration_ms:.0f}ms" if s.duration_ms > 0 else ""
            lines.append(f"Step {s.step_number}: {emoji} {tools_str}{result_preview} {dur}".strip())
        return "\n".join(lines)

    async def _apply_user_prompt_hooks(self, user_message: str) -> Tuple[str, Optional[str]]:
        hook_chain = getattr(self, "_hook_chain", None)
        if not hook_chain:
            return user_message, None
        return await hook_chain.on_user_message(user_message)

    @staticmethod
    def _all_tool_results_were_reroutes(results: List[ToolCallResult]) -> bool:
        """Return True if all tool results are router reroutes.

        Router reroutes produce 'successful' results but the actual
        tool was never executed — the result is a corrective message.
        We detect this by checking if the result text starts with the
        reroute prefix.
        """
        if not results:
            return False
        for r in results:
            if not r.success:
                return False
            if not r.result.startswith("\u274c Refused:"):
                return False
        return True

    def _is_plan_mode_write_blocked(self, tool_name: str) -> bool:
        plan_mgr = getattr(self, "_plan_manager", None)
        if not plan_mgr or not plan_mgr.is_plan_mode():
            return False
        return tool_name in _PLAN_MODE_BLOCKED_TOOLS

    async def _finalize_stop_hooks(self) -> None:
        hook_chain = getattr(self, "_hook_chain", None)
        if hook_chain:
            try:
                await hook_chain.on_stop()
            except Exception as e:
                logger.warning(f"Stop hook failed: {e}")

    async def _call_model(self, messages: List[Dict[str, Any]],
                          tools: Optional[List[Dict]] = None,
                          timeout: Optional[float] = None) -> Tuple[str, List[Dict]]:
        """Call the model.

        Uses the OpenAI client directly so that:
        - Messages are passed as-is (preserving tool_calls / tool_call_id
          fields that the API requires for assistant→tool pairing).
        - The full Agent tool set is advertised, not the 4 hard-coded
          tools in the model wrapper.

        Falls back to the legacy model wrapper only when no OpenAI
        client is available.
        """
        # --- Prefer the OpenAI client (same code path as run_turn) ---
        # 新 BaseLLMClient 通过 get_openai_client() 暴露底层 client
        oa_client = None
        if hasattr(self._model, "get_openai_client"):
            oa_client = self._model.get_openai_client()
        if oa_client is not None:
            return await self._call_model_via_client(messages, tools, timeout)
        # 兼容旧 _BaseModel 实例 (有 .client 属性)
        _oa = self._get_oa_client()
        if _oa is not None:
            return await self._call_model_via_client(messages, tools, timeout)

        # --- Legacy path for models without an OpenAI client ---
        if tools is None:
            _allowed = self._allowed_tool_names()
            _names = _allowed if _allowed is not None else self._tool_registry.list_tools()
            tools = self._tool_registry.get_schemas(_names)
        if timeout is None:
            timeout = self._llm_timeout
        try:
            system_prompt, chat_messages = "", []
            for msg in messages:
                if msg.get("role") == "system":
                    system_prompt = msg.get("content", "")
                else:
                    chat_messages.append(msg)
            if hasattr(self._model, "generate_response"):
                import inspect as _inspect
                sig = _inspect.signature(self._model.generate_response)
                if "tools" in sig.parameters:
                    coro = self._model.generate_response(
                        system_prompt=system_prompt, messages=chat_messages,
                        tools=tools if tools else None)
                else:
                    coro = self._model.generate_response(
                        system_prompt=system_prompt, messages=chat_messages)
                if timeout and timeout > 0:
                    try:
                        result = await asyncio.wait_for(coro, timeout=timeout)
                    except asyncio.TimeoutError:
                        logger.error(f"LLM call timed out after {timeout:.1f}s")
                        return (
                            f"[Error: 模型调用超时 ({timeout:.0f}秒). "
                            "可能是网络问题, 请重试.]",
                            [],
                        )
                else:
                    result = await coro
                if isinstance(result, tuple):
                    return result
                return str(result), []
            elif hasattr(self._model, "generate_response_no_tools"):
                content = await self._model.generate_response_no_tools(
                    system_prompt=system_prompt, messages=chat_messages)
                return content, []
            raise RuntimeError("Model has no compatible generate method")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Model call failed: {e}")
            return f"Error: {type(e).__name__}", []

    async def _call_model_via_client(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """Call the model using the OpenAI client directly.

        Passes messages as-is (preserving tool_calls / tool_call_id fields)
        and advertises the full Agent tool set.  Also handles DSML XML
        tool calls that DeepSeek may emit in the ``content`` field instead
        of the structured ``tool_calls`` field.

        Returns (content, tool_calls_list).  Never raises — errors are
        returned as the content string.

        Added retry with exponential backoff for transient errors
        (rate limits, timeouts, server errors) to prevent a single 429
        from killing an entire Orchestrator task.
        """
        # Proactive thread isolation in TUI mode — avoids the
        # ``asyncio.run() cannot be called from a running event loop``
        # error from the openai library's internals entirely.
        if self._tui_mode:
            return await self._call_model_in_thread(messages, tools, timeout)

        if tools is None:
            _allowed = self._allowed_tool_names()
            _names = _allowed if _allowed is not None else self._tool_registry.list_tools()
            tools = self._tool_registry.get_schemas(_names)
        if timeout is None:
            timeout = self._llm_timeout

        max_retries = 3
        last_error: Optional[Exception] = None
        _call_started = time.time()
        llm_logger.info(
            f"[llm.call] model={self._model.model_name} msgs={len(messages)} "
            f"tools={len(tools or [])} retries={max_retries}"
        )
        for attempt in range(1, max_retries + 1):
            try:
                content, tool_calls = await self._call_model_once_via_client(messages, tools, timeout)
                elapsed = time.time() - _call_started
                llm_logger.info(
                    f"[llm.response] model={self._model.model_name} "
                    f"content_len={len(content)} tool_calls={len(tool_calls)} "
                    f"elapsed_ms={int(elapsed * 1000)}"
                )
                return content, tool_calls
            except asyncio.CancelledError:
                raise
            except Exception as e:
                last_error = e
                elapsed = time.time() - _call_started
                if attempt >= max_retries or not self._retry_manager.is_retryable(e):
                    llm_logger.error(
                        f"[llm.failed] model={self._model.model_name} "
                        f"error={type(e).__name__} attempts={attempt} "
                        f"elapsed_ms={int(elapsed * 1000)}"
                    )
                    break
                delay = self._retry_manager.calculate_delay(attempt)
                llm_logger.warning(
                    f"[llm.retry] model={self._model.model_name} "
                    f"attempt={attempt}/{max_retries} error={type(e).__name__}: {e} "
                    f"next_delay_ms={int(delay * 1000)} elapsed_ms={int(elapsed * 1000)}"
                )
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_raw(
                        f"\n  [RETRY] LLM call attempt {attempt}/{max_retries}, "
                        f"waiting {delay:.1f}s ({type(e).__name__})\n"
                    )
                await asyncio.sleep(delay)

        # All retries exhausted or non-retryable error — convert to content string
        return self._format_call_model_error(last_error, messages, timeout)

    async def _call_model_once_via_client(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """Single non-retrying OpenAI client call (internal helper)."""
        # 获取底层 OpenAI client (兼容新 BaseLLMClient 和旧 _BaseModel)
        _oa_client = getattr(self._model, "client", None)
        if _oa_client is None and hasattr(self._model, "get_openai_client"):
            _oa_client = self._model.get_openai_client()
        _model_name = self._model.model_name

        response = await asyncio.wait_for(
            _oa_client.chat.completions.create(
                model=_model_name,
                messages=messages,
                tools=tools or None,
                **self._deepseek_reasoning_kwargs(),
            ),
            timeout=timeout,
        )

        content = ""
        tool_calls_list: List[Dict[str, Any]] = []
        if response.choices:
            choice = response.choices[0]
            message = choice.message
            content = message.content or ""
            if message.tool_calls:
                for tc in message.tool_calls:
                    try:
                        args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                    except json.JSONDecodeError:
                        args = {}
                    tool_calls_list.append({
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": args,
                    })

        # --- DSML XML fallback ---
        # DeepSeek may embed tool calls as DSML XML inside `content`
        # instead of using the structured `tool_calls` field.  Parse
        # them here so the tool loop doesn't silently stop.
        if not tool_calls_list and content:
            dsml_calls, leftover = _parse_dsml_calls(content)
            if dsml_calls:
                tool_calls_list = dsml_calls
                content = leftover

        return content, tool_calls_list

    def _format_call_model_error(
        self,
        error: Optional[Exception],
        messages: List[Dict[str, Any]],
        timeout: Optional[float] = None,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """Convert an LLM call exception into a user-facing content string."""
        if error is None:
            return "[Error: 模型调用失败: unknown error]", []

        err_name = type(error).__name__
        err_msg = str(error)

        if isinstance(error, asyncio.TimeoutError):
            logger.error(f"LLM client call timed out after {timeout:.1f}s")
            return f"[Error: 模型调用超时 ({timeout:.0f}秒)]", []

        if isinstance(error, RuntimeError):
            if "asyncio.run" in err_msg or "event loop" in err_msg:
                # This should have been handled by retry; return a clear message.
                import traceback as _tb
                logger.warning(
                    f"Event-loop conflict in _call_model_via_client: {error}\n"
                    f"{_tb.format_exc()}"
                )
            logger.error(f"LLM client call failed (RuntimeError): {error}")
            return "[Error: 模型调用失败: RuntimeError]", []

        logger.error(f"LLM client call failed: {err_name}: {err_msg}")

        # If this is a BadRequestError, try to provide actionable info
        if "400" in err_msg or "Bad" in err_name or "Request" in err_name:
            msg_summary = []
            for m in messages[:5]:
                role = m.get("role", "?")
                has_tc = bool(m.get("tool_calls"))
                tc_id = m.get("tool_call_id", "")
                msg_summary.append(f"{role}(tc={has_tc},id={tc_id})")
            logger.error(
                f"BadRequestError details — messages structure: "
                f"{msg_summary} ... (total {len(messages)} msgs)"
            )
            return (
                f"[Error: 模型调用失败: {err_name}] "
                f"可能原因: 消息格式异常或上下文过长。请尝试重新开始对话。",
                [],
            )

        return f"[Error: 模型调用失败: {err_name}]", []

    async def _call_model_with_client(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """Public alias for ``_call_model_via_client``.

        Kept for backward compatibility — all call sites that need the
        OpenAI client path should go through ``_call_model`` (which now
        prefers the client internally).
        """
        if not hasattr(self._model, "client") and not hasattr(self._model, "get_openai_client"):
            return await self._call_model(messages, tools, timeout)
        return await self._call_model_via_client(messages, tools, timeout)

    async def _call_model_in_thread(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """Run the model API call in a dedicated thread with its own event loop.

        This is the last-resort fallback when the main event loop has a
        conflict (e.g. ``asyncio.run() cannot be called from a running
        event loop``).  By running in a fresh thread, we get a clean
        event loop with no conflicts.
        """
        import concurrent.futures

        if tools is None:
            _allowed = self._allowed_tool_names()
            _names = _allowed if _allowed is not None else self._tool_registry.list_tools()
            tools = self._tool_registry.get_schemas(_names)
        if timeout is None:
            timeout = self._llm_timeout

        # Capture the model reference for the thread
        model = self._model
        model_name = model.model_name
        # 获取底层 OpenAI client (兼容新 BaseLLMClient 和旧 _BaseModel)
        oa_client = getattr(model, "client", None)
        if oa_client is None and hasattr(model, "get_openai_client"):
            oa_client = model.get_openai_client()
        # Capture DeepSeek reasoning kwargs BEFORE entering the thread —
        # _deepseek_reasoning_kwargs() reads self._reasoning_effort which
        # is set on the main thread; capturing here avoids cross-thread
        # attribute reads.
        _ds_reasoning_kwargs = self._deepseek_reasoning_kwargs()

        def _run_in_fresh_loop() -> Tuple[str, List[Dict[str, Any]]]:
            """Synchronous function that creates its own event loop."""
            async def _do_call():
                response = await asyncio.wait_for(
                    oa_client.chat.completions.create(
                        model=model_name,
                        messages=messages,
                        tools=tools or None,
                        **_ds_reasoning_kwargs,
                    ),
                    timeout=timeout,
                )
                content = ""
                tool_calls_list: List[Dict[str, Any]] = []
                if response.choices:
                    choice = response.choices[0]
                    message = choice.message
                    content = message.content or ""
                    if message.tool_calls:
                        for tc in message.tool_calls:
                            try:
                                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                            except json.JSONDecodeError:
                                args = {}
                            tool_calls_list.append({
                                "id": tc.id,
                                "name": tc.function.name,
                                "arguments": args,
                            })
                # DSML XML fallback
                if not tool_calls_list and content:
                    dsml_calls, leftover = _parse_dsml_calls(content)
                    if dsml_calls:
                        tool_calls_list = dsml_calls
                        content = leftover
                return content, tool_calls_list

            return asyncio.run(_do_call())

        try:
            loop = asyncio.get_running_loop()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = await loop.run_in_executor(pool, _run_in_fresh_loop)
            return result
        except Exception as e:
            logger.error(f"_call_model_in_thread failed: {type(e).__name__}: {e}")
            return f"[Error: 模型调用失败(线程回退): {type(e).__name__}]", []

    # ------------------------------------------------------------------
    # Isolated streaming: runs the openai streaming call in a separate
    # thread with its own event loop, forwarding chunks via a queue.
    # This completely avoids the ``asyncio.run() cannot be called from
    # a running event loop`` error that occurs inside the openai library
    # when called from within the Textual TUI event loop.
    # ------------------------------------------------------------------

    class _IsolatedStreamIterator:
        """Async iterator that yields chunks from an isolated streaming thread.

        The streaming API call runs in a daemon thread with its own event
        loop.  Chunks are forwarded to the main event loop via a
        ``threading.Queue`` + ``asyncio.Event`` bridge.
        """

        def __init__(
            self,
            data_queue: "queue.Queue",
            notify: asyncio.Event,
            loop: asyncio.AbstractEventLoop,
            chunk_timeout: float,
        ) -> None:
            self._queue = data_queue
            self._notify = notify
            self._loop = loop
            self._chunk_timeout = chunk_timeout
            self._done = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self._done:
                raise StopAsyncIteration

            while True:
                # Drain any already-available items first.
                drained_any = False
                while True:
                    try:
                        item_type, item = self._queue.get_nowait()
                    except Exception:  # queue.Empty
                        break
                    drained_any = True
                    if item_type == "chunk":
                        return item
                    elif item_type == "error":
                        self._done = True
                        raise item
                    elif item_type == "timeout":
                        self._done = True
                        raise asyncio.TimeoutError()
                    elif item_type == "done":
                        self._done = True
                        raise StopAsyncIteration

                # Nothing in the queue — wait for the thread to notify us.
                try:
                    await asyncio.wait_for(
                        self._notify.wait(),
                        timeout=self._chunk_timeout,
                    )
                except asyncio.TimeoutError:
                    self._done = True
                    raise
                self._notify.clear()

    async def _create_stream_isolated(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
        include_usage: bool = True,
    ) -> "_IsolatedStreamIterator":
        """Create a streaming completion in an isolated thread.

        Returns an async iterator of stream chunks, compatible with the
        ``_iter_with_timeout`` wrapper used by ``_do_streaming_turn_events``.
        """
        import queue as _threading_queue

        if timeout is None:
            timeout = self._llm_timeout

        model = self._model
        model_name = model.model_name
        # Capture DeepSeek reasoning kwargs on the main thread — the
        # streaming thread has its own event loop and shouldn't reach
        # back into self._reasoning_effort.
        _ds_reasoning_kwargs = self._deepseek_reasoning_kwargs()

        data_queue: _threading_queue.Queue = _threading_queue.Queue()
        notify = asyncio.Event()
        loop = asyncio.get_running_loop()

        def _notify_main():
            """Wake up the main event loop (called from streaming thread)."""
            try:
                loop.call_soon_threadsafe(notify.set)
            except RuntimeError:
                pass  # Loop might be closed during shutdown

        def _stream_in_thread():
            """Run the streaming API call in a fresh event loop."""
            async def _do_stream():
                kwargs: Dict[str, Any] = {
                    "model": model_name,
                    "messages": messages,
                    "stream": True,
                }
                if tools:
                    kwargs["tools"] = tools
                # Apply DeepSeek reasoning_effort + thinking extra_body.
                # These are no-ops for non-DeepSeek providers (empty dict).
                kwargs.update(_ds_reasoning_kwargs)

                # Try with stream_options first (for token counting).
                stream = None
                if include_usage:
                    try:
                        stream = await asyncio.wait_for(
                            model.client.chat.completions.create(
                                **kwargs,
                                stream_options={"include_usage": True},
                            ),
                            timeout=timeout,
                        )
                    except Exception as e:
                        err_str = str(e).lower()
                        is_stream_opt_error = (
                            "stream_option" in err_str
                            or "stream option" in err_str
                            or "unknown parameter" in err_str
                            or "unexpected parameter" in err_str
                            or "unrecognized parameter" in err_str
                        )
                        if is_stream_opt_error:
                            logger.info(
                                "Provider rejected stream_options in "
                                "isolated thread, retrying without"
                            )
                        else:
                            data_queue.put(("error", e))
                            _notify_main()
                            return

                # Without stream_options (fallback or explicit).
                if stream is None:
                    try:
                        stream = await asyncio.wait_for(
                            model.client.chat.completions.create(**kwargs),
                            timeout=timeout,
                        )
                    except asyncio.TimeoutError:
                        data_queue.put(("timeout", None))
                        _notify_main()
                        return
                    except Exception as e:
                        data_queue.put(("error", e))
                        _notify_main()
                        return

                async for chunk in stream:
                    data_queue.put(("chunk", chunk))
                    _notify_main()

                data_queue.put(("done", None))
                _notify_main()

            try:
                asyncio.run(_do_stream())
            except Exception as e:
                # If asyncio.run itself fails, forward the error.
                data_queue.put(("error", e))
                _notify_main()

        # Start the streaming thread (daemon so it dies with the main process).
        thread = threading.Thread(target=_stream_in_thread, daemon=True)
        thread.start()

        return self._IsolatedStreamIterator(
            data_queue=data_queue,
            notify=notify,
            loop=loop,
            chunk_timeout=timeout,
        )

    async def _create_stream(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
        include_usage: bool = True,
    ) -> Any:
        """Create a streaming completion, handling stream_options negotiation.

        Some providers (DeepSeek) reject stream_options with HTTP 400.
        This method tries with stream_options first (for token counting),
        and falls back without it **only** when the 400 error is clearly
        caused by stream_options (not by message format issues).

        In TUI mode (``_tui_mode=True``), delegates to
        ``_create_stream_isolated`` which runs the API call in a
        separate thread to avoid event-loop conflicts.
        """
        # Proactive thread isolation in TUI mode.
        if self._tui_mode:
            return await self._create_stream_isolated(
                messages, tools, timeout, include_usage,
            )

        if timeout is None:
            timeout = self._llm_timeout

        kwargs: Dict[str, Any] = {
            "model": self._model.model_name,
            "messages": messages,
            "stream": True,
            # Set an explicit max_tokens so the model has enough room to
            # emit tool calls. Without this, some providers (especially
            # "flash" variants) default to a low max_tokens, causing the
            # response to be truncated (finish_reason="length") before
            # any tool_calls can be emitted — the agent then sees no
            # tool calls and ends the turn prematurely.
            "max_tokens": 8192,
        }
        if tools:
            kwargs["tools"] = tools
        # Apply DeepSeek reasoning_effort + thinking extra_body.
        # No-op for non-DeepSeek providers (returns empty dict).
        kwargs.update(self._deepseek_reasoning_kwargs())

        if include_usage:
            try:
                _oa = self._get_oa_client()
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_raw(f"\n  [LLM] Calling API with stream_options (timeout={timeout}s)\n")
                result = await asyncio.wait_for(
                    _oa.chat.completions.create(
                        **kwargs,
                        stream_options={"include_usage": True},
                    ),
                    timeout=timeout,
                )
                if _dbg:
                    _dbg.log_raw(f"\n  [LLM] Stream created successfully\n")
                return result
            except asyncio.TimeoutError:
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_raw(f"\n  [LLM] API call timed out after {timeout}s\n")
                raise
            except Exception as e:
                err_str = str(e).lower()
                err_name = type(e).__name__
                # Only retry without stream_options if the error is
                # specifically about stream_options or is a generic 400
                # that mentions "stream" / "option" / "parameter".
                # Do NOT swallow message-format 400 errors.
                is_stream_opt_error = (
                    "stream_option" in err_str
                    or "stream option" in err_str
                    or "unknown parameter" in err_str
                    or "unexpected parameter" in err_str
                    or "unrecognized parameter" in err_str
                )
                if is_stream_opt_error:
                    logger.info(
                        f"Provider rejected stream_options ({err_name}), "
                        f"retrying without"
                    )
                else:
                    # This is likely a message format error, not a
                    # stream_options issue — re-raise immediately.
                    raise

        # Without stream_options (fallback or explicit)
        _oa = self._get_oa_client()
        return await asyncio.wait_for(
            _oa.chat.completions.create(**kwargs),
            timeout=timeout,
        )

    async def _create_stream_with_retry(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        timeout: Optional[float] = None,
        max_retries: int = 3,
    ) -> Any:
        """Create a streaming completion with automatic retry on failure.
        
        Uses the retry manager to handle transient failures like:
        - Network timeouts
        - Rate limiting (429)
        - Server errors (500, 502, 503)
        """
        last_error = None
        for attempt in range(1, max_retries + 1):
            try:
                return await self._create_stream(messages, tools, timeout)
            except Exception as e:
                last_error = e
                if not self._retry_manager.is_retryable(e) or attempt >= max_retries:
                    raise
                
                delay = self._retry_manager.calculate_delay(attempt)
                logger.warning(
                    f"LLM call failed (attempt {attempt}/{max_retries}): {type(e).__name__}: {e}. "
                    f"Retrying in {delay:.1f}s..."
                )
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_raw(f"\n  [RETRY] Attempt {attempt}/{max_retries}, waiting {delay:.1f}s\n")
                await asyncio.sleep(delay)
        
        raise last_error or RuntimeError("Max retries exceeded")

    async def _execute_tool_call(self, tool_name: str, arguments: Dict[str, Any]) -> ToolCallResult:
        start = time.time()
        if self._is_plan_mode_write_blocked(tool_name):
            return ToolCallResult(
                tool_name, arguments,
                f"Plan mode: tool '{tool_name}' is blocked until plan is approved.",
                False, time.time() - start,
            )

        # Mode whitelist runtime check (defensive — the schema builder
        # already filters disallowed tools out, but if the model
        # hallucinates a tool name that *would* be in the registry but
        # is disallowed by the current run mode, we block it here too).
        # This catches the edge case where the LLM emits a tool_call
        # for a name it remembered from a previous turn but that the
        # current mode no longer exposes.
        if self._run_mode is not None:
            from .modes import mode_allows_tool
            tool = self._tool_registry.get(tool_name)
            if tool is not None and not mode_allows_tool(self._run_mode, tool):
                logger.info(
                    f"[agent] mode '{self._run_mode}' disallows tool "
                    f"'{tool_name}' (category={tool.category}) — blocking"
                )
                return ToolCallResult(
                    tool_name, arguments,
                    f"Run mode '{self._run_mode}' does not allow tool "
                    f"'{tool_name}' (category={tool.category}). Switch to "
                    f"a different mode or use a read-only alternative.",
                    False, time.time() - start,
                )

        # ------------------------------------------------------------------
        # System-level routing (replaces the 4 layers of WebSearch defense)
        # ------------------------------------------------------------------
        # The router sees every tool call BEFORE it runs. If the call is a
        # mis-routing (e.g. user asked for a local CSV but model called
        # `web_search`), the router returns a corrective message that
        # replaces the tool's actual output. The model sees the message
        # and corrects itself in the next turn.
        canonical_name = self._router.canonicalize_tool_name(tool_name)
        reroute_message = self._router.reroute_if_needed(canonical_name, arguments or {})
        if reroute_message is not None:
            logger.info(f"Router rerouted '{tool_name}' call: {arguments}")
            # Append a continuation instruction — the model may
            # otherwise just acknowledge the reroute with text
            # instead of generating the corrected tool call.
            reroute_message += (
                "\n\n---\n"
                "**ACTION REQUIRED:** You MUST call the correct local "
                "tool NOW. Generate the tool call in your next response "
                "— do NOT explain what you plan to do, just DO it."
            )
            return ToolCallResult(
                tool_name, arguments, reroute_message,
                True, time.time() - start,
            )
        # Use the canonical name for the actual tool lookup, so the
        # model calling `search_web` (old alias) still finds `web_search`
        # (the real tool). The schema only advertises canonical names.
        lookup_name = canonical_name

        # Harness guard check
        if self._harness_guard:
            try:
                _pct = 0
                try:
                    _est = self._context._total_estimated_tokens()
                    _budget = self._context.budget
                    _pct = int(_est * 100 / max(1, _budget))
                except Exception:
                    pass
                decision = self._harness_guard.check_before_tool_call(lookup_name, arguments, _pct)
                if not decision.allowed:
                    if decision.forced_end:
                        return ToolCallResult(
                            lookup_name, arguments,
                            f"[HARNESS] Agent stopped: {decision.reason}",
                            False, time.time() - start,
                        )
                    return ToolCallResult(
                        lookup_name, arguments,
                        f"[HARNESS] Tool call blocked: {decision.reason}",
                        False, time.time() - start,
                    )
            except Exception:
                pass

        # Harness: record tool call
        if self._trajectory:
            try:
                self._trajectory.record_tool_call(
                    tool_name=lookup_name,
                    arguments=arguments,
                    call_id="",
                )
            except Exception:
                pass

        hook_chain = getattr(self, "_hook_chain", None)
        if hook_chain:
            allowed = await hook_chain.before_tool_use(lookup_name, arguments)
            if not allowed:
                return ToolCallResult(
                    lookup_name, arguments, f"Blocked by hook: {lookup_name}",
                    False, time.time() - start,
                )
        # ask_user is handled directly by the streaming/non-streaming turn
        # loops so they can yield QuestionAsked and wait for an AnswerOp.
        if lookup_name.lower() == "ask_user":
            return ToolCallResult(
                lookup_name, arguments,
                "Error: ask_user must be handled by the AgentCore turn loop.",
                False, time.time() - start,
            )

        tool = self._tool_registry.get(lookup_name)
        if not tool:
            return ToolCallResult(lookup_name, arguments, f"Unknown tool: {lookup_name}", False, time.time() - start)
        # --- Permission check ---
        # In TUI mode, use the async path so the confirm callback
        # can push a Textual Modal screen directly on the event loop
        # (no threading / context-variable bridging required).
        if self._tui_mode:
            perm = await self._permission.async_check_tool_execution(
                lookup_name, tool.is_dangerous, arguments,
            )
        else:
            perm = self._permission.check_tool_execution(lookup_name, tool.is_dangerous, arguments)
        if not perm:
            reason = getattr(perm, 'reason', 'Permission denied') if perm else 'Permission denied'
            return ToolCallResult(lookup_name, arguments, f"Permission denied: {reason}", False, time.time() - start)
        try:
            # 使用 ToolExecutor 执行 (统一异常处理 + 结果截断)
            tc = BaseToolCall(name=lookup_name, arguments=arguments)
            tr = await self._tool_executor.execute(tc)
            result_str = tr.result if tr.success else f"Error: {tr.error}"
            if hook_chain:
                await hook_chain.after_tool_use(lookup_name, arguments, result_str)
            # Harness: record tool result
            if self._trajectory:
                try:
                    self._trajectory.record_tool_result(
                        call_id="",
                        result=result_str[:500] if result_str else "",
                        success=tr.success,
                        duration_ms=(time.time() - start) * 1000,
                    )
                except Exception:
                    pass
            # HarnessGuard: record tool call for loop detection
            if self._harness_guard:
                try:
                    self._harness_guard.record_tool_call(lookup_name, arguments)
                except Exception:
                    pass
            return ToolCallResult(lookup_name, arguments, result_str, tr.success, time.time() - start)
        except Exception as e:
            logger.error(f"Tool execution error [{lookup_name}]: {e}")
            # Harness: record tool result (failure)
            if self._trajectory:
                try:
                    self._trajectory.record_tool_result(
                        call_id="",
                        result=f"Error: {e}"[:500],
                        success=False,
                        duration_ms=(time.time() - start) * 1000,
                    )
                except Exception:
                    pass
            # HarnessGuard: record failed tool call too
            if self._harness_guard:
                try:
                    self._harness_guard.record_tool_call(lookup_name, arguments)
                except Exception:
                    pass
            return ToolCallResult(lookup_name, arguments, f"Error: {e}", False, time.time() - start)

    async def _wait_for_answer(
        self,
        question_id: str,
        op_receiver: "Optional[asyncio.Queue]",
    ) -> str:
        """Wait for an AnswerOp matching ``question_id`` on ``op_receiver``.

        Used by the ``ask_user`` tool flow. Periodically yields control so
        the event loop can process inbound messages (WebSocket/REST answer
        endpoints) and checks the agent's cancel flag.

        Raises:
            asyncio.CancelledError: if the turn is cancelled before an answer
                arrives.
        """
        from .protocol import AnswerOp

        # #region debug-point A:wait-for-answer
        _debug_log("A", "agent.py:_wait_for_answer", "enter wait", {"question_id": question_id, "has_receiver": op_receiver is not None})
        _loop_counter = 0
        # #endregion

        while True:
            if self._cancelled:
                # #region debug-point A:cancelled
                _debug_log("A", "agent.py:_wait_for_answer", "cancelled while waiting", {"question_id": question_id})
                # #endregion
                raise asyncio.CancelledError("user_interrupted")

            if op_receiver is not None:
                try:
                    op = op_receiver.get_nowait()
                    if isinstance(op, AnswerOp) and op.question_id == question_id:
                        # #region debug-point A:answer-received
                        _debug_log("A", "agent.py:_wait_for_answer", "answer received", {"question_id": question_id, "choice": op.choice})
                        # #endregion
                        return op.choice
                    # Not for us — put it back (best-effort)
                    try:
                        op_receiver.put_nowait(op)
                    except asyncio.QueueFull:
                        logger.warning("op_receiver full when requeueing op")
                except asyncio.QueueEmpty:
                    pass

            _loop_counter += 1
            if _loop_counter % 100 == 0:
                # #region debug-point A:still-waiting
                _debug_log("A", "agent.py:_wait_for_answer", "still waiting", {"question_id": question_id, "loops": _loop_counter})
                # #endregion

            await asyncio.sleep(0.05)

    async def _reflect_on_results(self, user_message: str, tool_results: List[ToolCallResult],
                                   iteration: int) -> ReflectionResult:
        if self._cancelled:
            return ReflectionResult(should_continue=False, reason="cancelled")
        if not tool_results or iteration >= self._max_iterations - 1:
            return ReflectionResult(should_continue=False, reason="Max iterations or no results")

        # Note: the previous "force continue on tool failure" branch has been
        # removed. The IntentRouter now handles mis-routed calls upfront
        # with a clear, single-turn corrective message. The reflection layer
        # is back to its single job: ask the LLM whether the results are
        # sufficient to answer the user's question.

        all_results = "\n".join(
            f"[{r.tool_name}] {'OK' if r.success else 'FAIL'}: {r.result[:300]}" for r in tool_results)
        try:
            prompt = (
                f"User asked: {user_message}\n"
                f"Iteration {iteration}. Tool results:\n{all_results}\n"
                f"Determine if ALL of the user's requirements are satisfied. "
                f"CRITICAL RULES for 'done':\n"
                f"  - 'done: true' ONLY when the FINAL OUTPUT is delivered to the user (e.g. calculation results shown, chart displayed, answer given).\n"
                f"  - 'done: false' if ANY intermediate step is incomplete:\n"
                f"    * Found a filename but haven't read the file contents → done: false, need: read_file\n"
                f"    * Listed a directory but haven't opened any files → done: false, need: read_file or glob\n"
                f"    * Read data but haven't performed calculations → done: false, need: bash (python script)\n"
                f"    * Calculated results but haven't shown them to user → done: false, need: display/print\n"
                f"    * Generated a chart file but haven't told the user where it is → done: false, need: report path\n"
                f"  - Finding a file is NEVER the end of the task. The task ends when the user's goal is achieved.\n"
                f"If any part is still pending, set 'done: false' and specify exactly what tool to call next.\n"
                f"JSON: {{\"done\": true/false, \"reason\": \"why\", \"need\": \"what tool to call next\"}}"
            )
            response, _ = await self._call_model(
                messages=[{"role": "system", "content": "Evaluate tool results. Return only JSON."},
                          {"role": "user", "content": prompt}], tools=[])
            # Reflection JSON parsing — now uses the typed
            # ``parse_reflection_response`` helper from
            # ``hakus.protocol.serialization``. Replaces the old
            # ``re.search(r"\{[\s\S]*\}", response)`` regex hack
            # at this site, which would silently accept malformed
            # JSON and could send the model into a bad state.
            from .protocol.serialization import parse_reflection_response
            decision = parse_reflection_response(response)
            if not decision.done:
                feedback = (
                    f"[SYSTEM INSTRUCTION] The user's task is NOT complete yet. "
                    f"You MUST call the tool `{decision.need}` in your next response — "
                    f"do NOT just say you will do it, actually generate the tool call "
                    f"with proper arguments. Reason: {decision.reason}"
                )
                return ReflectionResult(True, feedback, decision.reason)
            return ReflectionResult(False, reason=decision.reason)
        except asyncio.CancelledError:
            return ReflectionResult(False, reason="cancelled")
        except Exception as e:
            logger.warning(f"Reflection failed: {e}")
            return ReflectionResult(False, reason=f"Reflection error: {e}")

    async def _run_tool_loop(self, user_message: str, response: str,
                              tool_calls: List[Dict], iteration: int) -> Tuple[str, List[ToolCallResult], int]:
        """Execute a loop of tool calls until the model stops generating them.

        Key design principles (v2 — fixes the "loop dies after one round" bug):
        1. Each assistant message is stored WITH its ``tool_calls`` field so
           the OpenAI API sees the correct assistant→tool pairing.
        2. Tool results are stored with matching ``tool_call_id``.
        3. Subsequent model calls use the OpenAI client directly (via
           ``_call_model_with_client``) so the model always sees the full
           Agent tool set, not the 4 hard-coded tools in the model wrapper.
        4. The loop continues as long as the model generates tool calls —
           no separate reflection step is needed because the model can now
           correctly see tool results and decide whether to continue.
        """
        all_results: List[ToolCallResult] = []
        current_response, current_iteration = response, iteration
        current_tool_calls = tool_calls

        while current_tool_calls and current_iteration < self._max_iterations and not self._task_done:
            if self._cancelled:
                break
            # ── Step state machine: 创建新步骤 (trae-agent 风格) ──
            step = AgentStep(step_number=current_iteration, state=StepState.THINKING, start_time=time.time())
            self._current_step = step
            # Harness: increment iteration counter
            if self._harness_guard:
                try:
                    self._harness_guard.increment_iteration()
                except Exception:
                    pass
            # Harness: record model thought
            if self._trajectory and current_response:
                try:
                    self._trajectory.record_thought(current_response[:500])
                except Exception:
                    pass
            self._checkpoint.auto_save(self._context.snapshot(), trigger=f"pre_tool_iter_{current_iteration}")

            # --- 1. Store the assistant message WITH tool_calls ---
            # This is critical: the OpenAI API requires the assistant message
            # to carry the ``tool_calls`` field so that subsequent ``tool``
            # messages can reference them by ``tool_call_id``.
            api_tool_calls: List[Dict[str, Any]] = []
            for tc in current_tool_calls:
                api_tool_calls.append({
                    "id": tc.get("id", f"call_{current_iteration}_{len(api_tool_calls)}"),
                    "type": "function",
                    "function": {
                        "name": tc.get("name", ""),
                        "arguments": json.dumps(tc.get("arguments", {}), ensure_ascii=False),
                    },
                })
            self._context.add_assistant_with_tool_calls(current_response, api_tool_calls)

            # --- 2. Execute tools ---
            step.state = StepState.TOOL_CALL
            step.tool_calls = [BaseToolCall(name=tc.get("name", ""), call_id=tc.get("id", ""), arguments=tc.get("arguments", {})) for tc in current_tool_calls]
            iter_results: List[ToolCallResult] = []
            all_safe = all(
                self._tool_registry.is_concurrency_safe(tc.get("name", ""))
                for tc in current_tool_calls
            )
            if len(current_tool_calls) > 1 and all_safe:
                coros = [
                    self._execute_tool_call(tc.get("name", ""), tc.get("arguments", {}))
                    for tc in current_tool_calls
                ]
                iter_results = await asyncio.gather(*coros, return_exceptions=False)
            else:
                for tc in current_tool_calls:
                    result = await self._execute_tool_call(tc.get("name", ""), tc.get("arguments", {}))
                    iter_results.append(result)

            # --- 3. Store tool results WITH matching tool_call_id ---
            for tc, result in zip(current_tool_calls, iter_results):
                self._context.add_tool_result(
                    tc.get("name", ""), result.result,
                    tool_call_id=tc.get("id", ""),
                )
            all_results.extend(iter_results)

            # ── Step state: TOOL_RESULT + task_done 检测 (trae-agent 风格) ──
            step.state = StepState.TOOL_RESULT
            step.tool_results = [BaseToolResult(name=r.tool_name, success=r.success, result=r.result[:500] if r.result else None, error=r.error) for r in iter_results]
            # 检测 task_done 工具调用 — 借鉴 trae-agent 的完成信号机制
            for tc in current_tool_calls:
                if tc.get("name", "").lower() in ("task_done", "taskdone"):
                    self._task_done = True
                    step.state = StepState.COMPLETED
                    logger.info(f"task_done detected at iteration {current_iteration}")
                    break
            # 记录步骤到历史
            step.end_time = time.time()
            self._steps.append(step)
            self._current_step = None

            # 写入 debug 日志 (Phase 4: 轨迹录制增强)
            _dbg = _get_dbg()
            if _dbg:
                try:
                    _dbg.log_structured_event(EVT_STEP_RECORD, {
                        "step_number": step.step_number,
                        "state": step.state.value,
                        "tool_calls": [{"name": tc.name, "args_keys": list(tc.arguments.keys())} for tc in step.tool_calls],
                        "tool_results": [{"name": r.name, "success": r.success} for r in step.tool_results],
                        "duration_ms": round(step.duration_ms, 1),
                        "tokens_used": step.tokens_used,
                        "task_done": self._task_done,
                    })
                except Exception:
                    pass

            # --- 4. Compress context if needed ---
            current_iteration += 1
            compression = await self._context.compress(self._model)
            if compression != CompressionLevel.NONE:
                logger.info(f"Context compressed: {compression.name}")

            # --- 5. Call model for the next round ---
            # Use the OpenAI client directly so the model sees the full
            # Agent tool set (read_file, bash, glob, etc.), not the 4
            # hard-coded tools in the model wrapper's generate_response.
            messages = self._build_messages()
            current_response, current_tool_calls = await self._call_model_with_client(messages)

        # If the loop ended because the model generated a final text
        # response (no more tool_calls), store that response.
        #
        # BUT: if the last model call returned no tool_calls AND
        # the previous iteration's results were all router reroutes
        # (the model was told to switch tools but didn't), inject a
        # continuation instruction and retry once.  Without this, the
        # task silently stalls after a reroute.
        if current_response and not current_tool_calls:
            if self._all_tool_results_were_reroutes(iter_results):
                logger.info(
                    "Model did not continue after router reroute — "
                    "injecting continuation prompt"
                )
                self._context.add_message("assistant", current_response)
                injection = (
                    "[SYSTEM INSTRUCTION] The previous tool call was "
                    "redirected.  You were told to use a LOCAL tool "
                    "(glob / list_dir / read_file / bash) instead.  "
                    "The task is NOT complete yet.  You MUST generate "
                    "the correct tool call NOW — do NOT just explain "
                    "what you will do, actually CALL the tool."
                )
                self._context.add_message("user", injection)
                messages = self._build_messages()
                current_response, current_tool_calls = await self._call_model_with_client(messages)
                current_iteration += 1
            if not current_tool_calls:
                self._context.add_message("assistant", current_response)

        # Harness: record final answer
        if self._trajectory and current_response:
            try:
                self._trajectory.record_final_answer(current_response[:500])
            except Exception:
                pass

        return current_response, all_results, current_iteration

    async def _prepare_user_turn(
        self,
        user_message: str,
        image_data: Optional[List[bytes]] = None,
        file_contents: Optional[List[str]] = None,
    ) -> Tuple[Optional[AgentResponse], str]:
        user_message, blocked = await self._apply_user_prompt_hooks(user_message)
        if blocked:
            return AgentResponse(content=f"Blocked: {blocked}"), user_message

        user_content = user_message
        if file_contents:
            file_section = "\n\n".join(f"[File {i+1}]\n{fc}" for i, fc in enumerate(file_contents))
            user_content = f"{file_section}\n\n---\n\n{user_message}"
        msg_kwargs: Dict[str, Any] = {}
        if image_data:
            msg_kwargs["images"] = image_data
        self._context.add_message("user", user_content, **msg_kwargs)
        return None, user_message

    async def process(self, user_message: str, image_data: Optional[List[bytes]] = None,
                      file_contents: Optional[List[str]] = None) -> AgentResponse:
        start_time = time.time()
        self._running, self._cancelled = True, False
        self._last_response = None
        try:
            early, user_message = await self._prepare_user_turn(
                user_message, image_data, file_contents,
            )
            if early is not None:
                self._last_response = early
                return early

            compression = await self._context.compress(self._model)
            was_compressed = compression != CompressionLevel.NONE
            messages = self._build_messages()
            response, tool_calls = await self._call_model_with_client(messages)
            all_tool_results: List[ToolCallResult] = []
            iterations = 1
            if tool_calls:
                response, all_tool_results, iterations = await self._run_tool_loop(
                    user_message, response, tool_calls, iterations)
            else:
                # No tool calls — store the plain assistant response
                self._context.add_message("assistant", response)
            if self._memory and MemoryManager is not None:
                try:
                    asyncio.create_task(self._save_memory_background(user_message, response))
                except Exception:
                    pass
            elapsed = time.time() - start_time
            agent_response = AgentResponse(
                content=response, tool_calls=all_tool_results, iterations=iterations,
                total_time=elapsed, compressed=was_compressed,
                checkpoint_id=self._checkpoint.get_latest() or "",
            )
            self._last_response = agent_response
            return agent_response
        except Exception as e:
            logger.error(f"Agent process error: {e}")
            agent_response = AgentResponse(
                content=f"Error: {type(e).__name__}", total_time=time.time() - start_time,
            )
            self._last_response = agent_response
            return agent_response
        finally:
            self._running = False
            await self._finalize_stop_hooks()

    # ============================================================
    # run_turn helpers
    # ============================================================
    # The streaming entrypoint used to be a single ~400-line async
    # generator. The body is now split into focused helpers
    # (``_maybe_route_to_orchestrator_events``,
    # ``_do_streaming_turn_events``, ``_non_streaming_turn_events``)
    # so each step (orchestrator routing, stream consumption,
    # follow-up summarization) is testable in isolation. ``run_turn``
    # itself is the only public entry point and wires the helpers
    # together.

    @staticmethod
    def _accumulate_tool_calls(
        delta_tool_calls: Any,
        accumulator: Dict[int, Dict[str, Any]],
    ) -> None:
        """Accumulate streamed ``tool_calls`` deltas into the slot dict.

        OpenAI streams tool_calls in pieces: ``index``, ``id``,
        ``function.name``, ``function.arguments``. This helper handles
        the incremental assembly for both the main response stream and
        the follow-up summary stream. The accumulator is mutated in
        place; each index maps to ``{id, name, arguments}``.
        """
        if not delta_tool_calls:
            return
        for tc_delta in delta_tool_calls:
            idx = tc_delta.index
            if idx not in accumulator:
                accumulator[idx] = {"id": "", "name": "", "arguments": ""}
            slot = accumulator[idx]
            if tc_delta.id:
                slot["id"] = tc_delta.id
            if tc_delta.function:
                if tc_delta.function.name:
                    slot["name"] = tc_delta.function.name
                if tc_delta.function.arguments:
                    slot["arguments"] += tc_delta.function.arguments

    @staticmethod
    def _extract_usage(chunk: Any) -> Tuple[int, int, int, int]:
        """Extract token usage from a streaming chunk.

        Returns ``(input_tokens, output_tokens, cache_hit_tokens,
        cache_miss_tokens)``. Any field may be 0 — most mid-stream
        chunks don't carry usage info, and only the terminal usage-only
        chunk is guaranteed.

        ``cache_hit_tokens`` / ``cache_miss_tokens`` come from
        DeepSeek's ``usage.prompt_cache_hit_tokens`` /
        ``prompt_cache_miss_tokens`` fields (see
        https://api-docs.deepseek.com/zh-cn/guides/kv_cache/).
        Non-DeepSeek providers don't report these, so they stay 0.
        """
        u = getattr(chunk, "usage", None)
        if u is None:
            return 0, 0, 0, 0
        return (
            getattr(u, "prompt_tokens", 0) or 0,
            getattr(u, "completion_tokens", 0) or 0,
            getattr(u, "prompt_cache_hit_tokens", 0) or 0,
            getattr(u, "prompt_cache_miss_tokens", 0) or 0,
        )

    @staticmethod
    def _finalize_streamed_calls(
        streamed: Dict[int, Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Convert accumulated streamed tool_calls into structured dicts
        suitable for ``_run_tool_loop``.

        Each entry is normalized to ``{id, name, arguments}`` where
        ``arguments`` is a parsed dict (or ``{}`` on JSON parse error).
        A synthetic ``call_<idx>`` id is used when the stream did not
        emit one.
        """
        calls: List[Dict[str, Any]] = []
        for idx, slot in sorted(streamed.items()):
            try:
                args = json.loads(slot["arguments"]) if slot["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            calls.append({
                "id": slot["id"] or f"call_{idx}",
                "name": slot["name"],
                "arguments": args,
            })
        return calls

    # ============================================================
    # run_turn: typed event protocol (sole entry point)
    # ============================================================
    # See hakus/protocol/ for the event schema. ``run_turn`` is the
    # **only** entry point for both TUI and headless callers — it
    # yields typed :class:`AgentEvent` instances (see
    # ``hakus/protocol/events.py``). The legacy string-token
    # ``process_stream`` API was removed in the codex-style refactor.

    async def run_turn(
        self,
        user_input: str,
        op_receiver: Optional[asyncio.Queue] = None,
        image_data: Optional[List[bytes]] = None,
        file_contents: Optional[List[str]] = None,
    ) -> "AsyncIterator[AgentEvent]":
        """主入口: 消费用户输入, 发出 AgentEvent 流.

        不再 yield 字符串 token, 而是 yield 类型化 :class:`AgentEvent`
        实例. 前端通过 ``isinstance`` (或 PEP 634 ``match``) 路由到
        widget 状态变更.

        Args:
            user_input: 用户输入文本.
            op_receiver: 可选 op 队列, 用于接收 :class:`InterruptOp`
                / :class:`ApprovalOp` / :class:`FollowUpOp`. 如果为
                None, 仍然用 ``self._cancelled`` 旧 bool 路径, 保证
                旧非-TUI 调用点不破.
            image_data, file_contents: 用户输入的多模态/附件.

        Yields:
            :class:`AgentEvent` 实例. 事件类型在
            :mod:`hakus.protocol.events` 中定义.

        Notes:
            反射 (Reflection*) 事件暂不 emit, 见 spec 第 3.7 节.
        """
        # Lazy imports — break circular deps with hakus.protocol
        from .protocol import (
            AgentEvent,
            Cancelled as CancelledEvent,
            TextDelta,
            TokenUsage,
            ToolCallFinished,
            TurnCompleted,
            TurnFailed,
            TurnStarted,
            ActivityChanged,
            OrchestratorPhaseChanged,
        )

        # Local helper: poll op_receiver for InterruptOp without blocking
        async def _check_interrupt() -> Optional[str]:
            return await _check_op_interrupt(
                op_receiver, self._cancelled, self._interrupt_reason,
            )

        self._running = True
        self._cancelled = False
        self._interrupt_reason: Optional[str] = None
        self._last_response = None
        # 重置每 turn 的状态 (trae-agent 风格: 每次 execute_task 重新初始化)
        self._task_done = False
        self._steps.clear()
        self._current_step = None
        turn_id = f"turn_{int(time.time() * 1000)}"
        model_name = getattr(self._model, "model_name", self._model_type)

        # ── Debug: begin turn ──
        _dbg = _get_dbg()
        if _dbg:
            _dbg.begin_turn(user_input)

        # Always emit TurnStarted at the entry
        yield TurnStarted(turn_id=turn_id, model=str(model_name))

        # ── P1: Turn start hook (Rollout, WorldState, etc.) ──
        if self._p1:
            self._p1.hook_turn_start(user_message=user_input)

        accumulated_text = ""  # For partial_content on cancel
        all_tool_results: List[ToolCallResult] = []
        turn_failed = False
        turn_failed_code = "unknown"
        turn_failed_msg = ""
        turn_completed = False
        input_tokens_total = 0
        output_tokens_total = 0
        cache_hit_tokens_total = 0
        cache_miss_tokens_total = 0
        compressed_flag = False
        iterations_total = 0

        try:
            # 0) Check for ResumeOp at the start of the turn.
            #    The frontend may push a ResumeOp into the op_receiver
            #    to trigger checkpoint recovery without requiring the
            #    user to type "/resume".
            if op_receiver is not None:
                from .protocol import ResumeOp
                try:
                    first_op = op_receiver.get_nowait()
                except asyncio.QueueEmpty:
                    first_op = None
                if isinstance(first_op, ResumeOp):
                    workspace_dir = first_op.workspace_dir or None
                    async for resume_event in self._stream_resume_orchestrator_events(
                        workspace_dir, op_receiver,
                    ):
                        yield resume_event
                        if isinstance(resume_event, TokenUsage):
                            input_tokens_total += resume_event.input_tokens
                            output_tokens_total += resume_event.output_tokens
                            cache_hit_tokens_total += getattr(resume_event, "cache_hit_tokens", 0)
                            cache_miss_tokens_total += getattr(resume_event, "cache_miss_tokens", 0)
                        if isinstance(resume_event, TurnCompleted):
                            self._last_response = AgentResponse(
                                content=resume_event.content,
                                iterations=resume_event.iterations,
                                total_time=resume_event.total_time,
                                input_tokens=resume_event.input_tokens,
                                output_tokens=resume_event.output_tokens,
                                compressed=resume_event.compressed,
                            )
                    return
                elif first_op is not None:
                    # Not a ResumeOp — put it back for later consumption
                    try:
                        op_receiver.put_nowait(first_op)
                    except asyncio.QueueFull:
                        logger.warning("op_receiver full when requeueing op")

            # 1) User-turn prep
            early, user_input = await self._prepare_user_turn(
                user_input, image_data, file_contents,
            )
            if early is not None:
                self._last_response = early
                yield TurnCompleted(
                    content=early.content,
                    tool_calls=tuple(),
                    iterations=0,
                    total_time=0.0,
                    input_tokens=0,
                    output_tokens=0,
                )
                return

            # Handle /resume command for checkpoint recovery (streaming)
            if user_input.strip().startswith("/resume"):
                parts = user_input.strip().split(maxsplit=1)
                workspace_dir = parts[1].strip() if len(parts) > 1 else None
                async for resume_event in self._stream_resume_orchestrator_events(
                    workspace_dir, op_receiver,
                ):
                    yield resume_event
                    if isinstance(resume_event, TokenUsage):
                        input_tokens_total += resume_event.input_tokens
                        output_tokens_total += resume_event.output_tokens
                        cache_hit_tokens_total += getattr(resume_event, "cache_hit_tokens", 0)
                        cache_miss_tokens_total += getattr(resume_event, "cache_miss_tokens", 0)
                    if isinstance(resume_event, TurnCompleted):
                        self._last_response = AgentResponse(
                            content=resume_event.content,
                            iterations=resume_event.iterations,
                            total_time=resume_event.total_time,
                            input_tokens=resume_event.input_tokens,
                            output_tokens=resume_event.output_tokens,
                            compressed=resume_event.compressed,
                        )
                return

            # 2) Orchestrator routing — emit AgentEvent directly
            async for orch_event in self._maybe_route_to_orchestrator_events(
                user_input, op_receiver,
            ):
                yield orch_event
                # Track token usage from orchestrator events
                if isinstance(orch_event, TokenUsage):
                    input_tokens_total += orch_event.input_tokens
                    output_tokens_total += orch_event.output_tokens
                    cache_hit_tokens_total += getattr(orch_event, "cache_hit_tokens", 0)
                    cache_miss_tokens_total += getattr(orch_event, "cache_miss_tokens", 0)
                # Track terminal events from orchestrator
                if isinstance(orch_event, TurnCompleted):
                    turn_completed = True
                    iterations_total = orch_event.iterations
                    compressed_flag = orch_event.compressed
                    cache_hit_tokens_total += getattr(orch_event, "cache_hit_tokens", 0)
                    cache_miss_tokens_total += getattr(orch_event, "cache_miss_tokens", 0)
                    # Capture last_response for downstream consumers
                    self._last_response = AgentResponse(
                        content=orch_event.content,
                        iterations=orch_event.iterations,
                        total_time=orch_event.total_time,
                        input_tokens=orch_event.input_tokens,
                        output_tokens=orch_event.output_tokens,
                        compressed=orch_event.compressed,
                    )
                # Check for cancellation between orchestrator events
                reason = await _check_interrupt()
                if reason:
                    self._interrupt_reason = reason
                    break

            if self._orchestrator_handled:
                # Orchestrator handled the turn — it already emitted
                # its own terminal event (TurnCompleted / TurnFailed /
                # Cancelled).  Just return.
                return

            if self._interrupt_reason:
                # Cancelled during orchestrator
                yield CancelledEvent(
                    reason=self._interrupt_reason,
                    partial_content=accumulated_text,
                )
                return

            # 3) Compress + build messages
            # ── P1: Pre-turn compression hook ──
            if self._p1:
                try:
                    raw_messages = self._build_messages()
                    budget = self._context.budget
                    compressed_msgs, comp_metrics = await self._p1.hook_pre_compress(
                        raw_messages, budget,
                    )
                    if comp_metrics and comp_metrics.after_tokens < comp_metrics.before_tokens:
                        messages = compressed_msgs
                        compressed_flag = True
                    else:
                        compression = await self._context.compress(self._model)
                        compressed_flag = compression != CompressionLevel.NONE
                        messages = self._build_messages()
                except Exception as e:
                    logger.warning(f"P1 pre_compress hook failed, falling back: {e}")
                    compression = await self._context.compress(self._model)
                    compressed_flag = compression != CompressionLevel.NONE
                    messages = self._build_messages()
            else:
                compression = await self._context.compress(self._model)
                compressed_flag = compression != CompressionLevel.NONE
                messages = self._build_messages()

            # ── P1: WorldState build_messages hook ──
            if self._p1:
                try:
                    ws_messages, ws_cache_info = self._p1.hook_build_messages([])
                    if ws_cache_info and ws_cache_info.cache_hit_rate > 0:
                        logger.debug(
                            f"P1 WorldState cache: {ws_cache_info.cache_hit_rate:.1%} "
                            f"({ws_cache_info.cached_tokens}/{ws_cache_info.total_tokens} tokens)"
                        )
                except Exception as e:
                    logger.debug(f"P1 WorldState hook skipped: {e}")

            # ── Debug: log messages to API ──
            _dbg = _get_dbg()
            if _dbg:
                stats = self._context.get_stats()
                _dbg.log_context_state(
                    "pre-stream", stats["total_tokens"], stats["budget"],
                    stats["messages_length"], stats["compression_level"],
                    stats["compression_count"], stats["circuit_breaker"],
                )
                _dbg.log_messages_to_api(
                    messages, stats["total_tokens"], stats["budget"],
                )

            # 4) Streaming turn (or non-streaming fallback)
            if self._get_oa_client() is not None:
                try:
                    async for ev in self._do_streaming_turn_events(
                        user_input, messages, op_receiver,
                    ):
                        if isinstance(ev, TextDelta):
                            accumulated_text += ev.text
                        elif isinstance(ev, TokenUsage):
                            input_tokens_total += ev.input_tokens
                            output_tokens_total += ev.output_tokens
                            cache_hit_tokens_total += getattr(ev, "cache_hit_tokens", 0)
                            cache_miss_tokens_total += getattr(ev, "cache_miss_tokens", 0)
                        elif isinstance(ev, ToolCallFinished):
                            all_tool_results.append(
                                ToolCallResult(
                                    tool_name=ev.name,
                                    arguments=ev.arguments,
                                    result=ev.result,
                                    success=ev.success,
                                    execution_time=ev.duration,
                                )
                            )
                        elif isinstance(ev, TurnCompleted):
                            turn_completed = True
                            input_tokens_total += ev.input_tokens
                            output_tokens_total += ev.output_tokens
                            cache_hit_tokens_total += getattr(ev, "cache_hit_tokens", 0)
                            cache_miss_tokens_total += getattr(ev, "cache_miss_tokens", 0)
                            iterations_total = ev.iterations
                            compressed_flag = ev.compressed
                        yield ev
                        if isinstance(ev, (CancelledEvent, TurnFailed, TurnCompleted)):
                            if isinstance(ev, CancelledEvent):
                                return  # Already yielded
                            elif isinstance(ev, TurnFailed):
                                turn_failed = True
                                turn_failed_code = ev.code
                                turn_failed_msg = ev.error
                                return  # Already yielded
                            else:  # TurnCompleted
                                return  # Already yielded
                except Exception as e:
                    logger.warning(
                        f"Streaming failed, falling back to non-streaming: {e}"
                    )
                    yield ActivityChanged(phase="thinking", detail="回退到非流式")
                    # Fall through to non-streaming path below
                    self._cancelled = False
                    self._interrupt_reason = None
                    async for ev in self._non_streaming_turn_events(
                        user_input, messages, op_receiver,
                    ):
                        if isinstance(ev, TextDelta):
                            accumulated_text += ev.text
                        elif isinstance(ev, TokenUsage):
                            input_tokens_total += ev.input_tokens
                            output_tokens_total += ev.output_tokens
                        elif isinstance(ev, ToolCallFinished):
                            all_tool_results.append(
                                ToolCallResult(
                                    tool_name=ev.name,
                                    arguments=ev.arguments,
                                    result=ev.result,
                                    success=ev.success,
                                    execution_time=ev.duration,
                                )
                            )
                        yield ev
                        if isinstance(ev, (CancelledEvent, TurnFailed, TurnCompleted)):
                            if isinstance(ev, CancelledEvent):
                                return
                            elif isinstance(ev, TurnFailed):
                                turn_failed = True
                                turn_failed_code = ev.code
                                turn_failed_msg = ev.error
                                return
                            else:
                                return
            else:
                # No OpenAI client — use non-streaming path
                async for ev in self._non_streaming_turn_events(
                    user_input, messages, op_receiver,
                ):
                    if isinstance(ev, TextDelta):
                        accumulated_text += ev.text
                    elif isinstance(ev, TokenUsage):
                        input_tokens_total += ev.input_tokens
                        output_tokens_total += ev.output_tokens
                    elif isinstance(ev, ToolCallFinished):
                        all_tool_results.append(
                            ToolCallResult(
                                tool_name=ev.name,
                                arguments=ev.arguments,
                                result=ev.result,
                                success=ev.success,
                                execution_time=ev.duration,
                            )
                        )
                    yield ev
                    if isinstance(ev, (CancelledEvent, TurnFailed, TurnCompleted)):
                        if isinstance(ev, CancelledEvent):
                            return
                        elif isinstance(ev, TurnFailed):
                            turn_failed = True
                            turn_failed_code = ev.code
                            turn_failed_msg = ev.error
                            return
                        else:
                            return

            # Normal completion — emit TurnCompleted
            elapsed = 0.0
            yield TurnCompleted(
                content=accumulated_text,
                tool_calls=tuple(self._tc_to_dict(tc) for tc in all_tool_results),
                iterations=iterations_total or 1,
                total_time=elapsed,
                input_tokens=input_tokens_total,
                output_tokens=output_tokens_total,
                cache_hit_tokens=cache_hit_tokens_total,
                cache_miss_tokens=cache_miss_tokens_total,
                compressed=compressed_flag,
            )
        except asyncio.CancelledError:
            yield CancelledEvent(reason="asyncio_cancelled", partial_content=accumulated_text)
        except Exception as e:
            import traceback as _tb
            logger.error(f"run_turn error: {e}\n{_tb.format_exc()}")
            yield TurnFailed(
                code="model_error",
                error=f"{type(e).__name__}: {e}",
            )
        finally:
            self._running = False
            # ── P1: Turn end hook ──
            if self._p1:
                try:
                    if turn_failed:
                        self._p1.hook_turn_failed(
                            error=turn_failed_msg, code=turn_failed_code,
                        )
                    else:
                        elapsed_ms = int(elapsed * 1000) if 'elapsed' in dir() else 0
                        self._p1.hook_turn_end(
                            response=accumulated_text[:500] if accumulated_text else "",
                            input_tokens=input_tokens_total,
                            output_tokens=output_tokens_total,
                            tool_calls_count=len(all_tool_results),
                            duration_ms=elapsed_ms,
                            compressed=compressed_flag,
                        )
                except Exception as e:
                    logger.debug(f"P1 turn_end hook failed: {e}")
            # Schedule stop hooks asynchronously to avoid GeneratorExit issues
            # when the async generator is closed prematurely by TUI
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(self._finalize_stop_hooks())
                else:
                    await self._finalize_stop_hooks()
            except Exception:
                pass
            # ── Debug: end turn ──
            _dbg = _get_dbg()
            if _dbg:
                summary = (
                    f"in={input_tokens_total} out={output_tokens_total} "
                    f"iterations={iterations_total or 1} "
                    f"compressed={compressed_flag} "
                    f"failed={turn_failed}"
                )
                _dbg.end_turn(summary=summary)

    async def _maybe_route_to_orchestrator_events(
        self,
        user_message: str,
        op_receiver: Optional[asyncio.Queue] = None,
    ) -> "AsyncIterator[AgentEvent]":
        """Orchestrator routing with event emission.

        Yields :class:`AgentEvent` instances. When the orchestrator
        supports ``stream_execute_v2``, events are yielded directly.
        Otherwise, internal events are converted to ``TextDelta`` and
        ``OrchestratorPhaseChanged`` via the legacy path.

        On success, ``self._last_response`` is set and the caller
        should check it and stop the turn.

        Args:
            user_message: 用户输入文本.
            op_receiver: 可选 op 队列, 用于接收 :class:`PauseOp`
                等操作. 在 orchestrator 事件循环中轮询.
        """
        from .protocol import (
            AgentEvent,
            OrchestratorPhaseChanged,
            TextDelta,
        )

        self._orchestrator_handled = False
        should_route = (self.force_orchestrator
                        or self._should_use_orchestrator(user_message))
        if not should_route:
            return

        # Emit a phase change so TUI activity strip switches immediately
        yield OrchestratorPhaseChanged(phase="planning", detail="多智能体协同中")

        reason_label = ("显式 /orchestrate" if self.force_orchestrator else "复杂度评分")
        logger.info(
            f"Routing task to orchestrator ({reason_label}): "
            f"{user_message[:80]!r}"
        )
        if self._orchestrator is None:
            yield TextDelta(
                text="[Warn: 任务被识别为需要多智能体协同, "
                     "但 orchestrator 未初始化, 回退到单 agent]"
            )
            return

        # Map orchestrator event types to phase events (legacy path)
        PHASE_MAP = {
            "plan": ("planning", "计划中"),
            "dev": ("developing", "开发中"),
            "test": ("testing", "测试中"),
            "fix": ("fixing", "修复中"),
            "final_test": ("final_testing", "终验中"),
            "completed": ("completed", "完成"),
            "error": ("failed", "失败"),
        }

        try:
            # Use stream_execute_v2 which yields AgentEvent protocol events
            if hasattr(self._orchestrator, 'stream_execute_v2'):
                async for agent_event in self._orchestrator.stream_execute_v2(user_message):
                    yield agent_event
                    # Poll op_receiver for PauseOp between events
                    if op_receiver is not None:
                        try:
                            op = op_receiver.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        else:
                            from .protocol import PauseOp
                            if isinstance(op, PauseOp):
                                logger.info("PauseOp received — pausing orchestrator")
                                self._orchestrator.pause()
                                yield OrchestratorPhaseChanged(
                                    phase="paused",
                                    detail="长时任务已暂停，检查点已保存",
                                )
                                yield TextDelta(
                                    text="\n\n⏸ 长时任务已暂停。使用 `/resume` 恢复。\n"
                                )
                                # The orchestrator's _cancelled flag is now
                                # True, so stream_execute_v2 will wind down
                                # and emit its own terminal event shortly.
                            else:
                                # Not for us — put it back
                                try:
                                    op_receiver.put_nowait(op)
                                except asyncio.QueueFull:
                                    logger.warning("op_receiver full when requeueing op")
            else:
                # Fallback for old orchestrator without stream_execute_v2
                current_phase = "planning"
                async for ev in self._orchestrator.stream_execute(user_message):
                    line = self._format_orchestrator_event(ev)
                    # Detect phase transitions
                    new_phase = None
                    matched_detail = ""
                    for ev_type, (phase_val, detail_val) in PHASE_MAP.items():
                        if ev.type == ev_type:
                            new_phase = phase_val
                            matched_detail = detail_val
                            break
                    if new_phase and new_phase != current_phase:
                        current_phase = new_phase
                        yield OrchestratorPhaseChanged(phase=new_phase, detail=matched_detail or "多智能体协同中")
                    if line:
                        yield TextDelta(text=line)
                    if ev.type == "error":
                        self._orchestrator_handled = True
                        return
                    # Poll op_receiver for PauseOp (legacy path)
                    if op_receiver is not None:
                        try:
                            op = op_receiver.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        else:
                            from .protocol import PauseOp
                            if isinstance(op, PauseOp):
                                logger.info("PauseOp received — pausing orchestrator (legacy)")
                                self._orchestrator.pause()
                                yield OrchestratorPhaseChanged(
                                    phase="paused",
                                    detail="长时任务已暂停，检查点已保存",
                                )
                                yield TextDelta(
                                    text="\n\n⏸ 长时任务已暂停。使用 `/resume` 恢复。\n"
                                )
                            else:
                                try:
                                    op_receiver.put_nowait(op)
                                except asyncio.QueueFull:
                                    logger.warning("op_receiver full when requeueing op")
            self._orchestrator_handled = True
        except Exception as e:
            logger.warning(f"Orchestrator failed, falling back: {e}")
            yield TextDelta(text=f"\n[Orchestrator 失败: {e}, 回退单 agent]\n")

    async def _do_streaming_turn_events(
        self,
        user_message: str,
        messages: List[Dict[str, Any]],
        op_receiver: Optional[asyncio.Queue] = None,
    ) -> "AsyncIterator[AgentEvent]":
        """codex-rs ``submission_loop`` 风格的单流循环.

        与旧版的核心区别 (codex-style 重构):

        - **每轮一个 stream**: 不再有"主回复流 + 总结流 + 最终总结流"
          三段式;一个 turn 内最多 ``_max_iterations`` 个 stream,每个
          stream 都是同一个对话的下一轮.
        - **工具 inline 执行**: 检测到 ``tool_calls`` 后立即执行,把
          结果以 ``role: tool`` + ``tool_call_id`` 写回 context,然后
          ``continue`` 到下一轮. 不再有"总结流".
        - **无递归重入**: 旧版的 ``if stray_calls: async for ev in
          self._do_streaming_turn_events(...)`` 完全删除 — 单层 while
          循环,state 一致性靠"每轮先写 context, 再 yield event"保证.
        - **token 累加**: 跨轮累加 input/output tokens,在最终的
          ``TurnCompleted`` 一次性给出.
        - **错误隔离**: 工具失败不中断 turn — 通过
          ``ToolCallFinished(success=False, ...)`` 让模型自行决定
          fallback,而不是 TurnFailed.

        Args:
            user_message: 用户原始输入 (用于 tool 执行的 user_message
                透传,不影响 streaming 本身).
            messages: 已构建的 messages 列表 (传入仅为兼容旧 API,
                内部会重新调 ``_build_messages`` 以反映每轮写入的
                tool 结果).
            op_receiver: 可选 op 队列,接收 :class:`InterruptOp` 等.

        Yields:
            :class:`AgentEvent` 序列: ``TurnStarted`` 已在调用方 yield,
            这里是 ``TextDelta`` / ``TokenUsage`` / ``ToolCallStarted``
            / ``ToolCallFinished`` / 终止事件.
        """
        from .protocol import (
            Cancelled as CancelledEvent,
            QuestionAsked,
            TextDelta,
            TokenUsage,
            ToolCallFinished,
            ToolCallStarted,
            TurnCompleted,
            TurnFailed,
            PatchApplied,
        )

        async def _check_interrupt() -> Optional[str]:
            return await _check_op_interrupt(
                op_receiver, self._cancelled, self._interrupt_reason,
            )

        # Initialize harness components for this turn
        if self._harness_enabled:
            try:
                self._trajectory = TrajectoryRecorder(turn_id=f"turn_{id(self)}")
                self._harness_guard = HarnessGuard(
                    max_iterations=self._max_iterations,
                    max_context_pct=80,
                )
                self._trajectory.start()
            except Exception:
                self._trajectory = None
                self._harness_guard = None

        in_tok_total = 0
        out_tok_total = 0
        cache_hit_total = 0
        cache_miss_total = 0
        all_tool_results: List[ToolCallResult] = []
        final_text = ""

        try:
            for iteration in range(self._max_iterations):
                self._current_iteration = iteration
                # #region debug-point D:iteration-start
                _debug_log("D", "agent.py:_do_streaming_turn_events", "iteration start", {"iteration": iteration, "max_iterations": self._max_iterations})
                # #endregion
                # Harness: increment iteration counter
                if self._harness_guard:
                    try:
                        self._harness_guard.increment_iteration()
                    except Exception:
                        pass
                # ── Debug: iteration start ──
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_iteration_start(
                        iteration, self._max_iterations,
                        len(self._context._messages),
                        self._context._total_estimated_tokens(),
                        self._context.budget,
                    )

                # 1) Interruption check (cheap, per-iteration)
                interrupt_reason = await _check_interrupt()
                if interrupt_reason:
                    self._interrupt_reason = interrupt_reason
                    yield CancelledEvent(
                        reason=interrupt_reason,
                        partial_content=final_text,
                    )
                    return

                # 2) Soft stop check - inject summary prompt when approaching limit
                #    Only inject once to avoid context pollution
                if (iteration >= self._soft_stop_threshold and 
                    iteration < self._max_iterations and
                    not getattr(self, '_soft_stop_injected', False)):
                    self._soft_stop_injected = True
                    logger.info(f"Iteration {iteration}/{self._max_iterations} - injecting soft stop prompt")
                    _dbg = _get_dbg()
                    if _dbg:
                        _dbg.log_raw(f"\n  [SOFT STOP] Iteration {iteration}, injecting summary prompt\n")
                    # Add soft stop prompt to guide LLM to wrap up
                    self._context.add_user_message(SOFT_STOP_PROMPT)

                # 3) Update context monitor with current token count
                try:
                    current_tokens = self._context._total_estimated_tokens()
                    self._context_monitor.update(current_tokens)
                    
                    # Check context overflow
                    if self._context_monitor.is_overflow_critical():
                        logger.warning(f"Context at {self._context_monitor.get_usage_percentage():.0%} - critical overflow")
                        _dbg = _get_dbg()
                        if _dbg:
                            _dbg.log_raw(f"\n  [CONTEXT OVERFLOW] {self._context_monitor.get_usage_percentage():.0%} used, forcing turn end\n")
                        summary = final_text or "Context limit reached. Here's a summary of what I've found so far."
                        yield TurnCompleted(
                            content=summary,
                            tool_calls=tuple(self._tc_to_dict(tc) for tc in all_tool_results),
                            iterations=iteration + 1,
                            total_time=0.0,
                            input_tokens=in_tok_total,
                            output_tokens=out_tok_total,
                            cache_hit_tokens=cache_hit_total,
                            cache_miss_tokens=cache_miss_total,
                        )
                        self._last_response = AgentResponse(
                            content=summary,
                            input_tokens=in_tok_total,
                            output_tokens=out_tok_total,
                        )
                        return
                except Exception:
                    pass

                # 4) Auto-save snapshot every N iterations for recovery
                try:
                    if (iteration - self._last_snapshot_iteration >= self._snapshot_interval and 
                        iteration > 0):
                        snapshot = SessionSnapshot(
                            session_id=self._session_id,
                            iteration=iteration,
                            messages=self._context._messages.copy(),
                            tool_states={},  # Tool states are tracked in context
                            context_tokens=self._context._total_estimated_tokens(),
                            timestamp=time.time(),
                            metadata={"iteration": iteration, "auto_save": True},
                        )
                        self._recovery_manager.save_snapshot(snapshot)
                        self._last_snapshot_iteration = iteration
                        _dbg = _get_dbg()
                        if _dbg:
                            _dbg.log_raw(f"\n  [SNAPSHOT] Auto-saved at iteration {iteration}\n")
                except Exception as e:
                    logger.warning(f"Failed to save snapshot: {e}")

                # 5) Re-build messages (reflects the tool results we
                #    persisted at the end of the previous iteration)
                await self._context.compress(self._model)
                messages = self._build_messages()
                # Mode whitelist: if set, only send schemas for tools
                # the current run mode allows. See `set_run_mode()`.
                _allowed = self._allowed_tool_names()
                if _allowed is not None:
                    tool_schemas = self._tool_registry.get_schemas(_allowed) or None
                else:
                    tool_schemas = self._tool_registry.get_schemas(
                        self._tool_registry.list_tools()
                    ) or None

                # ── Debug: log messages for this iteration ──
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_messages_to_api(
                        messages,
                        self._context._total_estimated_tokens(),
                        self._context.budget,
                    )

                # 3) ONE stream call. If it raises, we surface as
                #    TurnFailed and stop — never silently fall through
                #    to a "summary" stream (the legacy bug).
                #    In TUI mode, _create_stream proactively delegates
                #    to _create_stream_isolated, so event-loop
                #    RuntimeErrors are prevented entirely.
                try:
                    _dbg = _get_dbg()
                    if _dbg:
                        _dbg.log_raw(f"\n  [ITERATION {iteration}] Creating stream (llm_timeout={self._llm_timeout}s)\n")
                    main_stream = await self._create_stream_with_retry(
                        messages=messages,
                        tools=tool_schemas,
                        timeout=self._llm_timeout,
                        max_retries=3,
                    )
                    if _dbg:
                        _dbg.log_raw(f"\n  [ITERATION {iteration}] Stream created, starting iteration\n")
                except Exception as e:
                    logger.error(f"无法创建流 ({type(e).__name__}): {e}")
                    _dbg = _get_dbg()
                    if _dbg:
                        _dbg.log_raw(f"\n  [ERROR] Stream creation failed: {type(e).__name__}: {e}\n")
                    yield TurnFailed(
                        code="stream_create_failed",
                        error=f"{type(e).__name__}: {e}",
                    )
                    return

                full_response = ""
                _dsml_emitted_offset = 0  # reset DSML filter state for new turn
                streamed_tc: Dict[int, Dict[str, Any]] = {}
                timed_out = False
                cancelled_mid_stream = False
                cancel_reason = ""
                stream_finish_reason = ""  # captured from last chunk

                # Stream iteration. In TUI mode, _create_stream
                # delegates to _create_stream_isolated which runs
                # in a separate thread, so event-loop RuntimeErrors
                # are prevented entirely.
                try:
                    async for chunk in _iter_with_timeout(
                        main_stream, timeout=self._llm_timeout,
                        label="主回复流",
                    ):
                        # Per-chunk interrupt
                        interrupt_reason = await _check_interrupt()
                        if interrupt_reason:
                            cancelled_mid_stream = True
                            cancel_reason = interrupt_reason
                            break
                        in_t, out_t, cache_hit_t, cache_miss_t = self._extract_usage(chunk)
                        if in_t or out_t:
                            in_tok_total += in_t
                            out_tok_total += out_t
                            cache_hit_total += cache_hit_t
                            cache_miss_total += cache_miss_t
                            # Calibrate token estimation with actual API usage
                            if in_t:
                                try:
                                    self._context.calibrate_tokens(in_tok_total)
                                except Exception:
                                    pass
                            # ── Debug: token usage ──
                            _dbg = _get_dbg()
                            if _dbg:
                                _dbg.log_token_usage(
                                    in_t, out_t, in_tok_total, out_tok_total,
                                )
                            yield TokenUsage(
                                input_tokens=in_t,
                                output_tokens=out_t,
                                cache_hit_tokens=cache_hit_t,
                                cache_miss_tokens=cache_miss_t,
                            )
                        if not chunk.choices:
                            continue
                        delta = chunk.choices[0].delta
                        # Capture finish_reason from the stream (typically
                        # set on the last chunk). Used after the loop to
                        # detect truncation (finish_reason="length").
                        _fr = getattr(chunk.choices[0], "finish_reason", None)
                        if _fr:
                            stream_finish_reason = _fr
                        if delta.content:
                            full_response += delta.content
                            cleaned = _strip_dsml_xml(
                                delta.content, full_response,
                            )
                            if cleaned:
                                yield TextDelta(text=cleaned)
                        if getattr(delta, "tool_calls", None):
                            self._accumulate_tool_calls(
                                delta.tool_calls, streamed_tc,
                            )
                            for tc_delta in delta.tool_calls:
                                slot = streamed_tc.get(tc_delta.index, {})
                                if tc_delta.id and slot.get("_emitted") is not True:
                                    slot["_emitted"] = True
                                    try:
                                        args = json.loads(
                                            slot.get("arguments", "") or "{}"
                                        )
                                    except json.JSONDecodeError:
                                        args = {}
                                    yield ToolCallStarted(
                                        call_id=tc_delta.id,
                                        name=tc_delta.function.name or slot.get("name", ""),
                                        arguments=args,
                                    )
                except asyncio.TimeoutError:
                    logger.error(
                        f"主回复流超时 ({self._llm_timeout:.0f}s). "
                        "可能是模型 API 卡住, 请重试."
                    )
                    yield TurnFailed(
                        code="timeout",
                        error=f"模型响应超时 ({self._llm_timeout:.0f}秒). "
                              f"请重试, 或检查网络/切换模型.",
                    )
                    timed_out = True

                if timed_out:
                    self._last_response = AgentResponse(
                        content="[Error: 模型响应超时]",
                    )
                    return

                if cancelled_mid_stream:
                    yield CancelledEvent(
                        reason=cancel_reason,
                        partial_content=full_response,
                    )
                    self._interrupt_reason = cancel_reason
                    return

                final_text = full_response

                # Harness: record model thought
                if self._trajectory and full_response:
                    try:
                        self._trajectory.record_thought(full_response[:500])
                    except Exception:
                        pass

                # 4) Persist assistant message WITH tool_calls (atomic
                #    state write — even if the next step fails, the
                #    model can resume from this point).
                api_tool_calls = self._convert_to_api_tool_calls(
                    self._finalize_streamed_calls(streamed_tc),
                )

                # ── Debug: log API response ──
                _dbg = _get_dbg()
                if _dbg:
                    _dbg.log_api_response(
                        text=full_response,
                        tool_calls=api_tool_calls,
                        finish_reason=getattr(
                            chunk.choices[0] if chunk and chunk.choices else None,
                            "finish_reason", ""
                        ) if 'chunk' in dir() else "",
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                    )

                self._context.add_assistant_with_tool_calls(
                    full_response, api_tool_calls,
                )

                # 5) No tool calls → turn done. Final text is the
                #    assistant's last response.
                if not api_tool_calls:
                    # ── Diagnostic: why did the turn end without tool calls?
                    #    This helps surface two common failure modes:
                    #    (a) finish_reason="length" → response was truncated
                    #        by max_tokens before tool_calls could be emitted.
                    #    (b) finish_reason="stop" with short text → the model
                    #        chose to respond conversationally instead of
                    #        using tools (common with "flash"/small models).
                    if stream_finish_reason == "length":
                        logger.warning(
                            f"Turn ended with finish_reason='length' (truncated). "
                            f"The model's response was cut off at max_tokens before "
                            f"it could emit tool calls. Consider increasing max_tokens "
                            f"or using a model with better tool-calling support. "
                            f"Response so far ({len(full_response)} chars): "
                            f"{full_response[:200]!r}"
                        )
                    elif stream_finish_reason == "stop" and len(full_response) < 500:
                        # Short conversational response with no tool calls —
                        # the model is likely acknowledging the request without
                        # actually acting on it. This is a model capability issue,
                        # not a code bug. Log it so the user can diagnose.
                        logger.warning(
                            f"Turn ended with finish_reason='stop' but no tool calls "
                            f"and only {len(full_response)} chars of text. The model "
                            f"('{self._model_type}') may lack tool-calling capability. "
                            f"Response: {full_response[:200]!r}"
                        )
                    # Harness: record final answer and finalize
                    if self._trajectory:
                        try:
                            self._trajectory.record_final_answer(full_response[:500] if full_response else "")
                            self._trajectory.stop()
                            _hdbg = _get_dbg()
                            if _hdbg:
                                evaluator = HarnessEvaluator(self._trajectory)
                                report = evaluator.full_report(context_tokens=0, context_budget=0)
                                _hdbg.log_raw(f"\n[HARNESS REPORT] score={report.overall_score:.2f} "
                                           f"loops={len(report.loops_detected)} "
                                           f"tool_accuracy={sum(a.success_rate for a in report.tool_accuracy.values())/max(1,len(report.tool_accuracy)):.2f} "
                                           f"loop_rate={report.loop_rate:.2f} "
                                           f"iteration_eff={report.iteration_efficiency:.2f}\n")
                        except Exception:
                            pass
                        self._trajectory = None
                        self._harness_guard = None
                    yield TurnCompleted(
                        content=full_response,
                        tool_calls=tuple(
                            self._tc_to_dict(tc) for tc in all_tool_results
                        ),
                        iterations=iteration + 1,
                        total_time=0.0,
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                        cache_hit_tokens=cache_hit_total,
                        cache_miss_tokens=cache_miss_total,
                    )
                    self._last_response = AgentResponse(
                        content=full_response,
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                    )
                    return

                # 5b) Context overload guard: try compression first, only
                #     force-end when compression can't keep up.
                #     Old behavior: 70% → immediate termination (caused
                #     "agent stops after running many tools" — the model
                #     never got to execute its requested tool calls).
                #     New behavior:
                #       70-89%  → trigger compression, continue executing tools
                #       >= 90%  → if still >= 90% after compression, force end
                try:
                    _est = self._context._total_estimated_tokens()
                    _bgt = self._context.budget
                    _pct = int(_est * 100 / max(1, _bgt))
                except Exception:
                    _pct = 0

                if _pct >= 70:
                    # Try compression first (non-fatal if it fails)
                    _dbg = _get_dbg()
                    if _dbg:
                        _dbg.log_raw(
                            f"\n  [OVERLOAD] Context at {_pct}%, "
                            f"attempting compression before deciding...\n"
                        )
                    try:
                        _comp_level = await self._context.compress(
                            model=self._llm_client,
                        )
                        # Re-measure after compression
                        _est2 = self._context._total_estimated_tokens()
                        _pct2 = int(_est2 * 100 / max(1, _bgt))
                        if _dbg:
                            _dbg.log_raw(
                                f"  [COMPRESS] {_pct}% → {_pct2}% "
                                f"(level={_comp_level.name})\n"
                            )
                        logger.info(
                            f"Context compressed: {_pct}% → {_pct2}% "
                            f"(level={_comp_level.name})"
                        )
                        # If compression brought us below 90%, continue
                        if _pct2 < 90:
                            _pct = _pct2  # update for downstream checks
                        else:
                            # Compression insufficient — force end
                            _pct = _pct2
                    except Exception as _comp_err:
                        logger.warning(f"Compression failed: {_comp_err}")
                        # Keep original _pct, fall through to force-end

                # Only force-end if still >= 90% after compression attempt
                if _pct >= 90:
                    _dbg = _get_dbg()
                    if _dbg:
                        _dbg.log_raw(
                            f"\n  [OVERLOAD] Context at {_pct}% after compression, "
                            f"forcing turn end (skipping {len(api_tool_calls)} tool calls)\n"
                        )
                    summary = full_response or (
                        "I've gathered enough information to provide a summary. "
                        "Let me share my analysis based on what I've found so far."
                    )
                    # Harness: record final answer and finalize
                    if self._trajectory:
                        try:
                            self._trajectory.record_final_answer(summary[:500] if summary else "")
                            self._trajectory.stop()
                            _hdbg = _get_dbg()
                            if _hdbg:
                                evaluator = HarnessEvaluator(self._trajectory)
                                report = evaluator.full_report(context_tokens=0, context_budget=0)
                                _hdbg.log_raw(f"\n[HARNESS REPORT] score={report.overall_score:.2f} "
                                           f"loops={len(report.loops_detected)} "
                                           f"tool_accuracy={sum(a.success_rate for a in report.tool_accuracy.values())/max(1,len(report.tool_accuracy)):.2f} "
                                           f"loop_rate={report.loop_rate:.2f} "
                                           f"iteration_eff={report.iteration_efficiency:.2f}\n")
                        except Exception:
                            pass
                        self._trajectory = None
                        self._harness_guard = None
                    yield TurnCompleted(
                        content=summary,
                        tool_calls=tuple(
                            self._tc_to_dict(tc) for tc in all_tool_results
                        ),
                        iterations=iteration + 1,
                        total_time=0.0,
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                        cache_hit_tokens=cache_hit_total,
                        cache_miss_tokens=cache_miss_total,
                    )
                    self._last_response = AgentResponse(
                        content=summary,
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                    )
                    return

                # 6) Execute tools. Handle ask_user specially: it pauses the
                #    turn and asks the user to choose before continuing.
                #    Other tools execute normally; ask_user runs after them so
                #    the answer can depend on any already-gathered results.
                ask_user_calls = [
                    tc for tc in api_tool_calls
                    if _name(tc).lower() == "ask_user"
                ]
                non_ask_user_calls = [
                    tc for tc in api_tool_calls
                    if _name(tc).lower() != "ask_user"
                ]
                # #region debug-point B:tool-branch
                _debug_log("B", "agent.py:_do_streaming_turn_events", "tool calls split", {"iteration": iteration, "ask_user_count": len(ask_user_calls), "non_ask_count": len(non_ask_user_calls)})
                # #endregion

                results: List[ToolCallResult] = []
                if non_ask_user_calls:
                    # #region debug-point C:batch-start
                    _debug_log("C", "agent.py:_do_streaming_turn_events", "executing non-ask tool batch", {"iteration": iteration, "count": len(non_ask_user_calls), "tools": [_name(tc) for tc in non_ask_user_calls]})
                    # #endregion
                    results = await self._execute_tool_batch(non_ask_user_calls)
                    # #region debug-point C:batch-done
                    _debug_log("C", "agent.py:_do_streaming_turn_events", "non-ask tool batch done", {"iteration": iteration, "count": len(results)})
                    # #endregion
                all_tool_results.extend(results)

                # 7) Doom Loop detection - record tool calls and check for patterns
                for tc_in, result in zip(non_ask_user_calls, results):
                    tool_name = tc_in.get("function", {}).get("name", "")
                    tool_args = self._safe_parse_args(
                        tc_in.get("function", {}).get("arguments", ""),
                    )
                    
                    # Record for doom loop detection
                    self._doom_loop_detector.record(tool_name, tool_args)
                    
                    # Check for doom loop
                    is_loop, loop_tool = self._doom_loop_detector.is_loop_detected()
                    if is_loop:
                        logger.warning(f"Doom loop detected: same call to '{loop_tool}' repeated")
                        # P5: record doom loop detection in Prometheus metrics
                        try:
                            from hakus.observability import metrics_registry
                            metrics_registry.doomloop_detected_total.inc()
                        except Exception:
                            pass
                        _dbg = _get_dbg()
                        if _dbg:
                            _dbg.log_raw(f"\n  [DOOM LOOP] Detected repeated call to '{loop_tool}', injecting break prompt\n")
                        # Inject doom loop break prompt
                        self._context.add_user_message(DOOM_LOOP_PROMPT)
                        self._doom_loop_detector.reset()
                        break  # Don't process more tools this iteration

                # 8) Emit ToolCallFinished for each result + persist
                #    the tool message into context. Order matches the
                #    order in which tool_calls were emitted.
                for tc_in, result in zip(non_ask_user_calls, results):
                    # ── Debug: log tool execution ──
                    _dbg = _get_dbg()
                    if _dbg:
                        _dbg.log_tool_execution(
                            tool_name=tc_in.get("function", {}).get("name", ""),
                            arguments=self._safe_parse_args(
                                tc_in.get("function", {}).get("arguments", ""),
                            ),
                            result=result.result,
                            success=result.success,
                            duration=result.execution_time,
                        )

                    yield ToolCallFinished(
                        call_id=tc_in.get("id", ""),
                        name=tc_in.get("function", {}).get("name", ""),
                        result=result.result,
                        success=result.success,
                        duration=result.execution_time,
                        arguments=self._safe_parse_args(
                            tc_in.get("function", {}).get("arguments", ""),
                        ),
                    )
                    self._context.add_tool_result(
                        tc_in.get("function", {}).get("name", ""),
                        result.result,
                        tool_call_id=tc_in.get("id", ""),
                    )

                    # Emit PatchApplied event for file changes
                    tool_name_lower = (tc_in.get("function", {}).get("name", "") or "").lower()
                    if tool_name_lower in ("write_file", "write") and result.success:
                        try:
                            import difflib
                            args = self._safe_parse_args(
                                tc_in.get("function", {}).get("arguments", ""),
                            )
                            path = args.get("path", "")
                            new_content = args.get("content", "")
                            # Try to read old content for diff
                            old_content = ""
                            try:
                                if os.path.exists(path):
                                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                                        old_content = f.read()
                            except Exception:
                                pass
                            diff = "".join(difflib.unified_diff(
                                old_content.splitlines(keepends=True),
                                new_content.splitlines(keepends=True),
                                fromfile=f"a/{path}",
                                tofile=f"b/{path}",
                            ))
                            yield PatchApplied(
                                path=path,
                                diff=diff,
                                old_content=old_content,
                                new_content=new_content,
                            )
                        except Exception:
                            pass
                    elif tool_name_lower in ("edit_file", "edit") and result.success:
                        try:
                            import difflib
                            args = self._safe_parse_args(
                                tc_in.get("function", {}).get("arguments", ""),
                            )
                            path = args.get("path", "")
                            old_str = args.get("old_str", "")
                            new_str = args.get("new_str", "")
                            # For edit_file, we construct the diff from old_str and new_str
                            diff = "".join(difflib.unified_diff(
                                old_str.splitlines(keepends=True),
                                new_str.splitlines(keepends=True),
                                fromfile=f"a/{path}",
                                tofile=f"b/{path}",
                            ))
                            yield PatchApplied(
                                path=path,
                                diff=diff,
                                old_content=old_str,
                                new_content=new_str,
                            )
                        except Exception:
                            pass

                # 8b) ask_user: pause the turn and ask the user to choose.
                #     We yield QuestionAsked, wait for AnswerOp on the
                #     op_receiver, then persist the answer as a tool result.
                for ask_call in ask_user_calls:
                    ask_args = _args(ask_call)
                    question_id = str(uuid.uuid4())
                    question = ask_args.get("question", "")
                    options = tuple(ask_args.get("options", []))
                    allow_free_text = bool(ask_args.get("allow_free_text", False))
                    # #region debug-point B:ask-user-start
                    _debug_log("B", "agent.py:_do_streaming_turn_events", "ask_user start", {"iteration": iteration, "question_id": question_id, "question": question, "options": list(options)})
                    # #endregion

                    yield QuestionAsked(
                        question_id=question_id,
                        question=question,
                        options=options,
                        allow_free_text=allow_free_text,
                    )

                    try:
                        answer = await self._wait_for_answer(
                            question_id, op_receiver,
                        )
                    except asyncio.CancelledError:
                        # #region debug-point B:ask-user-cancelled
                        _debug_log("B", "agent.py:_do_streaming_turn_events", "ask_user cancelled", {"iteration": iteration, "question_id": question_id})
                        # #endregion
                        yield CancelledEvent(
                            reason="user_interrupted",
                            partial_content=final_text,
                        )
                        return

                    # #region debug-point B:ask-user-resumed
                    _debug_log("B", "agent.py:_do_streaming_turn_events", "ask_user resumed", {"iteration": iteration, "question_id": question_id, "answer": answer})
                    # #endregion

                    ask_result = ToolCallResult(
                        tool_name="ask_user",
                        arguments=ask_args,
                        result=f"User selected: {answer}",
                        success=True,
                        execution_time=0.0,
                    )
                    all_tool_results.append(ask_result)
                    yield ToolCallFinished(
                        call_id=ask_call.get("id", ""),
                        name="ask_user",
                        result=ask_result.result,
                        success=True,
                        duration=0.0,
                        arguments=ask_args,
                    )
                    self._context.add_tool_result(
                        "ask_user",
                        ask_result.result,
                        tool_call_id=ask_call.get("id", ""),
                    )

                # 8) Loop back to step 1 — the model will see the
                #    tool messages we just persisted and decide whether
                #    to keep iterating, call more tools, or wrap up.

            # Iteration limit hit. Emit a final completion so the TUI
            # doesn't hang waiting for an event.
            # Harness: record final answer and finalize
            if self._trajectory:
                try:
                    self._trajectory.record_final_answer(final_text[:500] if final_text else "")
                    self._trajectory.stop()
                    _hdbg = _get_dbg()
                    if _hdbg:
                        evaluator = HarnessEvaluator(self._trajectory)
                        report = evaluator.full_report(context_tokens=0, context_budget=0)
                        _hdbg.log_raw(f"\n[HARNESS REPORT] score={report.overall_score:.2f} "
                                   f"loops={len(report.loops_detected)} "
                                   f"tool_accuracy={sum(a.success_rate for a in report.tool_accuracy.values())/max(1,len(report.tool_accuracy)):.2f} "
                                   f"loop_rate={report.loop_rate:.2f} "
                                   f"iteration_eff={report.iteration_efficiency:.2f}\n")
                except Exception:
                    pass
                self._trajectory = None
                self._harness_guard = None
            yield TurnCompleted(
                content=final_text,
                tool_calls=tuple(
                    self._tc_to_dict(tc) for tc in all_tool_results
                ),
                iterations=self._max_iterations,
                total_time=0.0,
                input_tokens=in_tok_total,
                output_tokens=out_tok_total,
                cache_hit_tokens=cache_hit_total,
                cache_miss_tokens=cache_miss_total,
            )
            self._last_response = AgentResponse(
                content=final_text,
                tool_calls=all_tool_results,
                input_tokens=in_tok_total,
                output_tokens=out_tok_total,
            )
        except asyncio.CancelledError:
            # Harness: finalize on cancellation
            if self._trajectory:
                try:
                    self._trajectory.stop()
                except Exception:
                    pass
                self._trajectory = None
                self._harness_guard = None
            yield CancelledEvent(
                reason="asyncio_cancelled", partial_content=final_text,
            )

    async def _execute_tool_batch(
        self,
        tool_calls: List[Dict[str, Any]],
    ) -> List[ToolCallResult]:
        """Execute a batch of tool calls — parallel when safe, sequential otherwise.

        Mirrors the legacy ``_run_tool_loop`` policy:

        - All tools marked ``is_concurrency_safe`` AND len > 1 →
          ``asyncio.gather`` (parallel).
        - Otherwise → sequential, in declared order.

        Returns one :class:`ToolCallResult` per input dict, in the
        same order. Input dicts are in the OpenAI ``tool_calls`` format
        (with ``function.name`` / ``function.arguments`` nested).
        """
        # #region debug-point C:execute-batch-enter
        _debug_log("C", "agent.py:_execute_tool_batch", "enter", {"count": len(tool_calls), "tools": [(tc.get("function", {}).get("name", "") or tc.get("name", "")) for tc in tool_calls]})
        # #endregion
        if not tool_calls:
            return []

        def _name(tc: Dict[str, Any]) -> str:
            return tc.get("function", {}).get("name", "") or tc.get("name", "")

        def _args(tc: Dict[str, Any]) -> Dict[str, Any]:
            raw = tc.get("function", {}).get("arguments", "")
            if isinstance(raw, str):
                try:
                    return json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    return {}
            return raw or {}

        all_safe = all(
            self._tool_registry.is_concurrency_safe(_name(tc))
            for tc in tool_calls
        )
        if len(tool_calls) > 1 and all_safe:
            coros = [
                self._execute_tool_call(_name(tc), _args(tc))
                for tc in tool_calls
            ]
            results = list(await asyncio.gather(*coros, return_exceptions=False))
            # #region debug-point C:execute-batch-exit
            _debug_log("C", "agent.py:_execute_tool_batch", "parallel exit", {"count": len(results)})
            # #endregion
            return results

        # Sequential fallback
        results: List[ToolCallResult] = []
        for tc in tool_calls:
            results.append(
                await self._execute_tool_call(_name(tc), _args(tc))
            )
        # #region debug-point C:execute-batch-exit
        _debug_log("C", "agent.py:_execute_tool_batch", "sequential exit", {"count": len(results)})
        # #endregion
        return results

    @staticmethod
    def _convert_to_api_tool_calls(
        calls: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Convert simplified ``{id, name, arguments}`` to OpenAI format.

        ``add_assistant_with_tool_calls`` expects the OpenAI nested
        format with ``function.name`` / ``function.arguments`` (string).
        ``_finalize_streamed_calls`` returns the simplified format.
        """
        api: List[Dict[str, Any]] = []
        for tc in calls:
            api.append({
                "id": tc.get("id", ""),
                "type": "function",
                "function": {
                    "name": tc.get("name", ""),
                    "arguments": json.dumps(
                        tc.get("arguments", {}), ensure_ascii=False,
                    ),
                },
            })
        return api

    @staticmethod
    def _safe_parse_args(raw: Any) -> Dict[str, Any]:
        """Parse ``function.arguments`` (str or dict) into a dict."""
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}
        elif isinstance(raw, dict):
            parsed = raw
        else:
            parsed = {}
        return parsed

    async def _non_streaming_turn_events(
        self,
        user_message: str,
        messages: List[Dict[str, Any]],
        op_receiver: Optional[asyncio.Queue] = None,
    ) -> "AsyncIterator[AgentEvent]":
        """codex-style 非流式 turn: 与流式路径共用同一个 submission_loop.

        这里只是在 ``streaming=False`` 模式下调一次同步接口,行为与
        流式路径完全一致 (包括工具 inline 执行、context 持久化).
        """
        from .protocol import (
            Cancelled as CancelledEvent,
            QuestionAsked,
            TextDelta,
            ToolCallFinished,
            TurnCompleted,
            TurnFailed,
            PatchApplied,
        )

        async def _check_interrupt() -> Optional[str]:
            return await _check_op_interrupt(
                op_receiver, self._cancelled, self._interrupt_reason,
            )

        in_tok_total = 0
        out_tok_total = 0
        cache_hit_total = 0
        cache_miss_total = 0
        all_tool_results: List[ToolCallResult] = []
        final_text = ""

        try:
            for iteration in range(self._max_iterations):
                self._current_iteration = iteration
                interrupt_reason = await _check_interrupt()
                if interrupt_reason:
                    self._interrupt_reason = interrupt_reason
                    yield CancelledEvent(
                        reason=interrupt_reason, partial_content=final_text,
                    )
                    return

                await self._context.compress(self._model)
                messages = self._build_messages()
                _allowed = self._allowed_tool_names()
                if _allowed is not None:
                    tool_schemas = self._tool_registry.get_schemas(_allowed) or None
                else:
                    tool_schemas = self._tool_registry.get_schemas(
                        self._tool_registry.list_tools()
                    ) or None

                try:
                    response, tool_calls_raw = await self._call_model_with_client(
                        messages, tools=tool_schemas,
                    )
                except Exception as e:
                    yield TurnFailed(
                        code="model_error",
                        error=f"模型调用失败: {type(e).__name__}: {e}",
                    )
                    return

                final_text = response
                if response:
                    yield TextDelta(text=response)

                # Non-streaming call already returns OpenAI format from
                # _call_model_with_client. Normalize to the same shape
                # as the streaming path.
                if tool_calls_raw and isinstance(tool_calls_raw[0], dict) \
                        and "function" in tool_calls_raw[0]:
                    api_tool_calls = list(tool_calls_raw)
                else:
                    api_tool_calls = self._convert_to_api_tool_calls(
                        tool_calls_raw or [],
                    )

                self._context.add_assistant_with_tool_calls(
                    response, api_tool_calls,
                )

                if not api_tool_calls:
                    yield TurnCompleted(
                        content=response,
                        tool_calls=tuple(
                            self._tc_to_dict(tc) for tc in all_tool_results
                        ),
                        iterations=iteration + 1,
                        total_time=0.0,
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                        cache_hit_tokens=cache_hit_total,
                        cache_miss_tokens=cache_miss_total,
                    )
                    self._last_response = AgentResponse(
                        content=response,
                        input_tokens=in_tok_total,
                        output_tokens=out_tok_total,
                    )
                    return

                def _name(tc: Dict[str, Any]) -> str:
                    return tc.get("function", {}).get("name", "") or tc.get("name", "")

                def _args(tc: Dict[str, Any]) -> Dict[str, Any]:
                    raw = tc.get("function", {}).get("arguments", "")
                    if isinstance(raw, str):
                        try:
                            return json.loads(raw) if raw else {}
                        except json.JSONDecodeError:
                            return {}
                    return raw or {}

                ask_user_calls = [
                    tc for tc in api_tool_calls
                    if _name(tc).lower() == "ask_user"
                ]
                non_ask_user_calls = [
                    tc for tc in api_tool_calls
                    if _name(tc).lower() != "ask_user"
                ]

                results: List[ToolCallResult] = []
                if non_ask_user_calls:
                    results = await self._execute_tool_batch(non_ask_user_calls)
                all_tool_results.extend(results)

                # Doom Loop detection (mirrors streaming path at ~line 3189)
                for tc_in, result in zip(non_ask_user_calls, results):
                    tool_name_dl = tc_in.get("function", {}).get("name", "")
                    tool_args_dl = self._safe_parse_args(
                        tc_in.get("function", {}).get("arguments", ""),
                    )
                    self._doom_loop_detector.record(tool_name_dl, tool_args_dl)
                    is_loop, loop_tool = self._doom_loop_detector.is_loop_detected()
                    if is_loop:
                        logger.warning(
                            f"Doom loop detected (non-streaming): "
                            f"same call to '{loop_tool}' repeated"
                        )
                        # P5: record doom loop detection in Prometheus metrics
                        try:
                            from hakus.observability import metrics_registry
                            metrics_registry.doomloop_detected_total.inc()
                        except Exception:
                            pass
                        self._context.add_user_message(DOOM_LOOP_PROMPT)
                        self._doom_loop_detector.reset()
                        break

                for tc_in, result in zip(non_ask_user_calls, results):
                    yield ToolCallFinished(
                        call_id=tc_in.get("id", ""),
                        name=tc_in.get("function", {}).get("name", ""),
                        result=result.result,
                        success=result.success,
                        duration=result.execution_time,
                        arguments=self._safe_parse_args(
                            tc_in.get("function", {}).get("arguments", ""),
                        ),
                    )
                    self._context.add_tool_result(
                        tc_in.get("function", {}).get("name", ""),
                        result.result,
                        tool_call_id=tc_in.get("id", ""),
                    )

                    # Emit PatchApplied event for file changes
                    tool_name_lower = (tc_in.get("function", {}).get("name", "") or "").lower()
                    if tool_name_lower in ("write_file", "write") and result.success:
                        try:
                            import difflib
                            args = self._safe_parse_args(
                                tc_in.get("function", {}).get("arguments", ""),
                            )
                            path = args.get("path", "")
                            new_content = args.get("content", "")
                            # Try to read old content for diff
                            old_content = ""
                            try:
                                if os.path.exists(path):
                                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                                        old_content = f.read()
                            except Exception:
                                pass
                            diff = "".join(difflib.unified_diff(
                                old_content.splitlines(keepends=True),
                                new_content.splitlines(keepends=True),
                                fromfile=f"a/{path}",
                                tofile=f"b/{path}",
                            ))
                            yield PatchApplied(
                                path=path,
                                diff=diff,
                                old_content=old_content,
                                new_content=new_content,
                            )
                        except Exception:
                            pass
                    elif tool_name_lower in ("edit_file", "edit") and result.success:
                        try:
                            import difflib
                            args = self._safe_parse_args(
                                tc_in.get("function", {}).get("arguments", ""),
                            )
                            path = args.get("path", "")
                            old_str = args.get("old_str", "")
                            new_str = args.get("new_str", "")
                            # For edit_file, we construct the diff from old_str and new_str
                            diff = "".join(difflib.unified_diff(
                                old_str.splitlines(keepends=True),
                                new_str.splitlines(keepends=True),
                                fromfile=f"a/{path}",
                                tofile=f"b/{path}",
                            ))
                            yield PatchApplied(
                                path=path,
                                diff=diff,
                                old_content=old_str,
                                new_content=new_str,
                            )
                        except Exception:
                            pass

                for ask_call in ask_user_calls:
                    ask_args = _args(ask_call)
                    question_id = str(uuid.uuid4())
                    question = ask_args.get("question", "")
                    options = tuple(ask_args.get("options", []))
                    allow_free_text = bool(ask_args.get("allow_free_text", False))

                    yield QuestionAsked(
                        question_id=question_id,
                        question=question,
                        options=options,
                        allow_free_text=allow_free_text,
                    )

                    try:
                        answer = await self._wait_for_answer(
                            question_id, op_receiver,
                        )
                    except asyncio.CancelledError:
                        yield CancelledEvent(
                            reason="user_interrupted",
                            partial_content=final_text,
                        )
                        return

                    ask_result = ToolCallResult(
                        tool_name="ask_user",
                        arguments=ask_args,
                        result=f"User selected: {answer}",
                        success=True,
                        execution_time=0.0,
                    )
                    all_tool_results.append(ask_result)
                    yield ToolCallFinished(
                        call_id=ask_call.get("id", ""),
                        name="ask_user",
                        result=ask_result.result,
                        success=True,
                        duration=0.0,
                        arguments=ask_args,
                    )
                    self._context.add_tool_result(
                        "ask_user",
                        ask_result.result,
                        tool_call_id=ask_call.get("id", ""),
                    )

            # Iteration limit
            yield TurnCompleted(
                content=final_text,
                tool_calls=tuple(
                    self._tc_to_dict(tc) for tc in all_tool_results
                ),
                iterations=self._max_iterations,
                total_time=0.0,
                input_tokens=in_tok_total,
                output_tokens=out_tok_total,
                cache_hit_tokens=cache_hit_total,
                cache_miss_tokens=cache_miss_total,
            )
        except asyncio.CancelledError:
            yield CancelledEvent(
                reason="asyncio_cancelled", partial_content=final_text,
            )

    @staticmethod
    def _tc_to_dict(tc: Any) -> Dict[str, Any]:
        """Convert a ToolCallResult (or dict) to a plain dict.

        Used when packing into the immutable ``TurnCompleted.tool_calls``
        tuple — TurnCompleted is frozen, so we can't store mutable
        dataclasses directly.
        """
        if isinstance(tc, dict):
            return dict(tc)
        # ToolCallResult dataclass
        return {
            "tool_name": getattr(tc, "tool_name", ""),
            "arguments": getattr(tc, "arguments", {}),
            "result": getattr(tc, "result", ""),
            "success": getattr(tc, "success", True),
            "execution_time": getattr(tc, "execution_time", 0.0),
        }

    @property
    def force_orchestrator(self) -> bool:
        """Override the routing heuristic for a single turn.

        Set by the `/orchestrate` slash command. When True, the next
        `run_turn` call always routes to the multi-agent
        orchestrator. The flag is cleared in the slash command's
        `finally` block so subsequent turns revert to the normal
        routing decision.
        """
        return getattr(self, "_force_orchestrator", False)

    @force_orchestrator.setter
    def force_orchestrator(self, value: bool) -> None:
        self._force_orchestrator = value

    # ============================================================
    # Orchestrator routing
    # ============================================================
    #
    # Complex / multi-file projects ("build a Spring Boot backend",
    # "create a Snake game with AI testing", ...) crash and hang the
    # single-agent tool loop. The orchestrator (Planner → Dev → 6
    # dimension testers + fix loop) was built for exactly this, but
    # had no caller. The complexity scorer below decides when to delegate.

    def _should_use_orchestrator(self, user_message: str) -> bool:
        """Decide whether to route this turn to the multi-agent orchestrator.

        Uses TaskComplexityScorer for deterministic routing based on
        multi-dimensional complexity scoring. Falls back to the old
        heuristic if the scorer is unavailable.

        Returns True for tasks that score above the orchestrator threshold
        or when the user explicitly prefixes with `!`.
        """
        if not self._orchestrator:
            return False
        try:
            return self._complexity_scorer.should_orchestrate(user_message)
        except Exception:
            # Fallback: use `!` prefix only
            text = (user_message or "").strip()
            return bool(text and text.startswith("!"))

    def _format_orchestrator_event(self, ev) -> str:
        """Render an OrchestratorEvent as a single chunk of text for the
        streaming sink.

        The sink just appends text to a Markdown widget, so each event
        becomes one log-style line. Newlines inside events are preserved
        (e.g. multi-line tool output).
        """
        et = getattr(ev, "type", "")
        msg = getattr(ev, "message", "") or ""

        # Token usage events → update the running counter, but don't
        # pollute the chat bubble with numbers. The sink's
        # `_update_token_count` reads from `self._last_response` instead,
        # so we stash the latest tokens on the response so the sink can
        # pick them up. The sink already updates counters on completion.
        if et == "token_usage":
            in_tok = getattr(ev, "input_tokens", 0) or 0
            out_tok = getattr(ev, "output_tokens", 0) or 0
            if self._last_response is None:
                self._last_response = AgentResponse(content="")
            self._last_response.input_tokens += in_tok
            self._last_response.output_tokens += out_tok
            return ""  # invisible to the user

        if et == "phase":
            phase = getattr(ev, "phase", "")
            label = {
                "planning": "📋 计划",
                "developing": "🛠 开发",
                "testing": "🧪 测试",
                "fixing": "🔧 修复",
                "final_testing": "✅ 终验",
                "completed": "🎉 完成",
                "failed": "❌ 失败",
                "idle": "",
            }.get(phase, phase)
            extra = f"  {msg}" if msg else ""
            return f"\n\n**[{label}]**{extra}\n\n"

        if et == "agent_start":
            at = getattr(ev, "agent_type", "")
            tid = getattr(ev, "task_id", "")
            return f"\n▷ **{at}** 启动  (task: `{tid}`)\n"

        if et == "agent_done":
            at = getattr(ev, "agent_type", "")
            ok = getattr(ev, "success", None)
            tid = getattr(ev, "task_id", "")
            icon = "✓" if ok else "✗"
            extra = f" — {msg}" if msg else ""
            return f"\n{icon} **{at}** 完成 (task: `{tid}`){extra}\n"

        if et == "task_progress":
            return f"\n  • {msg}\n"

        if et == "log":
            return f"\n  · {msg}\n"

        if et == "error":
            err = getattr(ev, "error", None) or msg
            return f"\n\n**[Orchestrator 错误]** {err}\n\n"

        if et == "done":
            return f"\n\n**总结:** {msg}\n"

        # Unknown event type — render the message so we never silently
        # lose information.
        return f"\n[orch:{et}] {msg}\n"

    # ============================================================
    # Pause / Resume support
    # ============================================================

    async def pause_orchestrator(self) -> str:
        """Pause the running orchestrator task. Returns status message."""
        if self._orchestrator is None or not self._orchestrator._running:
            return "没有正在运行的长时任务"
        self._orchestrator.pause()
        return "长时任务已暂停，检查点已保存"

    async def resume_orchestrator(self, workspace_dir: Optional[str] = None) -> str:
        """Resume an orchestrator task from checkpoint.

        Args:
            workspace_dir: If provided, resume from this workspace's checkpoint.
                           If None, uses the current orchestrator's workspace.
        """
        if self._orchestrator is None:
            return "Orchestrator 未初始化"

        if workspace_dir:
            # Create a new orchestrator for the specified workspace
            from .orchestrator import Orchestrator, OrchestratorConfig
            self._orchestrator = Orchestrator(
                root_agent=self,
                workspace_dir=workspace_dir,
                config=OrchestratorConfig(),
            )

        result = await self._orchestrator.resume_from_checkpoint()
        if result.success:
            return f"长时任务已恢复完成: {result.completed_tasks}/{result.total_tasks} 任务成功"
        else:
            return f"恢复失败: {result.error}"

    async def _stream_resume_orchestrator_events(
        self,
        workspace_dir: Optional[str] = None,
        op_receiver: Optional[asyncio.Queue] = None,
    ) -> "AsyncIterator[AgentEvent]":
        """Streaming resume: yield AgentEvent from checkpoint recovery.

        Sets up the orchestrator (creating a new one if ``workspace_dir``
        is provided), then delegates to
        :meth:`Orchestrator.stream_resume_from_checkpoint` which yields
        live progress events.

        Also polls ``op_receiver`` for :class:`PauseOp` between events
        so the user can re-pause during a resumed run.

        Args:
            workspace_dir: If provided, resume from this workspace's
                checkpoint.  If None, uses the current orchestrator.
            op_receiver: Optional op queue for pause/cancel signals.
        """
        from .protocol import (
            OrchestratorPhaseChanged,
            PauseOp,
            TextDelta,
            TurnCompleted,
            TurnFailed,
        )

        if self._orchestrator is None:
            yield TextDelta(text="Orchestrator 未初始化")
            yield TurnCompleted(content="Orchestrator 未初始化")
            return

        if workspace_dir:
            from .orchestrator import Orchestrator, OrchestratorConfig
            self._orchestrator = Orchestrator(
                root_agent=self,
                workspace_dir=workspace_dir,
                config=OrchestratorConfig(),
            )

        yield OrchestratorPhaseChanged(
            phase="developing", detail="从检查点恢复中",
        )

        try:
            if hasattr(self._orchestrator, 'stream_resume_from_checkpoint'):
                async for event in self._orchestrator.stream_resume_from_checkpoint():
                    yield event
                    # Poll for PauseOp between events
                    if op_receiver is not None:
                        try:
                            op = op_receiver.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        else:
                            if isinstance(op, PauseOp):
                                logger.info("PauseOp during resume — pausing")
                                self._orchestrator.pause()
                                yield OrchestratorPhaseChanged(
                                    phase="paused",
                                    detail="长时任务已暂停，检查点已保存",
                                )
                                yield TextDelta(
                                    text="\n\n⏸ 长时任务已暂停。使用 `/resume` 恢复。\n"
                                )
                            else:
                                try:
                                    op_receiver.put_nowait(op)
                                except asyncio.QueueFull:
                                    logger.warning("op_receiver full when requeueing op")
            else:
                # Fallback: blocking resume, wrap result as events
                result = await self._orchestrator.resume_from_checkpoint()
                if result.success:
                    msg = f"长时任务已恢复完成: {result.completed_tasks}/{result.total_tasks} 任务成功"
                    yield TextDelta(text=msg)
                    yield TurnCompleted(content=msg)
                else:
                    yield TextDelta(text=f"恢复失败: {result.error}")
                    yield TurnFailed(code="resume_failed", error=result.error or "Unknown error")
        except Exception as e:
            logger.error(f"Streaming resume failed: {e}")
            yield TextDelta(text=f"\n[恢复失败: {e}]\n")
            yield TurnFailed(code="resume_error", error=str(e))

    async def spawn_sub_agent(self, task: str, allowed_tools: Optional[List[str]] = None) -> SubAgent:
        sub = SubAgent(parent=self, task=task, max_depth=self._max_sub_agent_depth, allowed_tools=allowed_tools)
        self._sub_agents.append(sub)
        return sub

    async def _save_memory_background(self, query: str, response: str) -> None:
        if not self._memory:
            return
        try:
            loop = asyncio.get_event_loop()
            def _do_save():
                try:
                    self._memory.add_short_term_memory(query, response)
                    key_info = self._memory.extract_key_info(f"User: {query}\nAssistant: {response}")
                    self._memory.add_long_term_memory(query, response, key_info)
                    return key_info
                except Exception as e:
                    logger.error(f"Memory save error: {e}")
                    return None
            key_info = await loop.run_in_executor(None, _do_save)
            if key_info:
                logger.debug(f"Memory saved: {key_info[:50]}")
        except Exception as e:
            logger.error(f"Background memory save failed: {e}")

    def rollback(self, checkpoint_id: str) -> bool:
        snapshot = self._checkpoint.restore(checkpoint_id)
        if snapshot is None:
            return False
        self._context.restore(snapshot)
        logger.info(f"Rolled back to checkpoint: {checkpoint_id}")
        return True

    def get_checkpoints(self) -> List[Dict[str, Any]]:
        return self._checkpoint.list_checkpoints()

    def get_context_stats(self) -> Dict[str, Any]:
        return self._context.get_stats()

    def get_permission_status(self) -> Dict[str, Any]:
        return self._permission.get_status()

    def set_permission_mode(self, mode: PermissionMode) -> None:
        self._permission.mode = mode

    def set_working_dir(self, path: str) -> None:
        self._context.working_dir = path

    def update_dynamic_context(self, key: str, value: str) -> None:
        self._context.update_dynamic_context(key, value)

    def reset(self) -> None:
        self._context.clear()
        self._checkpoint.clear()
        self._permission.reset_session()
        self._sub_agents.clear()
        self._cancelled = False
        logger.info(f"AgentCore reset: {self._session_id}")


_agent_cache: Dict[str, AgentCore] = {}
_agent_cache_lock = threading.Lock()


def get_agent_core(session_id: str, model_type: Optional[str] = None,
                   permission_mode: PermissionMode = PermissionMode.ASK,
                   confirm_callback: Optional[Callable[[str, str], bool]] = None) -> AgentCore:
    if session_id in _agent_cache:
        return _agent_cache[session_id]
    with _agent_cache_lock:
        if session_id not in _agent_cache:
            _agent_cache[session_id] = AgentCore(
                model_type=model_type, permission_mode=permission_mode,
                confirm_callback=confirm_callback, session_id=session_id)
    return _agent_cache[session_id]


def remove_agent_core(session_id: str) -> None:
    with _agent_cache_lock:
        _agent_cache.pop(session_id, None)
