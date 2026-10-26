"""
HakusAI 2.0 FastAPI服务器
提供REST API和WebSocket接口
"""

import asyncio
import os
import shutil
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from enum import Enum
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, field_validator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import logging
import json
from pathlib import Path

from hakusai_core.utils.events import event_bus, EventType
from hakusai_core.config import config_manager
from hakusai_core.models import model_registry, BaseModelAdapter, Message, MessageRole
from hakusai_core.agent import BaseAgent, AgentContext
from hakusai_core.memory import MemoryManager, MemoryStorage
from hakusai_core.voice.tts import tts_registry
from hakusai_core.v2.platform import platform_manager, SendMessage
from hakus.modes import RUN_MODES, normalize_run_mode
from .vtuber_websocket import vtuber_handler
from .agent_bridge import (
    run_turn_stream as agentcore_run_turn_stream,
    run_turn_collect as agentcore_run_turn_collect,
    clear_session_history as agentcore_clear_session,
    get_or_create_agent as agentcore_get_or_create,
    post_answer as agentcore_post_answer,
    get_provider_adapter_diagnostics as agentcore_provider_adapter_diagnostics,
)
from . import session_store
from .logging_config import setup_logging, get_logger

logger = get_logger("haku.sidecar.server")


# ========== 服务器 API 版本 ==========
# 每次 sidecar 新增/变更 API 端点时，必须 bump 此版本号。
# 桌面客户端启动时会 GET /api/version 检查 sidecar 是否过旧；
# 如果版本不匹配，会提示用户重新下载最新版（而不是显示莫名其妙的 404）。
#
# 历史: v0.1.0-beta.3 用户报告 "Get providers failed:404"，根因是用户安装的
# sidecar.exe 还是 beta.2 时期的（没有 /api/config/providers 等新端点）。
# 加这个版本号后，客户端能直接告诉用户 "sidecar 版本过旧" 而不是让用户
# 对着 404 一头雾水。
SIDECAR_API_VERSION = "0.14.0"
SIDECAR_API_VERSION_INT = 13  # 整数版本，便于客户端比较
# v0.13.0: + User-managed Skills API (/api/skills*) and explicit
#          @skill:<name> prompt injection for desktop conversations.
# v0.12.0: + DeepSeek-Harness-inspired architecture:
#          - Append-only session log (JSONL) at ~/.hakus/sessions/<id>/
#            session_log.jsonl. Records every turn_start, text_delta,
#            tool_call_started/finished, token_usage, turn_completed/
#            failed/cancelled. Auto-compacts at 5MB / 1000 events.
#            Endpoints: GET /api/sessions/{id}/log,
#            POST /api/sessions/{id}/log/compact, DELETE /api/sessions/{id}/log
#          - Mode → allowed_tools whitelist (swift = read-only + chat +
#            shell + filesystem write, deep = full power; blocked by tag),
#            fleet was retired 2026-08-18). Enforced both in schema
#            building (LLM never
#            sees disallowed tools) and at tool-call dispatch (defensive).
#          - Tool registry refactor: Tool.category is now a first-class
#            class attribute. ToolRegistry.list_by_category/list_by_tag/
#            unregister/get_categories. /api/tools now derives from the
#            live registry instead of a hardcoded list. tools.disabled
#            in config.yaml is now actually read by the agent (was a
#            write-only bug before).
#          - Backend atomic rewind endpoint: POST /api/sessions/{id}/rewind
#            deletes message_id + all subsequent messages AND truncates
#            the session log to the corresponding turn boundary.
# v0.11.0: + Fleet CTDE v2 — Planner + parallel Workers (sub_dir-scoped)
#          + Reviewer gate + counterfactual expert re-run (RETIRED
#          2026-08-18 — backend code + /api/fleet endpoints removed).
#          Rich orchestrator_phase_changed +
#          task_progress events over SSE so the frontend can render the
#          expert roster and reviewer outcome live.
# v0.10.0: + Project management (/api/projects CRUD) + ChatRequest.project_id
#          so the agent can be told which folder to work in without the
#          user having to spell out absolute paths every turn.
# v0.9.0: + P5 observability: Prometheus /metrics endpoint + structlog
#         + MetricsMiddleware (HTTP latency histograms)
#         + Enhanced /api/metrics with Prometheus snapshot + Guardian stats
#         + P3 evolution routes mounted (checkpoint/restore/heartbeat)
#         + /api/long-running/health endpoint
# v0.8.0: + Codex-style review panel: /api/git/status, /api/git/diff,
#         /api/git/stage + /ws/terminal (built-in shell)
# v0.7.0: + /api/question/answer 端点 + WS answer 消息
#         + ask_user 工具交互式提问 (QuestionAsked / AnswerOp)
# v0.6.0: + Phase 4 WS 心跳/重连 + Phase 5 /api/metrics 端点
#         + WS resume_session / interrupt / pong 协议
#         + cancel_session_turn (AgentCore _cancelled flag)
# v0.5.0: + MCP 客户端支持 (/api/config/mcp-servers* + /api/mcp/servers/*)
# v0.4.0: + SQLite 会话持久化 + 聊天记录导出/导入
# v0.3.0: + 提供商配置 API (test connection / fetch models / multi-key / headers)

# Toggle: when True, /api/chat* endpoints use hakus.AgentCore (24 tools,
# permissions, AgentEvent stream). When False, fall back to the old
# BaseAgent chat-only path (useful for debugging / bisecting).
# Default True — the BaseAgent path is now considered legacy.
USE_AGENTCORE_FOR_CHAT = os.environ.get("HAKUSAI_USE_AGENTCORE", "1") != "0"

# Phase-0 migration metadata. These fields are diagnostic, not switches: the
# only reader is execution_plane_metadata() below, and nothing in this process
# routes on them. Measured in the Phase 2 survey (REFACTOR_STATUS.md, ninth and
# fourteenth passes): the shipped desktop never starts this sidecar and its
# client cannot reach it, so an env knob here could only imply a choice nothing
# makes. `rust_default_path` therefore states the D-001 fact — the desktop's
# default execution plane is the Rust Runtime — which also removes the old
# asymmetry where this process defaulted the same env var to off while the Rust
# runtime defaulted it to on. This process is deprecated as a compatibility
# plane; the `hakus/` package it bridges to remains the HakusCLI product, which
# is a first-class client and not part of the desktop default path.
PYTHON_COMPAT_PATH = True
RUST_DEFAULT_PATH = True


def execution_plane_metadata() -> Dict[str, Any]:
    """Return safe, machine-readable migration state for diagnostics."""
    return {
        "execution_plane": "python_compat",
        "deprecated": True,
        "feature_gates": {
            "rust_default_path": RUST_DEFAULT_PATH,
            "python_compat_path": PYTHON_COMPAT_PATH,
            "legacy_agentcore": USE_AGENTCORE_FOR_CHAT,
            # Phase 0 freeze: when True, Python transcript/checkpoint and
            # compatibility automation writers refuse new data.
            "python_writers_frozen": session_store.writers_frozen(),
        },
        # Provider calls in this deprecated plane remain a compatibility
        # adapter. The selected provider is never replaced when it is absent
        # or cannot be initialized; the Rust Runtime owns the canonical route.
        "legacy_provider_adapter": {
            "state": "compatibility",
            "fallback_policy": "disabled",
            "canonical_plane": "rust_runtime",
        },
    }


# ========== 服务器状态机 ==========
# /health 在 lifespan 起飞后立即返回 200，并通过 status 字段告诉客户端当前真实状态。
# 这样 sidecar 健康检查不再因 AI 组件初始化失败而 30s 超时。

class ServerState(str, Enum):
    """服务器生命周期状态"""
    STARTING = "starting"           # 进程刚启动，lifespan 还没跑
    INITIALIZING = "initializing"   # lifespan 已 yield，AI 组件正在后台初始化
    HEALTHY = "healthy"             # 所有关键组件就绪
    DEGRADED = "degraded"           # 关键组件就绪，但部分可选组件（TTS/Memory）失败
    FAILED = "failed"               # 关键组件（model/agent）初始化失败，但 HTTP 仍可响应


# ========== 请求/响应模型 ==========

class ChatRequest(BaseModel):
    """聊天请求"""
    message: str
    session_id: Optional[str] = "default"
    stream: bool = True
    # Per-request provider override. If set (e.g. "opencode"), the
    # agent_bridge creates/reuses an AgentCore bound to this provider
    # instead of the global default_model from config.yaml. This lets
    # the user switch providers from the TopBar dropdown mid-session.
    # If None, falls back to config.yaml's models.default_model.
    provider: Optional[str] = None
    # Per-request run mode override: "swift" or "deep".
    run_mode: Optional[str] = None
    # Per-request reasoning effort override (DeepSeek thinking mode).
    # Accepts "low" / "high" / "max" / None. None = model default.
    # See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    reasoning_effort: Optional[str] = None
    # Per-request project override. If set to a registered project id,
    # the agent's working_dir is set to that project's folder — so all
    # file/shell tools operate inside the project without the user
    # having to spell out absolute paths. None / "none" / unknown id
    # falls back to the default workspace (sidecar's repo root).
    project_id: Optional[str] = None

    @field_validator("run_mode")
    @classmethod
    def validate_run_mode(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = normalize_run_mode(value, default="swift")
        if normalized not in RUN_MODES or normalized != value.strip().lower():
            allowed = ", ".join(RUN_MODES)
            raise ValueError(f"run_mode must be one of: {allowed}")
        return normalized

    @field_validator("reasoning_effort")
    @classmethod
    def validate_reasoning_effort(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip().lower()
        if normalized not in ("low", "high", "max"):
            raise ValueError(
                "reasoning_effort must be one of: low, high, max"
            )
        return normalized


class ChatResponse(BaseModel):
    """聊天响应"""
    content: str
    emotion: Optional[str] = None
    actions: list = []
    done: bool = False


class ConfigUpdateRequest(BaseModel):
    """配置更新请求"""
    section: str
    key: str
    value: Any


class SkillToggleRequest(BaseModel):
    enabled: bool
    project_id: Optional[str] = None


class SkillInstallRequest(BaseModel):
    source: str
    scope: str = "global"
    project_id: Optional[str] = None


# ========== Session persistence (SQLite) 请求模型 ==========

class SessionCreateRequest(BaseModel):
    """创建 session 请求"""
    id: str
    title: str = "New Chat"
    remote_session_id: Optional[str] = None
    provider: Optional[str] = None
    pinned: bool = False
    created_at: Optional[int] = None
    updated_at: Optional[int] = None


class AutomationCreateRequest(BaseModel):
    """创建 automation 请求"""
    name: str
    schedule: str  # "30m" / "1h" / "@hourly" / "@daily" / "@manual"
    prompt: str
    enabled: bool = True


class AutomationUpdateRequest(BaseModel):
    """更新 automation 请求 — 所有字段可选"""
    name: Optional[str] = None
    schedule: Optional[str] = None
    prompt: Optional[str] = None
    enabled: Optional[bool] = None


class SessionUpdateRequest(BaseModel):
    """更新 session 请求 — 所有字段可选"""
    title: Optional[str] = None
    remote_session_id: Optional[str] = None
    provider: Optional[str] = None
    pinned: Optional[bool] = None


class MessageCreateRequest(BaseModel):
    """追加 message 请求"""
    id: str
    role: str = "user"  # user / assistant / system / tool
    content: str = ""
    reasoning: Optional[str] = None
    tool_calls: Optional[list] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    error: Optional[str] = None
    streaming: bool = False
    created_at: Optional[int] = None
    updated_at: Optional[int] = None


class MessageUpdateRequest(BaseModel):
    """更新 message 请求 — 所有字段可选"""
    content: Optional[str] = None
    reasoning: Optional[str] = None
    tool_calls: Optional[list] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    error: Optional[str] = None
    streaming: Optional[bool] = None


class AnswerQuestionRequest(BaseModel):
    """回答 Agent 在执行过程中提出的问题"""
    session_id: str
    question_id: str
    choice: str


class BulkImportRequest(BaseModel):
    """批量导入 (用于 localStorage -> SQLite 迁移)"""
    sessions: list
    messages: Dict[str, list] = {}  # session_id -> [messages]


# ========== 服务器类 ==========

class HakusAIServer:
    """
    HakusAI服务器
    
    管理FastAPI应用生命周期和WebSocket连接
    """
    
    def __init__(self):
        self.app: Optional[FastAPI] = None
        self.config = config_manager.config
        self.websocket_manager = WebSocketManager()

        # AI组件
        self.model_adapter: Optional[BaseModelAdapter] = None
        self.agent: Optional[BaseAgent] = None
        self.memory: Optional[MemoryManager] = None

        # TTS组件
        self.tts_engine = None

        # ---- 服务器状态机（Phase 1: /health 异步化）----
        # /health 在 lifespan yield 后立即可用，并通过 self._state 暴露真实状态。
        # AI 组件在后台 task 中初始化，失败不会阻塞 HTTP 服务。
        self._state: ServerState = ServerState.STARTING
        self._init_error: Optional[str] = None
        self._init_started_at: Optional[float] = None
        self._init_finished_at: Optional[float] = None
        # 每个组件的初始化状态: {"model_adapter": "ok"|"failed: <msg>", "agent": "...", ...}
        self._component_status: Dict[str, str] = {}
        # 后台初始化任务
        self._init_task: Optional[asyncio.Task] = None
        # init 完成事件（无论成功失败都会 set），供 chat 端点等待
        self._init_event: asyncio.Event = asyncio.Event()

        # ---- Phase 5: Metrics (5h SWE 任务可观测性) ----
        # 所有计数器都是 "since process start" 的累计值。
        # active_websockets 不在这里存 — 直接从 websocket_manager 拿实时值。
        # _start_time 用于算 uptime; 用 time.time() 而不是 monotonic, 跨进程重启可读。
        self._metrics_start_time: float = time.time()
        self._metrics: Dict[str, int] = {
            "total_turns": 0,
            "total_errors": 0,
            "checkpoints_saved": 0,
            "llm_calls": 0,
            "llm_retries": 0,
        }
        self._process_started_at_unix_ms = int(time.time() * 1000)
        # 按 provider 细分 — by_provider[provider] = {"turns": N, "errors": N, "llm_calls": N}
        self._metrics_by_provider: Dict[str, Dict[str, int]] = {}
        # metrics 锁 (虽然是单线程 asyncio, 但 _inc_metric 也可能被 sync 代码调)
        self._metrics_lock = asyncio.Lock()

    def _inc_metric(self, key: str, amount: int = 1, provider: Optional[str] = None) -> None:
        """线程安全地递增一个 metric。

        key 必须是 _metrics 中已存在的键 (total_turns / total_errors /
        checkpoints_saved / llm_calls / llm_retries)。
        provider 可选 — 如果给定, 同时更新 _metrics_by_provider。
        """
        if key in self._metrics:
            self._metrics[key] += amount
        if provider is not None:
            bucket = self._metrics_by_provider.setdefault(provider, {
                "turns": 0, "errors": 0, "llm_calls": 0,
            })
            # 映射 metric key -> by_provider key
            mapping = {
                "total_turns": "turns",
                "total_errors": "errors",
                "llm_calls": "llm_calls",
            }
            bp_key = mapping.get(key)
            if bp_key:
                bucket[bp_key] += amount

    def get_metrics_snapshot(self) -> Dict[str, Any]:
        """返回 /api/metrics 响应体 — 实时快照。"""
        uptime = max(0.0, time.time() - self._metrics_start_time)
        return {
            "uptime_seconds": round(uptime, 2),
            "process_started_at_unix_ms": self._process_started_at_unix_ms,
            # The canonical event count — including the persisted
            # `compat_imported_event_count` for events imported from this
            # compatibility plane — lives on the Rust Runtime's /v1/metrics.
            # This sidecar no longer reports a count it cannot author.
            **execution_plane_metadata(),
            "total_turns": self._metrics["total_turns"],
            "total_errors": self._metrics["total_errors"],
            "active_websockets": len(self.websocket_manager.active_connections),
            "checkpoints_saved": self._metrics["checkpoints_saved"],
            "llm_calls": self._metrics["llm_calls"],
            "llm_retries": self._metrics["llm_retries"],
            "by_provider": dict(self._metrics_by_provider),
        }
        
    async def _init_ai_components(self):
        """
        初始化 AI 组件 — 故障容忍版本。
        
        Phase 1 关键改动：
        - 每个组件单独 try/except，失败只记录不抛
        - 关键组件（model_adapter / agent）失败 → state=FAILED
        - 可选组件（memory / TTS / vtuber）失败 → state=DEGRADED
        - 全部成功 → state=HEALTHY
        - 无论结果如何，最后一定 set _init_event（让 chat 端点能感知"初始化已结束"）
        """
        self._init_started_at = time.time()
        self._state = ServerState.INITIALIZING
        logger.info("Starting AI components initialization (background)")
        
        critical_failure: Optional[str] = None
        
        try:
            # 获取模型配置
            model_config = self.config.model.model_dump()
            provider_value = model_config.get("provider", "deepseek")
            # 处理枚举类型
            provider = provider_value.value if hasattr(provider_value, 'value') else str(provider_value)
            
            logger.info(f"Initializing AI model: {provider}")
            
            # 从环境变量或配置文件获取API key
            import os
            import yaml
            api_key = model_config.get("api_key")
            
            # 如果新配置中没有api_key，尝试从旧的config.yaml格式读取
            if not api_key:
                try:
                    with open("config.yaml", "r", encoding="utf-8") as f:
                        old_config = yaml.safe_load(f)
                    
                    api_keys_map = {
                        "deepseek": "deepseek_api_key",
                        "gemini": "gemini_api_key",
                        "qwen": "dashscope_api_key",
                        "glm": "glm_api_key",
                        "opencode": "opencode_api_key",
                        "anthropic": "anthropic_api_key",
                        "mimo": "mimo_api_key",
                        "openai": "openai_api_key",
                    }
                    key_name = api_keys_map.get(provider)
                    logger.info(f"Looking for API key: {key_name}")
                    if key_name and old_config and "api_keys" in old_config:
                        api_key_value = old_config["api_keys"].get(key_name, "")
                        logger.info(f"Found API key value: {api_key_value[:20]}...")
                        # 处理环境变量格式 ${ENV_VAR:default_value}
                        if api_key_value and api_key_value.startswith("${") and ":" in api_key_value:
                            # 提取默认值
                            default_start = api_key_value.find(":") + 1
                            default_end = api_key_value.find("}")
                            api_key = api_key_value[default_start:default_end]
                            logger.info(f"Extracted default value: {api_key[:20]}...")
                        else:
                            api_key = api_key_value
                        
                        if api_key:
                            logger.info(f"Using API key from config.yaml: {key_name}")
                except Exception as e:
                    logger.warning(f"Failed to read old config format: {e}")
            
            # 如果还是没有，尝试从环境变量获取
            if not api_key:
                env_var_map = {
                    "deepseek": "DEEPSEEK_API_KEY",
                    "gemini": "GEMINI_API_KEY",
                    "openai": "OPENAI_API_KEY",
                    "qwen": "DASHSCOPE_API_KEY",
                    "glm": "GLM_API_KEY",
                    "opencode": "OPENCODE_API_KEY",
                    "anthropic": "ANTHROPIC_API_KEY",
                    "mimo": "MIMO_API_KEY",
                }
                env_var = env_var_map.get(provider)
                if env_var:
                    api_key = os.environ.get(env_var)
                    if api_key:
                        logger.info(f"Using API key from environment variable: {env_var}")
            
            # Phase 1: 缺 API key 不再让 lifespan 失败，而是优雅降级到 FAILED 状态
            # HTTP /health 仍然能响应，前端可以读到具体错误并提示用户配置
            if not api_key:
                env_var_map = {
                    "deepseek": "DEEPSEEK_API_KEY",
                    "gemini": "GEMINI_API_KEY",
                    "openai": "OPENAI_API_KEY",
                    "qwen": "DASHSCOPE_API_KEY",
                    "glm": "GLM_API_KEY",
                    "opencode": "OPENCODE_API_KEY",
                    "anthropic": "ANTHROPIC_API_KEY",
                    "mimo": "MIMO_API_KEY",
                }
                critical_failure = (
                    f"Missing API key for provider '{provider}'. "
                    f"Set {env_var_map.get(provider, 'API_KEY')} env var "
                    f"or add api_keys.{provider}_api_key to config.yaml."
                )
                self._component_status["model_adapter"] = "failed: missing API key"
                self._component_status["agent"] = "skipped: model_adapter unavailable"
                self._component_status["memory"] = "skipped: not yet initialized"
                self._component_status["tts_engine"] = "skipped: not yet initialized"
                self._component_status["vtuber_handler"] = "skipped: agent unavailable"
                self._component_status["agent_hooks"] = "skipped: agent or memory unavailable"
                logger.error(critical_failure)
                # 直接跳到收尾，不再尝试创建 model_adapter
                raise RuntimeError(critical_failure)
            
            model_config["api_key"] = api_key
            
            # 创建模型适配器
            self.model_adapter = model_registry.create_adapter(provider, model_config)
            await self.model_adapter.initialize()
            self._component_status["model_adapter"] = "ok"
            logger.info(f"Model adapter initialized: {provider}")
            
            # 创建Agent
            self.agent = BaseAgent(self.model_adapter)
            self._component_status["agent"] = "ok"
            logger.info("BaseAgent initialized")
            
            # 初始化记忆系统
            try:
                # IMPORTANT: resolve memory data_dir to an ABSOLUTE path under
                # ~/.hakus/data/memories/. The previous default was the
                # relative path "data/memories", which — when this server is
                # spawned by Tauri's `cargo run` (CWD = src-tauri/) — would
                # write short_term.json / long_term.json into src-tauri/data/.
                # That dir is watched by Tauri's dev file watcher, so every
                # memory write triggered a full app rebuild + backend respawn
                # → infinite restart loop. Pin to an absolute user-home path
                # so writes never land inside the source tree.
                _hakus_root = os.path.expanduser("~/.hakus")
                _mem_data_dir = os.path.join(_hakus_root, "data", "memories")
                _mem_vector_dir = os.path.join(_mem_data_dir, "vectors")
                memory_config = MemoryStorage(
                    data_dir=_mem_data_dir,
                    vector_db_path=_mem_vector_dir,
                    max_short_term=self.config.memory.short_term_max,
                    enable_long_term=self.config.memory.long_term_enabled,
                    auto_summary=self.config.memory.auto_summary,
                    summary_interval=self.config.memory.summary_interval,
                )
                self.memory = MemoryManager(memory_config)
                await self.memory.initialize()
                self._component_status["memory"] = "ok"
                logger.info("Memory system initialized")
            except Exception as e:
                self._component_status["memory"] = f"failed: {e}"
                logger.warning(f"Memory init failed (degraded mode): {e}")
            
            # 初始化TTS引擎
            try:
                if self.config.voice.enabled:
                    tts_provider_str = str(self.config.voice.tts.provider.value) if hasattr(self.config.voice.tts.provider, 'value') else str(self.config.voice.tts.provider)
                    tts_config = self.config.voice.tts.model_dump()
                    self.tts_engine = tts_registry.create_engine(tts_provider_str, tts_config)
                    await self.tts_engine.initialize()
                    self._component_status["tts_engine"] = "ok"
                    logger.info(f"TTS engine initialized ({tts_provider_str})")
                else:
                    self._component_status["tts_engine"] = "skipped: voice disabled"
            except Exception as e:
                self._component_status["tts_engine"] = f"failed: {e}"
                logger.warning(f"TTS init failed (degraded mode): {e}")
            
            # 初始化 VTuber handler
            try:
                tts_config = {
                    "type": str(self.config.voice.tts.provider) if self.config.voice.enabled else "cosyvoice",
                }
                try:
                    import yaml
                    import re
                    import os

                    def _resolve_env_vars(obj):
                        if isinstance(obj, str):
                            def _replacer(m):
                                var_name = m.group(1)
                                default_val = m.group(2)
                                return os.environ.get(var_name, default_val or '')
                            return re.sub(r'\$\{(\w+)(?::([^}]*))?\}', _replacer, obj)
                        elif isinstance(obj, dict):
                            return {k: _resolve_env_vars(v) for k, v in obj.items()}
                        elif isinstance(obj, list):
                            return [_resolve_env_vars(item) for item in obj]
                        return obj

                    with open("config.yaml", "r", encoding="utf-8") as f:
                        old_config = yaml.safe_load(f)
                    old_config = _resolve_env_vars(old_config)
                    if old_config and "tts" in old_config:
                        tts_config.update(old_config["tts"])
                        tts_type = tts_config.get("type", "")
                        if tts_type == "cosyvoice" and old_config.get("tts", {}).get("cosyvoice"):
                            tts_config.update(old_config["tts"]["cosyvoice"])
                        elif tts_type == "voxcpm":
                            logger.info("TTS config: using VoxCPM engine")
                except Exception as e:
                    logger.warning(f"Failed to load TTS config: {e}")

                await vtuber_handler.initialize(
                    agent=self.agent,
                    model_adapter=self.model_adapter,
                    tts_config=tts_config
                )
                if getattr(vtuber_handler, "_extension_available", False):
                    self._component_status["vtuber_handler"] = "ok"
                    logger.info("VTuber extension handler initialized")
                else:
                    self._component_status["vtuber_handler"] = "unavailable: extension not installed"
                    logger.info("VTuber extension handler unavailable; core remains usable")
            except Exception as e:
                self._component_status["vtuber_handler"] = f"failed: {e}"
                logger.warning(f"VTuber handler init failed (degraded mode): {e}")
            
            # 设置Agent记忆钩子
            if self.memory and self.agent:
                try:
                    self.agent.add_hook("before_chat", self._before_chat_hook)
                    self.agent.add_hook("after_chat", self._after_chat_hook)
                    self._component_status["agent_hooks"] = "ok"
                except Exception as e:
                    self._component_status["agent_hooks"] = f"failed: {e}"
                    logger.warning(f"Agent hook setup failed: {e}")
            else:
                self._component_status["agent_hooks"] = "skipped: agent or memory unavailable"
            
        except Exception as e:
            # 关键组件失败 — 记录但不抛
            if not critical_failure:
                critical_failure = f"AI init critical failure: {e}"
                logger.error(f"AI init critical failure: {e}", exc_info=True)
        finally:
            # 状态收尾
            if critical_failure is not None:
                self._state = ServerState.FAILED
                self._init_error = critical_failure
                logger.error(f"AI initialization FAILED (critical): {critical_failure}")
            elif any(v.startswith("failed") for v in self._component_status.values()):
                self._state = ServerState.DEGRADED
                failed_optional = [
                    name for name, st in self._component_status.items()
                    if st.startswith("failed") and name not in ("model_adapter", "agent")
                ]
                self._init_error = (
                    f"Some optional components failed: {', '.join(failed_optional)}. "
                    f"Core chat is available."
                ) if failed_optional else None
                logger.warning(f"AI initialization DEGRADED: {self._init_error}")
            else:
                self._state = ServerState.HEALTHY
                self._init_error = None
                logger.info("AI initialization HEALTHY — all components ready")
            
            self._init_finished_at = time.time()
            duration = self._init_finished_at - (self._init_started_at or self._init_finished_at)
            logger.info(f"AI init finished in {duration:.2f}s — state={self._state.value}")

            # ---- 初始化微信 ClawBot 平台（可选组件）----
            try:
                from hakusai_core.v2.platform.wechat import WeChatPlatform, WeChatConfig
                from hakusai_core.v2.platform.base import PlatformConfig, PlatformType
                wechat_cfg = WeChatConfig(enabled=False)  # 默认不启用，需用户主动扫码
                wechat = WeChatPlatform(
                    config=PlatformConfig(platform_type=PlatformType.WECHAT, enabled=False),
                    wechat_config=wechat_cfg,
                )
                platform_manager.register("wechat", wechat)

                # 尝试自动复用已持久化的微信 session
                # 这样后端重启/页面刷新后，如果之前扫码登录过且 session 仍存活，
                # 会自动恢复为 connected 状态，无需重新扫码
                try:
                    await wechat.connect()
                    if wechat.is_connected:
                        logger.info(f"WeChat: Auto-restored session for account {wechat._account_id}")
                    else:
                        logger.info("WeChat: No persisted session to restore, need QR login")
                except Exception as e:
                    logger.debug(f"WeChat: Auto-restore session failed: {e}")

                # 注册消息处理器：微信收到的消息转发给 AgentCore
                async def _on_wechat_message(msg):
                    """微信消息 → AgentCore → 回复（带 typing 状态），同时写入会话列表

                    Concurrency guard: 每个微信用户一把 asyncio.Lock。如果同一条
                    消息被 SDK 重复投递（多 _poll_task / 重连重放 / dedup 漏网），
                    第二个调用会在锁上排队或被丢弃，而不是再起一个完整的 agent
                    turn + 再发一条微信回复。这样就避免了一条入站消息触发 N 条
                    回复的循环。
                    """
                    user_id = msg.metadata.get("user_id", "")
                    if not user_id:
                        logger.warning("WeChat: dropping message with empty user_id")
                        return
                    if not wechat.wechat_config.auto_reply:
                        return

                    lock = await wechat._get_user_lock(user_id)
                    if lock.locked():
                        # 一条消息正在处理中 — 丢弃重复投递，避免 N 个并发 turn
                        logger.warning(
                            f"WeChat: dropping duplicate msg for user_id={user_id} "
                            f"(a turn is already in flight)"
                        )
                        return

                    async with lock:
                        try:
                            from .agent_bridge import run_turn_collect
                            import uuid
                            session_id = f"wechat_{user_id}"
                            # 确保会话存在于 session_store，这样前端左侧栏能看到
                            if not session_store.get_session(session_id):
                                session_store.create_session(
                                    session_id,
                                    title=f"微信: {user_id}",
                                    provider="wechat",
                                )
                            # 存入用户消息
                            user_msg_id = f"msg_{uuid.uuid4().hex[:12]}"
                            session_store.add_message(
                                session_id, user_msg_id, role="user", content=msg.content,
                            )
                            session_store.update_session(session_id, touch_updated=True)
                            # 发送 typing 状态：对方正在输入…
                            if wechat.wechat_config.typing_status:
                                await wechat.send_typing(user_id, typing=True)

                            # Resolve the current default provider LIVE so that
                            # a switch via /api/config/default-model takes effect
                            # immediately for WeChat (not just after restart).
                            wechat_provider = None
                            try:
                                from utils.hakus_config import get_config
                                wechat_provider = get_config().models.default_model or None
                            except Exception:
                                pass

                            # 调用 AgentCore 获取回复
                            result = await run_turn_collect(
                                msg.content, session_id, provider=wechat_provider
                            )
                            reply_text = result.get("content", "") if result else ""
                            failed = bool(result and result.get("failed"))

                            # 存入 AI 回复（即使失败也存一条，方便前端看到错误）
                            if reply_text:
                                ai_msg_id = f"msg_{uuid.uuid4().hex[:12]}"
                                session_store.add_message(
                                    session_id, ai_msg_id, role="assistant", content=reply_text,
                                )
                                session_store.update_session(session_id, touch_updated=True)
                            # 取消 typing 状态
                            if wechat.wechat_config.typing_status:
                                await wechat.send_typing(user_id, typing=False)

                            # Don't relay model-error strings to WeChat —
                            # the user would just see "[Error: 模型调用失败:RateLimitError]"
                            # which is meaningless to them. Send a friendly
                            # fallback instead. (The full error is already in
                            # the session_store and visible in the desktop UI.)
                            if failed or not reply_text:
                                logger.warning(
                                    f"WeChat: agent turn failed for user_id={user_id}, "
                                    f"sending fallback message instead of error string"
                                )
                                fallback = "AI 暂时不可用，请稍后重试"
                                from hakusai_core.v2.platform.base import SendMessage
                                send_msg = SendMessage(
                                    content=fallback, metadata={"user_id": user_id}
                                )
                                await wechat.send_message(send_msg)
                            elif reply_text:
                                from hakusai_core.v2.platform.base import SendMessage
                                send_msg = SendMessage(
                                    content=reply_text, metadata={"user_id": user_id}
                                )
                                await wechat.send_message(send_msg)
                        except Exception as e:
                            logger.error(f"WeChat message handler error: {e}")
                            # 出错也要取消 typing
                            try:
                                if wechat.wechat_config.typing_status:
                                    await wechat.send_typing(user_id, typing=False)
                            except Exception:
                                pass

                wechat.on_message(_on_wechat_message)
                logger.info("WeChat ClawBot platform registered (disabled by default)")
            except Exception as e:
                logger.debug(f"WeChat ClawBot platform not available: {e}")

            # 无论成功失败都 set，让 chat 端点能感知初始化已结束
            self._init_event.set()
    
    async def _ensure_ready(self, timeout: float = 10.0) -> bool:
        """
        等待 AI 初始化完成（成功或失败）。
        
        - 返回 True: 初始化已结束（不代表成功，调用方需再检查 self.agent）
        - 返回 False: 超时仍未结束
        """
        try:
            await asyncio.wait_for(self._init_event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False
    
    def _build_health_payload(self) -> Dict[str, Any]:
        """构造 /health 响应体（lifespan 起飞后任何时刻都可调用）"""
        ready = self.agent is not None
        duration = None
        if self._init_started_at and self._init_finished_at:
            duration = round(self._init_finished_at - self._init_started_at, 2)
        elif self._init_started_at:
            duration = round(time.time() - self._init_started_at, 2)
        return {
            "status": self._state.value,
            "ready": ready,
            "version": "0.1.0",
            "model_loaded": self.model_adapter is not None,
            "agent_ready": self.agent is not None,
            "memory_ready": self.memory is not None,
            "tts_ready": self.tts_engine is not None,
            "error": self._init_error,
            "init_duration_s": duration,
        }
    
    async def _before_chat_hook(self, user_input: str, context: AgentContext):
        """对话前钩子 - 加载记忆上下文"""
        if not self.memory:
            return
        
        # 获取相关记忆
        memory_context = await self.memory.get_context_for_model(
            max_short_term=10,
            max_long_term=3,
            query=user_input
        )
        
        if memory_context:
            # 将记忆添加到Agent的历史中
            for msg in memory_context:
                if msg["role"] != "system":  # 避免重复添加系统消息
                    self.agent._message_history.append(Message(
                        role=MessageRole(msg["role"]),
                        content=msg["content"]
                    ))
    
    async def _after_chat_hook(self, user_input: str, context: AgentContext):
        """对话后钩子 - 保存到记忆"""
        if not self.memory:
            return
        
        # 保存用户消息
        await self.memory.add_message("user", user_input)
        
        # 保存助手回复（从Agent历史中获取最后一条）
        if self.agent._message_history:
            last_msg = self.agent._message_history[-1]
            if last_msg.role == MessageRole.ASSISTANT:
                await self.memory.add_message("assistant", last_msg.content)
    
    def create_app(self) -> FastAPI:
        """创建FastAPI应用"""
        
        @asynccontextmanager
        async def lifespan(app: FastAPI):
            """
            应用生命周期管理 — Phase 1 异步化版本。
            
            关键改动：AI 组件初始化不再阻塞 lifespan。我们：
            1. 启动 event_bus
            2. 把 _init_ai_components 丢到后台 task
            3. 立即 yield，让 FastAPI 开始服务（/health 此刻可响应 status=initializing）
            4. 关闭时：先等/取消后台 task，再优雅关闭组件
            """
            # 启动时
            setup_logging()
            logger.info("Starting HakusAI Server...")

            # 加载用户配置 ~/.hakus/config.yaml。
            # 之前这里没加载，导致 AI 初始化一直用 schema 默认值（deepseek），
            # 即使用户在 UI 里设置了 OpenCode 也不生效。
            config_path = os.environ.get(
                "HAKUS_CONFIG_PATH",
                os.path.expanduser("~/.hakus/config.yaml"),
            )
            try:
                await config_manager.load(config_path)
                self.config = config_manager.config
                logger.info(f"Loaded user config from {config_path}")
            except Exception as e:
                logger.warning(f"Failed to load user config from {config_path}: {e}")

            await event_bus.start()
            # 标记进入初始化中（_init_ai_components 内部也会设）
            self._state = ServerState.INITIALIZING
            # 后台启动 AI 初始化 — 不阻塞 lifespan
            self._init_task = asyncio.create_task(self._init_ai_components())
            # 添加 done 回调，记录未捕获异常
            def _log_init_failure(fut: asyncio.Task):
                if fut.cancelled():
                    logger.warning("AI init task was cancelled.")
                    return
                exc = fut.exception()
                if exc is not None:
                    # _init_ai_components 内部已 try/except，这里只是兜底
                    logger.error(f"AI init task crashed unexpectedly: {exc}", exc_info=exc)
            self._init_task.add_done_callback(_log_init_failure)
            
            # Start MCP servers from ~/.hakus/config.yaml (Phase 2 round 2).
            # Non-blocking: failures don't crash the sidecar unless fail_fast=True
            # in the global mcp: config section.
            try:
                from hakus.mcp.manager import get_mcp_manager
                mcp_mgr = get_mcp_manager()
                if mcp_mgr is not None:
                    logger.info("[MCP] starting servers from config...")
                    await mcp_mgr.start_all_from_config()
                    statuses = mcp_mgr.list_servers_status()
                    running = sum(1 for s in statuses if s.get("status") == "running")
                    failed = sum(1 for s in statuses if s.get("status") == "failed")
                    logger.info(
                        f"[MCP] startup complete: {running} running, "
                        f"{failed} failed, {len(statuses)} total"
                    )
            except Exception as e:
                logger.warning(f"[MCP] startup failed (non-blocking): {e}", exc_info=True)

            # Phase 4: Start WebSocket heartbeat + cleanup background loops.
            # Non-blocking: failures don't crash the sidecar.
            try:
                await self.websocket_manager.start_background_loops()
                logger.info(
                    f"[WS] background loops started "
                    f"(heartbeat={self.websocket_manager.HEARTBEAT_INTERVAL_S}s, "
                    f"cleanup={self.websocket_manager.CLEANUP_INTERVAL_S}s, "
                    f"stale={self.websocket_manager.STALE_THRESHOLD_S}s)"
                )
            except Exception as e:
                logger.warning(f"[WS] background loops start failed: {e}", exc_info=True)

            # Start automation scheduler (Codex-style scheduled turns).
            # Non-blocking: failures don't crash the sidecar.
            try:
                from .automations import get_scheduler
                await get_scheduler().start()
            except Exception as e:
                logger.warning(f"automation scheduler start failed: {e}", exc_info=True)

            yield
            
            # Stop the automation scheduler first so no new turns fire
            # while we tear down AI components.
            try:
                from .automations import get_scheduler
                await get_scheduler().stop()
            except Exception as e:
                logger.warning(f"automation scheduler stop failed: {e}")

            # 关闭时
            logger.info("Shutting down HakusAI Server...")
            # 如果 init 还没完成，等它结束（最多 5s），避免资源没释放
            if self._init_task is not None and not self._init_task.done():
                logger.info("Waiting for in-flight AI init to finish before shutdown...")
                try:
                    await asyncio.wait_for(self._init_task, timeout=5.0)
                except asyncio.TimeoutError:
                    logger.warning("AI init still running after 5s, cancelling...")
                    self._init_task.cancel()
                    try:
                        await self._init_task
                    except asyncio.CancelledError:
                        pass
                except Exception as e:
                    logger.warning(f"AI init task raised during shutdown: {e}")
            
            # 优雅关闭已初始化的组件
            if self.memory:
                try:
                    await self.memory.close()
                except Exception as e:
                    logger.warning(f"Memory close failed: {e}")
            if self.model_adapter:
                try:
                    await self.model_adapter.close()
                except Exception as e:
                    logger.warning(f"Model adapter close failed: {e}")
            try:
                await event_bus.stop()
            except Exception as e:
                logger.warning(f"Event bus stop failed: {e}")
            
            # Stop all MCP servers (Phase 2 round 2)
            try:
                from hakus.mcp.manager import get_mcp_manager
                mcp_mgr = get_mcp_manager()
                if mcp_mgr is not None:
                    logger.info("[MCP] stopping all servers...")
                    await mcp_mgr.stop_all()
                    logger.info("[MCP] all servers stopped")
            except Exception as e:
                logger.warning(f"[MCP] stop_all failed: {e}")

            # Phase 4: Stop WebSocket background loops (heartbeat + cleanup)
            try:
                await self.websocket_manager.stop_background_loops()
                logger.info("[WS] background loops stopped")
            except Exception as e:
                logger.warning(f"[WS] background loops stop failed: {e}")

            # Disconnect WeChat platform so its _poll_task is cancelled
            # before the process exits. Without this, a restarted backend
            # would briefly coexist with the previous process's still-running
            # poll loop, and both would receive + handle the same inbound
            # WeChat message → duplicate replies.
            try:
                wechat_plat = platform_manager.get("wechat")
                if wechat_plat is not None and getattr(wechat_plat, "_connected", False):
                    logger.info("[WeChat] disconnecting on shutdown...")
                    await wechat_plat.disconnect()
                    logger.info("[WeChat] disconnected")
            except Exception as e:
                logger.warning(f"[WeChat] disconnect on shutdown failed: {e}")
        
        app = FastAPI(
            title="HakusAI API",
            description="HakusAI AI虚拟助手API",
            version="0.1.0",
            lifespan=lifespan
        )
        
        # CORS中间件
        app.add_middleware(
            CORSMiddleware,
            allow_origins=self.config.server.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
        # 注册路由
        self._register_routes(app)
        
        # 挂载静态文件（前端）- 优先使用新的 React 前端
        stage_web_dist = Path(__file__).parent.parent.parent / "stage-web" / "dist"
        webui_dist = Path(__file__).parent.parent.parent / "webui" / "dist"

        if stage_web_dist.exists():
            app.mount("/assets", StaticFiles(directory=stage_web_dist / "assets"), name="assets")

            @app.get("/{full_path:path}")
            async def serve_spa(full_path: str):
                file_path = stage_web_dist / full_path
                if file_path.exists() and file_path.is_file():
                    return FileResponse(file_path)
                return FileResponse(stage_web_dist / "index.html")

            logger.info(f"Stage-Web mounted from {stage_web_dist}")
        elif webui_dist.exists():
            app.mount("/assets", StaticFiles(directory=webui_dist / "assets"), name="assets")

            @app.get("/{full_path:path}")
            async def serve_spa(full_path: str):
                file_path = webui_dist / full_path
                if file_path.exists() and file_path.is_file():
                    return FileResponse(file_path)
                return FileResponse(webui_dist / "index.html")

            logger.info(f"WebUI mounted from {webui_dist}")
        
        # ── P5 Observability: Mount Prometheus /metrics endpoint ──
        try:
            from hakus.observability.prometheus_metrics import metrics_registry
            metrics_registry.mount_metrics_endpoint(app)
            logger.info("Prometheus /metrics endpoint mounted (P5 observability)")
        except ImportError:
            logger.warning("prometheus_client not installed — /metrics endpoint unavailable")
        except Exception as e:
            logger.warning(f"Failed to mount /metrics endpoint: {e}")

        # ── P5 Observability: Mount MetricsMiddleware for HTTP latency tracking ──
        try:
            from hakus.observability.metrics_middleware import MetricsMiddleware
            app.add_middleware(MetricsMiddleware)
            logger.info("MetricsMiddleware mounted (P5 HTTP request tracking)")
        except ImportError:
            logger.warning("observability.metrics_middleware not available — HTTP metrics disabled")
        except Exception as e:
            logger.warning(f"Failed to mount MetricsMiddleware: {e}")

        # ── P3 Evolution: Mount checkpoint/restore/heartbeat/long-running endpoints ──
        try:
            from hakus.p3_api import mount_p3_routes
            mount_p3_routes(app)
            logger.info("P3 evolution API routes mounted (/api/sessions/{id}/checkpoints, /heartbeat, etc.)")
        except ImportError:
            logger.warning("hakus.p3_api not available — P3 evolution endpoints not mounted")
        except Exception as e:
            logger.warning(f"Failed to mount P3 routes: {e}")

        # ── LongRunningAgent status endpoint ──
        try:
            from hakus.long_running_agent import LongRunningAgent
            # Expose long-running agent status via /api/long-running/health
            @app.get("/api/long-running/health")
            async def long_running_health():
                """LongRunningAgent liveness check — for 5h SWE task monitoring.

                Returns the agent's heartbeat status, session info, and
                checkpoint recovery availability. Used by sidecar health
                monitors and the desktop client's task status panel.
                """
                # Delegate to LongRunningAgent global instance if available
                try:
                    from hakus.observability.prometheus_metrics import metrics_registry as mr
                    import prometheus_client as prom
                    gauge_val = mr.active_sessions._value.get()
                except Exception:
                    gauge_val = 0

                return {
                    "status": "alive",
                    "active_sessions": gauge_val,
                    "p3_routes_mounted": True,
                    "prometheus_available": True,
                }
        except Exception as e:
            logger.warning(f"Failed to mount long-running health endpoint: {e}")

        self.app = app
        return app
    
    def _register_routes(self, app: FastAPI):
        """注册API路由"""
        
        # 中间件：记录所有 /api/ 请求的耗时和状态码，方便诊断"卡住"问题
        @app.middleware("http")
        async def log_api_requests(request, call_next):
            path = request.url.path
            if path.startswith("/api/") or path == "/health":
                t0 = time.time()
                try:
                    response = await call_next(request)
                    dt = (time.time() - t0) * 1000
                    if dt > 1000:  # 超过 1s 的请求记 warning
                        logger.warning(f"SLOW {request.method} {path} -> {response.status_code} in {dt:.0f}ms")
                    else:
                        logger.info(f"{request.method} {path} -> {response.status_code} in {dt:.0f}ms")
                    return response
                except Exception as e:
                    dt = (time.time() - t0) * 1000
                    logger.error(f"ERROR {request.method} {path} -> {e} in {dt:.0f}ms")
                    raise
            return await call_next(request)
        
        @app.get("/")
        async def root():
            """根路径"""
            return {
                "name": "HakusAI",
                "version": "0.1.0",
                "status": "running"
            }

        @app.get("/api/version")
        async def get_version():
            """
            返回 sidecar API 版本 — 客户端用来检测 sidecar 是否过旧。

            场景：用户更新了客户端 (electron app)，但 Windows NSIS 安装时
            sidecar.exe 可能因为旧进程仍占用、杀软拦截、用户覆盖安装时
            选了"保留旧文件"等原因没被替换。这时客户端会向旧 sidecar 发
            请求，遇到一堆莫名其妙的 404。

            客户端启动时调 /api/version，如果 version < 期望版本，直接
            提示用户「sidecar 版本过旧，请重新下载最新版客户端」。
            """
            return {
                "sidecar_api_version": SIDECAR_API_VERSION,
                "sidecar_api_version_int": SIDECAR_API_VERSION_INT,
                "server_version": "0.1.0",
                "use_agentcore_for_chat": USE_AGENTCORE_FOR_CHAT,
                **execution_plane_metadata(),
                "agentcore_tools_count": 24,  # hakus/tools/builtin — kept in sync manually
                "endpoints": [
                    "/api/config/providers",
                    "/api/character",
                    "/api/memory/details",
                    "/api/tools",
                    "/api/skills",
                    "/api/skills/install",
                    "/api/permission",
                    "/api/config/export",
                    "/api/diagnostics",
                    "/api/metrics",
                    "/metrics",  # Prometheus text format
                    "/api/agentcore/status",
                    "/api/sessions",
                    "/api/sessions/{id}/messages",
                    "/api/sessions/{id}/checkpoints",
                    "/api/sessions/{id}/restore/latest",
                    "/api/sessions/{id}/restore/{checkpoint_id}",
                    "/api/sessions/{id}/heartbeat",
                    "/api/sessions/{id}/status",
                    "/api/long-running/status",
                    "/api/long-running/health",
                ],
            }

        def _skill_project_dir(project_id: Optional[str]) -> Optional[Path]:
            from . import projects as _projects
            resolved = _projects.resolve_working_dir(project_id)
            return Path(resolved) if resolved else None

        def _message_with_selected_skills(
            message: str,
            working_dir: Optional[str],
        ) -> str:
            from .skills import SkillError, expand_skill_mentions
            try:
                project_dir = Path(working_dir) if working_dir else None
                return expand_skill_mentions(message, project_dir=project_dir)
            except SkillError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        @app.get("/api/skills")
        async def list_desktop_skills(project_id: Optional[str] = None):
            """List user-installed Skills visible to the active project."""
            from .skills import SkillError, discover_skills
            try:
                return discover_skills(project_dir=_skill_project_dir(project_id))
            except SkillError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc

        @app.post("/api/skills/install")
        async def install_desktop_skill(request: SkillInstallRequest):
            """Install one Skill from an explicit local or remote source."""
            from .skills import SkillError, install_skill
            try:
                return install_skill(
                    request.source,
                    scope=request.scope,
                    project_dir=_skill_project_dir(request.project_id),
                )
            except SkillError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        @app.post("/api/skills/{name}")
        async def toggle_desktop_skill(name: str, request: SkillToggleRequest):
            from .skills import SkillError, set_enabled
            try:
                return set_enabled(
                    name,
                    request.enabled,
                    project_dir=_skill_project_dir(request.project_id),
                )
            except SkillError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        @app.delete("/api/skills/{name}")
        async def remove_desktop_skill(
            name: str,
            scope: Optional[str] = None,
            project_id: Optional[str] = None,
        ):
            from .skills import SkillError, remove_skill
            try:
                return remove_skill(
                    name,
                    scope=scope,
                    project_dir=_skill_project_dir(project_id),
                )
            except SkillError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        @app.get("/api/agentcore/status")
        async def agentcore_status():
            """Return AgentCore integration status.

            Lets the desktop client verify that the sidecar is using
            the new AgentCore path (24 tools + permissions + AgentEvent
            stream) vs. the legacy BaseAgent chat-only path.
            """
            from .agent_bridge import _agent_cache
            return {
                "use_agentcore_for_chat": USE_AGENTCORE_FOR_CHAT,
                "active_sessions": list(_agent_cache.keys()),
                "session_count": len(_agent_cache),
                "tools_available": USE_AGENTCORE_FOR_CHAT,
                "legacy_provider_adapter": {
                    "state": "compatibility",
                    "fallback_policy": "disabled",
                    "canonical_plane": "rust_runtime",
                },
                "active_provider_bindings": agentcore_provider_adapter_diagnostics(),
                "permission_mode_default": "ask",
                "auto_approve_in_sidecar": True,  # no UI to prompt
                "stream_event_types": [
                    "text_delta", "reasoning_delta",
                    "tool_call_started", "tool_call_finished",
                    "token_usage",
                    "turn_completed", "turn_failed", "cancelled",
                ],
            }

        @app.get("/health")
        async def health_check():
            """
            健康检查 — Phase 1 三态版本。
            
            始终返回 200（只要 FastAPI 起来了就返回），通过 status 字段告诉客户端真实状态：
            - starting:      进程刚启动
            - initializing:  AI 组件正在后台初始化
            - healthy:       所有关键组件就绪，可正常对话
            - degraded:      关键组件就绪，TTS/Memory 等可选组件部分失败
            - failed:        关键组件初始化失败（如 API key 缺失），chat 不可用
            
            sidecar.ts 应当：
            - status == healthy 或 degraded: 视为可用，停止轮询
            - status == starting 或 initializing: 继续轮询
            - status == failed: 立即停止轮询，向用户展示 error
            """
            payload = self._build_health_payload()
            payload.update(execution_plane_metadata())
            return payload
        
        @app.get("/api/diagnostics")
        async def diagnostics():
            """
            诊断端点 — 返回详细的初始化状态，方便前端展示具体错误。
            
            用于 sidecar 健康检查失败时，UI 可以直接拉这个端点告诉用户
            "你的 DeepSeek API key 没配" 而不是只显示 "sidecar 30s 超时"。
            """
            payload = self._build_health_payload()
            payload.update(execution_plane_metadata())
            payload["components"] = dict(self._component_status)
            payload["init_started_at"] = self._init_started_at
            payload["init_finished_at"] = self._init_finished_at
            # 列出已注册的模型 provider
            try:
                payload["registered_providers"] = model_registry.list_providers()
            except Exception:
                payload["registered_providers"] = []
            # 当前 provider 配置
            try:
                model_config = self.config.model.model_dump()
                provider_value = model_config.get("provider", "deepseek")
                provider = provider_value.value if hasattr(provider_value, 'value') else str(provider_value)
                payload["configured_provider"] = provider
                payload["configured_model_name"] = model_config.get("model_name")
            except Exception as e:
                payload["configured_provider"] = f"<error: {e}>"
            return payload

        @app.get("/api/metrics")
        async def get_metrics():
            """
            Phase 5+ Enhanced: 服务端 metrics 端点 — 5h SWE 任务可观测性。

            返回 since-process-start 的累计计数器 + 实时 active_websockets。
            客户端 AdvancedPanel 显示这些数字, 让用户能直观看到:
              - 服务运行了多久 (uptime_seconds)
              - 处理了多少 turn / 多少 LLM 调用
              - 错误率 (total_errors / total_turns)
              - 当前 WebSocket 连接数
              - checkpoint 保存次数 (5h 长任务的关键指标)

            P5 增强字段:
              - prometheus: Prometheus histogram/counter 快照 (如果可用)
              - guardian: Guardian AI 审批统计
              - long_running: 长任务会话状态

            所有字段都是非负整数 (除 uptime_seconds 是 float)。
            """
            base = self.get_metrics_snapshot()

            # P5: Enrich with Prometheus histogram/counter snapshot
            try:
                from hakus.observability.prometheus_metrics import metrics_registry
                base["prometheus"] = metrics_registry.get_json_snapshot()
            except Exception:
                base["prometheus"] = {"available": False}

            # P5: Guardian AI stats
            try:
                from hakus.guardian_config import get_guardian_status
                base["guardian"] = get_guardian_status()
            except Exception:
                base["guardian"] = {"available": False}

            # P5: P3 route availability
            base["p3_routes"] = {
                "checkpoints": "/api/sessions/{id}/checkpoints",
                "restore_latest": "/api/sessions/{id}/restore/latest",
                "restore_specific": "/api/sessions/{id}/restore/{checkpoint_id}",
                "heartbeat": "/api/sessions/{id}/heartbeat",
                "session_status": "/api/sessions/{id}/status",
                "long_running_status": "/api/long-running/status",
                "long_running_health": "/api/long-running/health",
                "prometheus_metrics": "/metrics",
            }

            return base

        # ========== 日志API ==========

        @app.get("/api/logs")
        async def get_logs(
            name: Optional[str] = None,
            lines: int = 200,
            level: Optional[str] = None,
            after_ts: Optional[float] = None,
        ):
            """
            获取 sidecar 结构化日志。

            - name: 日志文件名，如 sidecar.log / agent.log / orchestrator.log / tools.log / llm.log
            - lines: 返回最近多少行（默认 200，最大 5000）
            - level: 过滤级别 DEBUG/INFO/WARNING/ERROR
            - after_ts: 只返回该 unix 时间戳之后的日志（用于实时轮询）
            """
            from .logging_config import log_tailer

            if lines < 1:
                lines = 1
            if lines > 5000:
                lines = 5000

            # 默认返回 sidecar.log
            if not name:
                files = log_tailer.list_files()
                if not files:
                    return {"files": [], "logs": []}
                name = files[0]["name"]

            try:
                logs = log_tailer.tail(name, lines=lines, level=level, after_ts=after_ts)
                files = log_tailer.list_files()
            except Exception as e:
                logger.error(f"Failed to read logs: {e}")
                raise HTTPException(status_code=500, detail=f"Failed to read logs: {e}")

            return {"files": [{"name": f["name"], "size": f["size"], "mtime": f["mtime"]} for f in files], "logs": logs}

        @app.get("/api/logs/files")
        async def list_log_files():
            """列出所有可用的日志文件。"""
            from .logging_config import log_tailer
            return {"files": log_tailer.list_files()}

        @app.delete("/api/logs")
        async def clear_logs(name: Optional[str] = None):
            """清空指定日志文件；name 为空时清空所有日志文件。"""
            from .logging_config import LOG_DIR, LOG_FILES

            cleared: List[str] = []
            failed: List[str] = []
            targets = [LOG_DIR / name] if name else list(LOG_DIR.glob("*.log"))
            for path in targets:
                try:
                    if path.exists():
                        path.write_text("", encoding="utf-8")
                        cleared.append(path.name)
                except Exception as e:
                    failed.append(f"{path.name}: {e}")

            if failed:
                raise HTTPException(status_code=500, detail={"cleared": cleared, "failed": failed})
            return {"cleared": cleared}

        # ========== 聊天API ==========
        
        @app.post("/api/chat")
        async def chat(request: ChatRequest):
            """
            聊天接口（非流式）

            请求体:
            {
                "message": "你好",
                "session_id": "default",
                "stream": false
            }

            当 USE_AGENTCORE_FOR_CHAT=True 时，走 hakus.AgentCore
            (24 工具 + 权限流 + AgentEvent 协议); 否则回退到旧
            BaseAgent 单轮聊天路径。
            """
            # Phase 1: 如果还在初始化中，先等一下（最多 10s）
            if not await self._ensure_ready(timeout=10.0):
                raise HTTPException(
                    status_code=503,
                    detail="AI still initializing, please retry in a few seconds"
                )

            # AgentCore 路径 — 不需要 self.agent (BaseAgent) 就绪，
            # 它自己会 lazy-init LLM client。但要求 model_adapter 至少
            # 初始化过（说明 API key 配了）—— 否则给具体错误。
            if USE_AGENTCORE_FOR_CHAT:
                if not self.model_adapter:
                    raise HTTPException(
                        status_code=503,
                        detail=f"Model not initialized: {self._init_error or 'unknown reason'}"
                    )
                try:
                    logger.info(f"Chat (AgentCore): {request.message[:80]} provider={request.provider or 'default'}")
                    # Phase 5: 非 streaming 也计 turn
                    self._inc_metric("total_turns", provider=request.provider or "default")
                    # Resolve active project (if any) — same as streaming path.
                    from . import projects as _projects
                    working_dir = _projects.resolve_working_dir(getattr(request, "project_id", None))
                    selected_message = _message_with_selected_skills(
                        request.message, working_dir,
                    )
                    result = await agentcore_run_turn_collect(
                        selected_message, request.session_id,
                        provider=request.provider,
                        run_mode=getattr(request, "run_mode", None),
                        working_dir=working_dir,
                    )
                    if result.get("failed"):
                        self._inc_metric("total_errors", provider=request.provider or "default")
                    logger.info(
                        f"Chat response: {result['content'][:100]}... "
                        f"(iter={result.get('iterations')}, "
                        f"in_tok={result.get('input_tokens')}, "
                        f"out_tok={result.get('output_tokens')})"
                    )
                    return result
                except Exception as e:
                    logger.error(f"AgentCore chat error: {e}", exc_info=True)
                    self._inc_metric("total_errors", provider=request.provider or "default")
                    raise HTTPException(status_code=500, detail=str(e))

            # 旧路径 (BaseAgent)
            if not self.agent:
                raise HTTPException(
                    status_code=503,
                    detail=f"Agent not initialized: {self._init_error or 'unknown reason'}"
                )

            try:
                logger.info(f"Chat request: {request.message}")
                legacy_working_dir = _skill_project_dir(getattr(request, "project_id", None))
                selected_message = _message_with_selected_skills(
                    request.message, legacy_working_dir,
                )
                context = AgentContext(
                    session_id=request.session_id,
                    user_id="default"
                )

                # 收集完整响应
                full_content = ""
                emotion = None
                actions = []

                async for response in self.agent.chat(selected_message, context, stream=False):
                    full_content = response.content
                    emotion = response.emotion
                    actions = response.actions
                    logger.debug(f"Response chunk: {response.content[:50]}...")

                logger.info(f"Chat response: {full_content[:100]}...")

                return {
                    "content": full_content,
                    "emotion": emotion,
                    "actions": actions,
                    "session_id": request.session_id
                }

            except Exception as e:
                logger.error(f"Chat error: {e}")
                import traceback
                logger.error(traceback.format_exc())
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/chat/stream")
        async def chat_stream(request: ChatRequest):
            """
            聊天接口（流式）

            返回SSE流。每个事件是 ``data: {json}\\n\\n``。

            AgentCore 路径会发更丰富的事件类型 (event_type 字段):
              - text_delta / reasoning_delta / tool_call_started /
                tool_call_finished / token_usage / turn_completed /
                turn_failed / cancelled

            旧前端只看 content + done, 这些字段在所有事件里都保留。
            新前端可以按 event_type 路由渲染。
            """
            # Phase 1: 等初始化完成，否则发 503
            if not await self._ensure_ready(timeout=10.0):
                raise HTTPException(
                    status_code=503,
                    detail="AI still initializing, please retry in a few seconds"
                )

            if USE_AGENTCORE_FOR_CHAT:
                if not self.model_adapter:
                    raise HTTPException(
                        status_code=503,
                        detail=f"Model not initialized: {self._init_error or 'unknown reason'}"
                    )

                async def generate_agentcore():
                    # Phase 5: 计 turn + 跟踪 LLM/checkpoint 事件
                    self._inc_metric("total_turns", provider=request.provider or "default")
                    turn_failed = False
                    # Resolve the active project's folder (if any) so the
                    # agent's file/shell tools operate inside it.
                    from . import projects as _projects
                    working_dir = _projects.resolve_working_dir(getattr(request, "project_id", None))
                    try:
                        selected_message = _message_with_selected_skills(
                            request.message, working_dir,
                        )
                        async for chunk in agentcore_run_turn_stream(
                            selected_message, request.session_id,
                            provider=request.provider,
                            run_mode=getattr(request, "run_mode", None),
                            reasoning_effort=getattr(request, "reasoning_effort", None),
                            working_dir=working_dir,
                        ):
                            # 从 chunk 中提取事件类型, 更新 metrics
                            etype = chunk.get("event_type", "")
                            if etype == "token_usage":
                                # 每个 token_usage 事件 ≈ 一次 LLM 调用
                                self._inc_metric("llm_calls", provider=request.provider or "default")
                            elif etype == "checkpoint_saved":
                                self._inc_metric("checkpoints_saved")
                            elif etype == "turn_completed":
                                pass  # 成功结束
                            elif etype == "turn_failed":
                                turn_failed = True
                                self._inc_metric("total_errors", provider=request.provider or "default")
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                            # 审批流：把新产生的 pending approval 注入 SSE 流,
                            # 前端弹 glass 审批对话框。
                            # 时序：approval 在 tool_call_started 之后、
                            # tool_call_finished 之前创建（工具执行中被回调阻塞），
                            # 所以下一个 chunk 不会到来 —— 必须在 started 后
                            # 主动短轮询 drain，否则 approval_required 永远发不出。
                            try:
                                from .approvals import get_store as _get_ap_store
                                _ap_store = _get_ap_store()
                                _ap_retries = 6 if etype == "tool_call_started" else 1
                                for _ in range(_ap_retries):
                                    _new_ap = _ap_store.drain_new(request.session_id)
                                    if _new_ap:
                                        for _ap in _new_ap:
                                            _ap_chunk = {
                                                'content': '',
                                                'emotion': None,
                                                'actions': [],
                                                'done': False,
                                                'event_type': 'approval_required',
                                                'approval': _ap.to_dict(),
                                            }
                                            yield "data: " + json.dumps(_ap_chunk, ensure_ascii=False) + "\n\n"
                                    if _ap_retries <= 1:
                                        break
                                    await asyncio.sleep(0.25)
                            except Exception as _ap_err:
                                logger.debug(f"approval drain failed: {_ap_err}")
                    except Exception as e:
                        logger.error(f"AgentCore stream error: {e}", exc_info=True)
                        if not turn_failed:
                            self._inc_metric("total_errors", provider=request.provider or "default")
                        err = {
                            "content": "",
                            "emotion": None,
                            "actions": [],
                            "done": True,
                            "event_type": "turn_failed",
                            "error": str(e),
                            "code": "stream_error",
                        }
                        yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"

                return StreamingResponse(
                    generate_agentcore(),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    }
                )

            # 旧路径
            if not self.agent:
                raise HTTPException(
                    status_code=503,
                    detail=f"Agent not initialized: {self._init_error or 'unknown reason'}"
                )

            async def generate():
                try:
                    legacy_working_dir = _skill_project_dir(getattr(request, "project_id", None))
                    selected_message = _message_with_selected_skills(
                        request.message, legacy_working_dir,
                    )
                    context = AgentContext(
                        session_id=request.session_id,
                        user_id="default"
                    )

                    async for response in self.agent.chat(selected_message, context, stream=True):
                        data = {
                            "content": response.content,
                            "emotion": response.emotion,
                            "actions": response.actions,
                            "done": False
                        }
                        yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

                    # 发送结束标记
                    yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"

                except Exception as e:
                    logger.error(f"Stream chat error: {e}")
                    yield f"data: {json.dumps({'error': str(e), 'done': True}, ensure_ascii=False)}\n\n"

            return StreamingResponse(
                generate(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            )
        
        @app.post("/api/chat/message")
        async def chat_message(request: ChatRequest):
            """
            简单聊天接口（兼容前端）
            返回JSON格式
            """
            # Phase 1: 等初始化完成
            if not await self._ensure_ready(timeout=10.0):
                return {
                    "error": "AI still initializing, please retry in a few seconds",
                    "success": False,
                    "retry_after_s": 2,
                }

            # AgentCore 路径
            if USE_AGENTCORE_FOR_CHAT:
                if not self.model_adapter:
                    return {
                        "error": f"Model not initialized: {self._init_error or 'unknown reason'}",
                        "success": False,
                    }
                try:
                    from . import projects as _projects
                    msg_working_dir = _projects.resolve_working_dir(getattr(request, "project_id", None))
                    selected_message = _message_with_selected_skills(
                        request.message, msg_working_dir,
                    )
                    result = await agentcore_run_turn_collect(
                        selected_message, request.session_id,
                        provider=request.provider,
                        run_mode=getattr(request, "run_mode", None),
                        reasoning_effort=getattr(request, "reasoning_effort", None),
                        working_dir=msg_working_dir,
                    )
                    return {
                        "success": not result.get("failed", False),
                        "data": {
                            "content": result["content"],
                            "role": "assistant",
                            "iterations": result.get("iterations", 0),
                            "input_tokens": result.get("input_tokens", 0),
                            "output_tokens": result.get("output_tokens", 0),
                            "cache_hit_tokens": result.get("cache_hit_tokens", 0),
                            "cache_miss_tokens": result.get("cache_miss_tokens", 0),
                        },
                        "error": result.get("error"),
                    }
                except Exception as e:
                    logger.error(f"AgentCore chat_message error: {e}", exc_info=True)
                    return {"success": False, "error": str(e)}

            # 旧路径
            if not self.agent:
                return {
                    "error": f"Agent not initialized: {self._init_error or 'unknown reason'}",
                    "success": False,
                }

            try:
                legacy_working_dir = _skill_project_dir(getattr(request, "project_id", None))
                selected_message = _message_with_selected_skills(
                    request.message, legacy_working_dir,
                )
                context = AgentContext(
                    session_id=request.session_id,
                    user_id="default"
                )

                # 收集完整响应
                full_content = ""

                async for response in self.agent.chat(selected_message, context, stream=False):
                    full_content = response.content

                return {
                    "success": True,
                    "data": {
                        "content": full_content,
                        "role": "assistant"
                    }
                }

            except Exception as e:
                logger.error(f"Chat error: {e}")
                return {
                    "success": False,
                    "error": str(e)
                }

        @app.post("/api/question/answer")
        async def answer_question(request: AnswerQuestionRequest):
            """回答 Agent 在执行过程中通过 ask_user 提出的问题.

            客户端收到 event_type=question_asked 的流式事件后,展示选项;
            用户选择后调用此端点,把 AnswerOp 推入对应 session 的
            op_receiver 队列,AgentCore 收到后继续执行.
            """
            try:
                ok = agentcore_post_answer(
                    request.session_id,
                    request.question_id,
                    request.choice,
                )
                if not ok:
                    raise HTTPException(
                        status_code=404,
                        detail="No active question for this session",
                    )
                return {"success": True}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"answer_question error: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        # ========== Session 持久化 API (SQLite) ==========
        # 替代前端 localStorage 的会话存储. 用户在桌面客户端看到的所有
        # chat 历史 (sessions + messages) 都持久化在 ~/.hakus/sessions.db.
        #
        # 设计:
        #   - Sessions / messages 通过 REST CRUD 接口管理
        #   - Streaming 期间前端只更新 in-memory state, stream 结束时
        #     一次性 PATCH 最终 message (content + reasoning + tool_calls)
        #   - User 消息在 send 时立即 POST (它已经是 final 状态)
        #   - 跨设备同步留 Phase 3 (现在只解决"localStorage 5MB 上限 +
        #     浏览器缓存清空就丢"的问题)

        @app.get("/api/sessions")
        async def list_sessions_api(tree: int = 0):
            """列出所有 sessions (按 updated_at 倒序, pinned 优先).
            不返回 messages — 客户端按需 GET /api/sessions/{id} 拉详情.
            tree=1 时返回父子树 (Codex thread tree): 每项带 children 列表,
            顶层仅包含无 parent 的会话."""
            try:
                sessions = session_store.list_sessions()
                if not tree:
                    return {"sessions": sessions}
                by_id = {s["id"]: {**s, "children": []} for s in sessions}
                roots = []
                for s in sessions:
                    node = by_id[s["id"]]
                    parent = s.get("parent_id")
                    if parent and parent in by_id:
                        by_id[parent]["children"].append(node)
                    else:
                        roots.append(node)
                return {"sessions": roots}
            except Exception as e:
                logger.error(f"list_sessions failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/sessions")
        async def create_session_api(req: SessionCreateRequest):
            """创建 session. 客户端生成 UUID (s_xxx), 服务端只负责持久化."""
            try:
                return session_store.create_session(
                    session_id=req.id,
                    title=req.title,
                    remote_session_id=req.remote_session_id,
                    provider=req.provider,
                    pinned=req.pinned,
                    created_at=req.created_at,
                    updated_at=req.updated_at,
                )
            except Exception as e:
                logger.error(f"create_session failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        # -----------------------------------------------------------------
        # 注意路由注册顺序: 字面量路径 (export / migrate) 必须在
        # /api/sessions/{session_id} 之前注册, 否则 FastAPI 会把 "export"
        # 当成 session_id 匹配到 {session_id} 路由, 返回 404.
        # -----------------------------------------------------------------

        @app.get("/api/sessions/export")
        async def export_sessions_api():
            """导出全部 sessions + messages 为单个 JSON.
            用于「备份聊天记录」按钮 — 用户下载后可保存到任意位置,
            下次重装/换机时通过 POST /api/sessions/migrate 恢复.

            返回格式与 /api/sessions/migrate 的请求体一致 (schema_version +
            exported_at + sessions + messages), 所以导出文件可以直接喂给
            导入端点, 不需要前端做格式转换.
            """
            try:
                return session_store.export_all()
            except Exception as e:
                logger.error(f"export_sessions failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/sessions/migrate")
        async def migrate_sessions_api(req: BulkImportRequest):
            """批量导入 sessions + messages. 用于把前端 localStorage 里
            已有的历史一次性导入 SQLite. 幂等 (INSERT OR REPLACE)."""
            try:
                counts = session_store.bulk_import(req.sessions, req.messages)
                return {"imported": counts}
            except Exception as e:
                logger.error(f"migrate_sessions failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.get("/api/sessions/{session_id}")
        async def get_session_api(session_id: str):
            """获取单个 session + 其所有 messages (按 created_at 升序)."""
            try:
                sess = session_store.get_session(session_id)
                if not sess:
                    raise HTTPException(status_code=404, detail="session not found")
                msgs = session_store.list_messages(session_id)
                return {**sess, "messages": msgs}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"get_session failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.patch("/api/sessions/{session_id}")
        async def update_session_api(session_id: str, req: SessionUpdateRequest):
            """更新 session 的 title / pinned / provider / remote_session_id."""
            try:
                result = session_store.update_session(
                    session_id,
                    title=req.title,
                    remote_session_id=req.remote_session_id,
                    provider=req.provider,
                    pinned=req.pinned,
                )
                if not result:
                    raise HTTPException(status_code=404, detail="session not found")
                return result
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"update_session failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/sessions/{session_id}")
        async def delete_session_api(session_id: str):
            """删除 session + 级联删除其所有 messages + 清掉 session log."""
            try:
                ok = session_store.delete_session(session_id)
                if not ok:
                    raise HTTPException(status_code=404, detail="session not found")
                # 同时清掉 agent_bridge 里这个 session 的 AgentCore 缓存
                try:
                    agentcore_clear_session(session_id)
                except Exception as _e:
                    logger.warning(f"clear_session_history failed: {_e}")
                # 同时清掉 session log (live + archive)
                try:
                    from hakus.session_log import get_recorder, drop_recorder
                    recorder = get_recorder(session_id)
                    recorder.clear()
                    drop_recorder(session_id)
                except Exception as _e:
                    logger.warning(f"clear session log failed: {_e}")
                return {"deleted": True, "id": session_id}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"delete_session failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/sessions/{session_id}/fork")
        async def fork_session_api(session_id: str, request: dict = None):
            """Fork 一个会话到新分支（Codex fork_thread 语义）。

            body 可选: {title?: str, with_messages?: bool (默认 true)}
            返回新会话。新会话 origin='fork', parent_id=源会话。
            """
            try:
                import uuid as _uuid
                src = session_store.get_session(session_id)
                if src is None:
                    raise HTTPException(status_code=404, detail=f"session not found: {session_id}")
                body = request or {}
                new_id = f"s_fork_{_uuid.uuid4().hex[:12]}"
                new_session = session_store.create_session(
                    new_id,
                    title=body.get("title") or f"{src['title']} (fork)",
                    parent_id=session_id,
                    origin="fork",
                )
                if body.get("with_messages", True):
                    for m in session_store.list_messages(session_id):
                        session_store.add_message(
                            new_id, m["id"] + "_f", m["role"], m["content"],
                            reasoning=m.get("reasoning"),
                            tool_calls=m.get("tool_calls") or None,
                            created_at=m.get("created_at"),
                            updated_at=m.get("updated_at"),
                        )
                    # P5: fork copies the timeline ledger too, so the child
                    # session keeps the full history (Codex fork_thread).
                    for ev in session_store.list_events(session_id):
                        session_store.append_event(
                            new_id,
                            ev["type"],
                            ev.get("payload"),
                            turn_id=ev.get("turn_id"),
                            created_at=ev.get("created_at"),
                        )
                return new_session
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"fork_session failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        # -----------------------------------------------------------------
        # Automations (Codex-style scheduled turns)
        # -----------------------------------------------------------------

        def require_python_automation_writers() -> None:
            """Reject compatibility automation writes during the migration window."""
            if session_store.writers_frozen():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Python compatibility writers are frozen; use the Rust "
                        "Runtime automation API"
                    ),
                )

        @app.get("/api/automations")
        async def list_automations_api():
            try:
                return {"automations": session_store.list_automations()}
            except Exception as e:
                logger.error(f"list_automations failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/automations")
        async def create_automation_api(req: AutomationCreateRequest):
            try:
                require_python_automation_writers()
                from .automations import compute_next_run, validate_schedule
                if not validate_schedule(req.schedule):
                    raise HTTPException(
                        status_code=422,
                        detail="invalid schedule (use '30m'/'1h'/'@daily'/'@manual')",
                    )
                auto_id = f"auto_{uuid.uuid4().hex[:12]}"
                auto = session_store.create_automation(
                    auto_id,
                    req.name,
                    req.schedule,
                    req.prompt,
                    enabled=req.enabled,
                    next_run_at=compute_next_run(req.schedule) if req.enabled else None,
                )
                return auto
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"create_automation failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.get("/api/automations/{automation_id}")
        async def get_automation_api(automation_id: str):
            auto = session_store.get_automation(automation_id)
            if auto is None:
                raise HTTPException(status_code=404, detail="automation not found")
            return auto

        @app.patch("/api/automations/{automation_id}")
        async def update_automation_api(automation_id: str, req: AutomationUpdateRequest):
            try:
                require_python_automation_writers()
                from .automations import compute_next_run, validate_schedule
                if session_store.get_automation(automation_id) is None:
                    raise HTTPException(status_code=404, detail="automation not found")
                if req.schedule is not None and not validate_schedule(req.schedule):
                    raise HTTPException(status_code=422, detail="invalid schedule")
                kwargs: Dict[str, Any] = {
                    k: v for k, v in {
                        "name": req.name,
                        "schedule": req.schedule,
                        "prompt": req.prompt,
                    }.items() if v is not None
                }
                if req.enabled is not None:
                    kwargs["enabled"] = req.enabled
                    # Toggling enabled recomputes next_run_at from now.
                    if req.enabled:
                        schedule = req.schedule or session_store.get_automation(automation_id)["schedule"]
                        kwargs["next_run_at"] = compute_next_run(schedule)
                    else:
                        kwargs["clear_next_run"] = True
                updated = session_store.update_automation(automation_id, **kwargs)
                return updated
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"update_automation failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/automations/{automation_id}")
        async def delete_automation_api(automation_id: str):
            require_python_automation_writers()
            if not session_store.delete_automation(automation_id):
                raise HTTPException(status_code=404, detail="automation not found")
            return {"deleted": True}

        @app.post("/api/automations/{automation_id}/run")
        async def run_automation_api(automation_id: str):
            """手动触发一次 — 不等待完成，立即返回 run 记录."""
            require_python_automation_writers()
            auto = session_store.get_automation(automation_id)
            if auto is None:
                raise HTTPException(status_code=404, detail="automation not found")
            from .automations import get_scheduler
            sched = get_scheduler()
            if auto["id"] in sched._running:
                raise HTTPException(status_code=409, detail="automation already running")
            sched._running.add(auto["id"])
            asyncio.create_task(sched._run_automation(auto), name=f"auto-manual-{auto['id']}")
            return {"started": True, "automation_id": auto["id"]}

        @app.post("/api/automations/{automation_id}/pause")
        async def pause_automation_api(automation_id: str):
            require_python_automation_writers()
            updated = session_store.update_automation(
                automation_id, enabled=False, clear_next_run=True
            )
            if updated is None:
                raise HTTPException(status_code=404, detail="automation not found")
            return updated

        @app.post("/api/automations/{automation_id}/resume")
        async def resume_automation_api(automation_id: str):
            require_python_automation_writers()
            from .automations import compute_next_run
            auto = session_store.get_automation(automation_id)
            if auto is None:
                raise HTTPException(status_code=404, detail="automation not found")
            updated = session_store.update_automation(
                automation_id,
                enabled=True,
                next_run_at=compute_next_run(auto["schedule"]),
            )
            return updated

        @app.get("/api/automations/{automation_id}/runs")
        async def list_automation_runs_api(automation_id: str, limit: int = 20):
            return {"runs": session_store.list_automation_runs(automation_id, limit)}

        @app.get("/api/sessions/{session_id}/messages")
        async def list_messages_api(session_id: str):
            """列出某 session 的所有 messages."""
            try:
                if not session_store.get_session(session_id):
                    raise HTTPException(status_code=404, detail="session not found")
                return {"messages": session_store.list_messages(session_id)}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"list_messages failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/sessions/{session_id}/messages")
        async def add_message_api(session_id: str, req: MessageCreateRequest):
            """追加 message. 用于:
              - user 消息 (send 时立即写)
              - assistant 消息占位 (stream 开始时建空 row, 结束时 PATCH)
            """
            try:
                if not session_store.get_session(session_id):
                    raise HTTPException(status_code=404, detail="session not found")
                return session_store.add_message(
                    session_id=session_id,
                    message_id=req.id,
                    role=req.role,
                    content=req.content,
                    reasoning=req.reasoning,
                    tool_calls=req.tool_calls,
                    input_tokens=req.input_tokens,
                    output_tokens=req.output_tokens,
                    error=req.error,
                    streaming=req.streaming,
                    created_at=req.created_at,
                    updated_at=req.updated_at,
                )
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"add_message failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.patch("/api/sessions/{session_id}/messages/{message_id}")
        async def update_message_api(session_id: str, message_id: str, req: MessageUpdateRequest):
            """更新 message. 用于 stream 完成时把最终 content / tool_calls /
            tokens 一次性写入."""
            try:
                result = session_store.update_message(
                    message_id,
                    content=req.content,
                    reasoning=req.reasoning,
                    tool_calls=req.tool_calls,
                    input_tokens=req.input_tokens,
                    output_tokens=req.output_tokens,
                    error=req.error,
                    streaming=req.streaming,
                )
                if not result:
                    raise HTTPException(status_code=404, detail="message not found")
                return result
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"update_message failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/sessions/{session_id}/messages/{message_id}")
        async def delete_message_api(session_id: str, message_id: str):
            """删除单个 message."""
            try:
                ok = session_store.delete_message(message_id)
                if not ok:
                    raise HTTPException(status_code=404, detail="message not found")
                return {"deleted": True, "id": message_id}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"delete_message failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/sessions/{session_id}/messages")
        async def clear_session_messages_api(session_id: str):
            """清空某 session 的所有 messages (保留 session 行).
            用于 TopBar '清空对话' — 用户想在同一个 session 里重新开始."""
            try:
                if not session_store.get_session(session_id):
                    raise HTTPException(status_code=404, detail="session not found")
                n = session_store.clear_session_messages(session_id)
                # 同时清掉 AgentCore 的 in-memory context, 让 LLM 也"忘记"
                try:
                    agentcore_clear_session(session_id)
                except Exception as _e:
                    logger.warning(f"clear_session_history failed: {_e}")
                return {"deleted_messages": n, "session_id": session_id}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"clear_session_messages failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/sessions")
        async def wipe_all_sessions_api():
            """删除所有 sessions + messages. 危险操作 — 前端必须二次确认."""
            try:
                n = session_store.wipe_all()
                return {"deleted_sessions": n}
            except Exception as e:
                logger.error(f"wipe_all_sessions failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        # ========== Session Log (append-only JSONL, DeepSeek-Harness-style) ==========

        @app.get("/api/sessions/{session_id}/log")
        async def get_session_log(session_id: str, since_turn: int = 0, limit: int = 500):
            """返回某 session 的 append-only JSONL 事件流.

            每行一个 JSON 对象, 字段: type, ts, turn, ...

            Query params:
              - since_turn: 只返回 turn >= 此值的事件 (0 = 全部)
              - limit: 最多返回 N 条 (取最新的 N 条)
            """
            try:
                if not session_store.get_session(session_id):
                    raise HTTPException(status_code=404, detail="session not found")
                from hakus.session_log import get_recorder
                recorder = get_recorder(session_id)
                events = recorder.read_events(since_turn=since_turn, limit=limit)
                return {
                    "session_id": session_id,
                    "events": events,
                    "stats": recorder.stats(),
                }
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"get_session_log failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/sessions/{session_id}/log/compact")
        async def compact_session_log(session_id: str):
            """手动触发 session log 的 compaction.

            把最旧的 50% 事件移到 session_log.compacted.jsonl, 并在 live
            log 末尾写一个 compacted 标记. 平时是自动触发的 (超过 5MB 或
            1000 events), 这个 endpoint 给用户/调试用.
            """
            try:
                if not session_store.get_session(session_id):
                    raise HTTPException(status_code=404, detail="session not found")
                from hakus.session_log import get_recorder
                recorder = get_recorder(session_id)
                # Force compaction by calling the internal method.
                with recorder._lock:
                    recorder._maybe_compact()
                return {"session_id": session_id, "stats": recorder.stats()}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"compact_session_log failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/sessions/{session_id}/log")
        async def clear_session_log(session_id: str):
            """清空 session log (live + archive). 用于 session 删除或用户主动清空."""
            try:
                from hakus.session_log import get_recorder, drop_recorder
                recorder = get_recorder(session_id)
                recorder.clear()
                drop_recorder(session_id)
                return {"session_id": session_id, "cleared": True}
            except Exception as e:
                logger.error(f"clear_session_log failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/sessions/{session_id}/rewind")
        async def rewind_session_to_message(session_id: str, request: dict):
            """后端原子 rewind: 删除指定 message_id 及其后的所有 messages,
            并把 session_log.jsonl 里 turn > 该 message 所在 turn 的事件
            全部清掉.

            请求体: {"message_id": "m_xxx"}

            与前端的客户端 rewind 不同, 这个 endpoint 是原子的:
              1. 找到 message_id 所在的 turn (通过 created_at 对齐
                 session_log 里 turn_start 事件的 ts)
              2. 删除 session_store 里 message_id 及其后的所有 messages
              3. 调用 recorder.rewind_to_turn(keep_turns=that_turn - 1)
              4. 让 AgentCore 的 context 也 forget (best-effort)

            返回: {"deleted_messages": N, "kept_until_turn": T}
            """
            try:
                message_id = request.get("message_id")
                if not message_id:
                    raise HTTPException(status_code=400, detail="message_id is required")
                if not session_store.get_session(session_id):
                    raise HTTPException(status_code=404, detail="session not found")
                msgs = session_store.list_messages(session_id)
                idx = next((i for i, m in enumerate(msgs) if m["id"] == message_id), -1)
                if idx == -1:
                    raise HTTPException(status_code=404, detail="message not found")
                # Delete message_id and all messages after it.
                # P5: the ledger is append-only — we record a truncation
                # event instead of physically deleting rows; list_messages
                # projects over the cutoff.
                to_delete = msgs[idx:]
                session_store.append_truncation(
                    session_id,
                    deleted_ids=[m["id"] for m in to_delete],
                    reason="rewind",
                )
                deleted_count = len(to_delete)
                # Best-effort: clear AgentCore in-memory context
                try:
                    agentcore_clear_session(session_id)
                except Exception as _ce:
                    logger.warning(f"clear_session_history during rewind failed: {_ce}")
                # Rewind the session log: keep all events from turns
                # before the turn that contained message_id. Since we
                # don't track per-message turn numbers in SQLite, we
                # approximate by keeping all events whose ts is before
                # the deleted message's created_at.
                try:
                    from hakus.session_log import get_recorder
                    recorder = get_recorder(session_id)
                    # Find the turn number of the earliest deleted message
                    # by reading the log backwards and finding the last
                    # turn_start whose ts <= earliest deleted msg's created_at.
                    earliest_ts = min(m["created_at"] for m in to_delete) / 1000.0
                    events = recorder.read_events(limit=10000)
                    keep_until_turn = 0
                    for ev in events:
                        if ev.get("type") == "turn_start" and ev.get("ts", 0) <= earliest_ts:
                            keep_until_turn = ev.get("turn", 0)
                        elif ev.get("ts", 0) > earliest_ts:
                            break
                    # Keep events from turns strictly before the deleted
                    # message's turn (so the deleted turn's events are
                    # also dropped — they correspond to deleted messages).
                    recorder.rewind_to_turn(keep_turns=keep_until_turn - 1 if keep_until_turn > 0 else 0)
                except Exception as _re:
                    logger.warning(f"session_log rewind failed: {_re}")
                return {
                    "session_id": session_id,
                    "deleted_messages": deleted_count,
                    "rewound_to_message_id": message_id,
                }
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"rewind_session_to_message failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        # ========== 配置API ==========
        
        @app.get("/api/config")
        async def get_config():
            """获取配置（安全版本，隐藏敏感信息）"""
            config = config_manager.config
            return {
                "version": config.version,
                "character": {
                    "name": config.character.name,
                    "personality": config.character.personality,
                },
                "model": {
                    "provider": config.model.provider,
                    "model_name": config.model.model_name,
                },
                "voice": {
                    "enabled": config.voice.enabled,
                    "asr_provider": config.voice.asr.provider,
                    "tts_provider": config.voice.tts.provider,
                },
                "avatar": {
                    "enabled": config.avatar.enabled,
                    "type": config.avatar.type,
                    "name": config.avatar.name,
                },
            }
        
        @app.get("/api/config/full")
        async def get_full_config():
            """获取完整配置（需要认证）"""
            # TODO: 添加认证
            return config_manager.config.model_dump()
        
        @app.post("/api/config/reload")
        async def reload_config():
            """重新加载配置"""
            await config_manager.reload()
            return {"message": "Config reloaded"}

        # ========== 模型 provider 配置 API ==========
        # 这些端点让桌面客户端能编辑 ~/.hakus/config.yaml 里的 model_name / base_url / api_key,
        # 不需要用户手动改文件。对应 TUI 的 ModelConfigOverlay。

        @app.get("/api/config/providers")
        async def list_providers():
            """列出所有支持的 AI provider 及当前配置状态（隐藏 api_key 明文）"""
            from . import provider_ops as _provider_ops
            # Read the explicitly selected config, or the normal user config.
            from .provider_ops import _load_raw_config
            raw: dict = _load_raw_config()
            models_cfg = raw.get("models", {}) or {}
            default_model = models_cfg.get("default_model", "deepseek")

            # Resolve ${VAR:default} env-var placeholders so the UI shows
            # actual values (e.g. "deepseek-chat") rather than the raw
            # template string. The placeholder format follows shell
            # parameter expansion: ${VAR:-default} or ${VAR:default}.
            #
            # Applied to base_url / model_name / api_key uniformly so the
            # masked_api_key is the real resolved key, not the literal
            # "${OPENAI_API_KEY:sk-xxx}" template.
            from .provider_ops import (
                resolve_placeholder,
                looks_like_placeholder,
                _mask_key,
                _resolve_provider_config,
            )
            default_model = resolve_placeholder(default_model)

            providers = []
            for pid, meta in _provider_ops.PROVIDER_META.items():
                resolved_cfg = _resolve_provider_config(pid, raw)
                # _resolve_provider_config also understands provider-local
                # credentials used by the current config schema.
                resolved_key = resolved_cfg["api_key"]
                # If the placeholder couldn't be resolved (no env, no default),
                # has_api_key should be False so the UI shows the "未配置" state
                # rather than a misleading masked string.
                unresolved = looks_like_placeholder(resolved_key)
                has_key = bool(resolved_key) and not unresolved
                # _mask_key returns "<未设置环境变量>" if val still looks like
                # a ${VAR} placeholder, otherwise the standard "sk-xx...yyyy"
                # mask. We always show the mask (even when unresolved) so the
                # user understands "yes I do have a template here, but the env
                # var isn't set".
                masked = _mask_key(resolved_key) if resolved_key else ""
                raw_model = resolved_cfg["model_name"]
                raw_url = resolved_cfg["base_url"]
                providers.append({
                    "id": pid,
                    "display_name": meta["display"],
                    "has_url": meta["has_url"],
                    "has_api_key": has_key,
                    "masked_api_key": masked,
                    "model_name": resolve_placeholder(raw_model),
                    "base_url": resolve_placeholder(raw_url),
                    "is_default": pid == default_model,
                })
            return {"providers": providers, "default_model": default_model}

        @app.post("/api/config/providers")
        async def update_provider(request: dict):
            """
            更新某个 provider 的配置（model_name / base_url / api_key），并热重载。

            请求体:
            {
                "provider": "deepseek",
                "model_name": "deepseek-chat",   // 可选, 留空不变
                "base_url": "https://...",       // 可选, 留空不变
                "api_key": "sk-xxx",             // 可选, 留空表示清除
                "set_as_default": true           // 可选, 把这个 provider 设为默认
            }
            """
            import yaml as _yaml
            from .provider_ops import _load_raw_config, _config_path

            provider_id = request.get("provider", "").lower()
            if not provider_id:
                raise HTTPException(status_code=400, detail="provider is required")

            from .provider_ops import PROVIDER_META
            if provider_id not in PROVIDER_META:
                raise HTTPException(status_code=400, detail=f"unknown provider: {provider_id}")

            config_path = _config_path()
            config_dir = config_path.parent
            config_dir.mkdir(parents=True, exist_ok=True)

            # 读取现有配置
            raw: dict = _load_raw_config(config_path)
            raw.setdefault("api_keys", {})
            raw.setdefault("models", {})

            # 应用 model_name / base_url.  Preserve the config layout already
            # used by the user: current files use models.providers, while old
            # files put provider blocks directly under models.
            provider_cfgs = raw["models"].get("providers")
            if isinstance(provider_cfgs, dict):
                prov_raw: dict = provider_cfgs.setdefault(provider_id, {})
            else:
                prov_raw = raw["models"].setdefault(provider_id, {})
            if "model_name" in request and request["model_name"]:
                prov_raw["model_name"] = request["model_name"]
            if "base_url" in request:
                if request["base_url"]:
                    prov_raw["base_url"] = request["base_url"]
                else:
                    prov_raw.pop("base_url", None)

            # 应用 api_key
            key_name = PROVIDER_META[provider_id]["key_name"]
            if key_name and "api_key" in request:
                if isinstance(provider_cfgs, dict):
                    if request["api_key"]:
                        prov_raw["api_key"] = request["api_key"]
                    else:
                        prov_raw.pop("api_key", None)
                else:
                    if request["api_key"]:
                        raw["api_keys"][key_name] = request["api_key"]
                    else:
                        raw["api_keys"].pop(key_name, None)

            # 设为默认
            if request.get("set_as_default"):
                raw["models"]["default_model"] = provider_id

            # 写回
            try:
                config_path.write_text(
                    _yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False),
                    encoding="utf-8",
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to write config: {e}")

            # 热重载
            try:
                await config_manager.reload()
            except Exception as e:
                logger.warning(f"Config saved but reload failed: {e}")

            # If this update also set a new default model, we MUST refresh
            # the legacy BASE_CONFIG + cached HakusConfig singletons and
            # drop every cached AgentCore. Otherwise code paths that call
            # run_turn_* without an explicit provider (WeChat handler,
            # voice-call handler) would keep using the old default until
            # the process is restarted — the "switched to DeepSeek but
            # still using opencode" bug.
            if request.get("set_as_default"):
                try:
                    from utils.hakus_config import reload_config as _hakus_reload
                    _hakus_reload()
                except Exception as e:
                    logger.warning(f"hakus_config.reload_config() failed: {e}")
                try:
                    from .agent_bridge import drop_all_agents
                    drop_all_agents()
                except Exception as e:
                    logger.warning(f"drop_all_agents() failed: {e}")
            return {"message": "Provider config saved", "provider": provider_id}

        @app.post("/api/config/default-model")
        async def set_default_model(request: dict):
            """切换默认模型 provider"""
            import yaml as _yaml
            from .provider_ops import PROVIDER_META, _config_path, _load_raw_config

            provider_id = request.get("provider", "").lower()
            if not provider_id:
                raise HTTPException(status_code=400, detail="provider is required")
            if provider_id not in PROVIDER_META:
                raise HTTPException(status_code=400, detail=f"unknown provider: {provider_id}")

            config_path = _config_path()
            config_path.parent.mkdir(parents=True, exist_ok=True)
            raw: dict = _load_raw_config(config_path)
            raw.setdefault("models", {})
            raw["models"]["default_model"] = provider_id
            try:
                config_path.write_text(
                    _yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False),
                    encoding="utf-8",
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to write config: {e}")
            try:
                await config_manager.reload()
            except Exception as e:
                logger.warning(f"Default model saved but reload failed: {e}")

            # Refresh the legacy BASE_CONFIG + cached HakusConfig singletons
            # AND drop every cached AgentCore. Without this, code paths that
            # call run_turn_* without an explicit provider (WeChat handler,
            # voice-call handler, and any React stale-closure on the desktop
            # client that forgets to send `provider` in the request body)
            # would keep using the old default until the process is restarted.
            try:
                from utils.hakus_config import reload_config as _hakus_reload
                _hakus_reload()
            except Exception as e:
                logger.warning(f"hakus_config.reload_config() failed: {e}")
            try:
                from .agent_bridge import drop_all_agents
                drop_all_agents()
            except Exception as e:
                logger.warning(f"drop_all_agents() failed: {e}")
            return {"message": "Default model updated", "default_model": provider_id}

        # ========== Provider 运维操作 API ==========
        # 这些端点让桌面客户端能在 Provider 设置页里:
        #   - 测试连接 (POST /api/providers/{id}/test)
        #   - 获取可用模型列表 (POST /api/providers/{id}/fetch-models)
        #   - 多 API Key 轮换管理 (GET/POST/DELETE /api/providers/{id}/keys[/{key_id}])
        #   - 自定义 HTTP Header (GET/PUT /api/providers/{id}/headers)
        #   - 列出所有 provider 的元数据 + 分组 (GET /api/providers/meta)
        # 对应前端 ModelPanel 里的「测试」「获取模型列表」「多 Key 管理」「自定义 Header」按钮.
        # 实现细节在 hakusai_server.provider_ops 模块.
        from . import provider_ops as _pops  # noqa: WPS433

        @app.get("/api/providers/meta")
        async def get_providers_meta():
            """返回所有 provider 的元数据 + 分组信息 (不含 API Key).

            前端用这个渲染 Provider 列表的分组 + 搜索建议. 与 list_providers 区别:
              - list_providers 返回的是「当前配置状态」(含 masked_api_key / model_name)
              - get_providers_meta 返回的是「元数据」(display_name / group / default_url)
            前端会同时调两个, list_providers 提供运行时状态, meta 提供静态分组.
            """
            return {
                "providers": _pops.list_known_providers(),
                "groups": [g[0] for g in _pops.PROVIDER_GROUPS],
            }

        @app.post("/api/providers/{provider_id}/test")
        async def test_provider(provider_id: str, request: dict):
            """测试 provider 连接 + 认证.

            请求体 (全部可选, 留空使用 config 里的当前值):
            {
                "api_key": "sk-xxx",       // 覆盖测试用的 Key
                "base_url": "https://...", // 覆盖测试用的 Base URL
                "model": "deepseek-chat",  // 覆盖测试用的模型名
                "timeout": 15              // 超时秒数 (默认 15)
            }
            """
            result = await _pops.test_provider_connection(
                provider_id,
                override_api_key=request.get("api_key") or None,
                override_base_url=request.get("base_url") or None,
                override_model=request.get("model") or None,
                timeout=float(request.get("timeout", 15.0)),
            )
            return {
                "ok": result.ok,
                "status": result.status,
                "message": result.message,
                "detail": result.detail,
                "latency_ms": result.latency_ms,
            }

        @app.post("/api/providers/{provider_id}/fetch-models")
        async def fetch_models(provider_id: str, request: dict):
            """从 provider 的 /models 端点拉取可用模型列表.

            请求体 (全部可选):
            {
                "api_key": "sk-xxx",
                "base_url": "https://...",
                "timeout": 20
            }

            返回:
            {
                "ok": true,
                "models": [{"id": "...", "name": "...", "owned_by": "..."}],
                "message": "获取到 N 个可用模型",
                "detail": null
            }
            """
            result = await _pops.fetch_provider_models(
                provider_id,
                override_api_key=request.get("api_key") or None,
                override_base_url=request.get("base_url") or None,
                timeout=float(request.get("timeout", 20.0)),
            )
            return {
                "ok": result.ok,
                "models": result.models,
                "message": result.message,
                "detail": result.detail,
            }

        @app.get("/api/providers/{provider_id}/keys")
        async def list_provider_keys(provider_id: str):
            """列出某个 provider 的所有 API Key (masked)."""
            try:
                keys = _pops.list_provider_keys(provider_id)
                return {"keys": keys}
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))

        @app.post("/api/providers/{provider_id}/keys")
        async def add_provider_key(provider_id: str, request: dict):
            """添加一个额外的 API Key (不影响主 Key).

            请求体: { "key": "sk-xxx", "label": "主号" }
            """
            try:
                entry = _pops.add_provider_key(
                    provider_id,
                    request.get("key", ""),
                    request.get("label", ""),
                )
                return entry
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @app.delete("/api/providers/{provider_id}/keys/{key_id}")
        async def delete_provider_key(provider_id: str, key_id: str):
            """删除一个额外的 API Key (不能删主 Key)."""
            try:
                ok = _pops.delete_provider_key(provider_id, key_id)
                if not ok:
                    raise HTTPException(status_code=404, detail=f"Key not found: {key_id}")
                return {"message": "Key deleted", "key_id": key_id}
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @app.get("/api/providers/{provider_id}/headers")
        async def get_provider_headers(provider_id: str):
            """获取 provider 的自定义 HTTP Headers."""
            return {"headers": _pops.get_provider_custom_headers(provider_id)}

        @app.put("/api/providers/{provider_id}/headers")
        async def set_provider_headers(provider_id: str, request: dict):
            """设置 provider 的自定义 HTTP Headers.

            请求体: { "headers": {"X-Custom-Header": "value"} }
            传空字典会清除所有自定义 Header.
            """
            try:
                _pops.set_provider_custom_headers(
                    provider_id,
                    request.get("headers", {}) or {},
                )
                return {"message": "Headers saved", "provider": provider_id}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        # =====================================================================
        # MCP (Model Context Protocol) — Phase 2 round 2
        # =====================================================================
        # Two groups of endpoints:
        #   1. /api/config/mcp-servers* — config CRUD (read/write ~/.hakus/config.yaml)
        #   2. /api/mcp/servers/{name}/* — runtime ops (start/stop/test/tools/invoke)
        #
        # Implementation delegates to hakusai_server.mcp_ops, which wraps
        # the McpClientManager singleton in hakus/mcp/manager.py.
        # =====================================================================

        @app.get("/api/config/mcp-servers")
        async def list_mcp_servers_endpoint():
            """List all configured MCP servers with current runtime status."""
            from . import mcp_ops as _mcp
            return _mcp.list_mcp_servers()

        @app.post("/api/config/mcp-servers")
        async def save_mcp_server_endpoint(request: dict):
            """Add or replace an MCP server config. Does NOT auto-start.

            Body: {"name": "filesystem", "config": {McpServerConfig fields}}
            """
            from . import mcp_ops as _mcp
            name = request.get("name", "").strip()
            config = request.get("config", {}) or {}
            if not name:
                raise HTTPException(status_code=400, detail="'name' is required")
            try:
                return _mcp.save_mcp_server(name, config)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.patch("/api/config/mcp-servers/{name}")
        async def update_mcp_server_endpoint(name: str, request: dict):
            """Patch an existing MCP server config (e.g. toggle enabled)."""
            from . import mcp_ops as _mcp
            try:
                return _mcp.update_mcp_server(name, request)
            except KeyError:
                raise HTTPException(status_code=404, detail=f"MCP server {name!r} not found")
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.delete("/api/config/mcp-servers/{name}")
        async def delete_mcp_server_endpoint(name: str):
            """Remove an MCP server from config. Stops it first if running."""
            from . import mcp_ops as _mcp
            try:
                return _mcp.delete_mcp_server(name)
            except KeyError:
                raise HTTPException(status_code=404, detail=f"MCP server {name!r} not found")
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.patch("/api/config/mcp")
        async def update_mcp_global_endpoint(request: dict):
            """Patch the top-level mcp: section (auto_start / fail_fast / tool_naming)."""
            from . import mcp_ops as _mcp
            try:
                return _mcp.update_mcp_global_config(request)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/mcp/servers/{name}/start")
        async def start_mcp_server_endpoint(name: str):
            """Start a server. Spawns subprocess, does MCP handshake, fetches tools."""
            from . import mcp_ops as _mcp
            try:
                return await _mcp.start_mcp_server(name)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/mcp/servers/{name}/stop")
        async def stop_mcp_server_endpoint(name: str):
            """Stop a running server."""
            from . import mcp_ops as _mcp
            try:
                return await _mcp.stop_mcp_server(name)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/mcp/servers/{name}/test")
        async def test_mcp_server_endpoint(name: str, request: dict):
            """One-shot test spawn: start → list_tools → kill.

            Body (all optional): {"override_command": "...", "override_args": [...], "timeout": 15}
            """
            from . import mcp_ops as _mcp
            try:
                # Map frontend field names to McpServerConfig override keys
                overrides = {}
                if "command" in request:
                    overrides["command"] = request["command"]
                if "args" in request:
                    overrides["args"] = request["args"]
                if "env" in request:
                    overrides["env"] = request["env"]
                if "cwd" in request:
                    overrides["cwd"] = request["cwd"]
                return await _mcp.test_mcp_server(name, overrides or None)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.get("/api/mcp/servers/{name}/tools")
        async def list_mcp_server_tools_endpoint(name: str):
            """Return the cached tool list for a running server."""
            from . import mcp_ops as _mcp
            return _mcp.list_server_tools(name)

        @app.post("/api/mcp/servers/{name}/tools/{tool_name}/invoke")
        async def invoke_mcp_tool_endpoint(name: str, tool_name: str, request: dict):
            """Call a tool on a running MCP server (for UI testing only)."""
            from . import mcp_ops as _mcp
            arguments = request.get("arguments", {}) or {}
            try:
                return await _mcp.invoke_server_tool(name, tool_name, arguments)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/character/update")
        async def update_character_full(request: dict):
            """
            更新角色信息。请求体可包含 name / nickname / personality / scenario / first_message / system_prompt。
            写入 ~/.hakus/config.yaml 并热重载。
            """
            import os, yaml as _yaml
            from pathlib import Path as _Path

            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            raw: dict = {}
            if config_path.exists():
                try:
                    raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
                except Exception:
                    raw = {}
            char = raw.setdefault("character", {})
            for field in ("name", "nickname", "personality", "scenario", "first_message", "system_prompt"):
                if field in request:
                    char[field] = request[field]
            try:
                config_path.write_text(
                    _yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False),
                    encoding="utf-8",
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to write config: {e}")
            try:
                await config_manager.reload()
            except Exception as e:
                logger.warning(f"Character saved but reload failed: {e}")
            return {"message": "Character updated"}

        # ========== 项目管理 API (Codex-style) ==========
        # A project = a named folder on disk. The desktop client lets the
        # user pick a folder (Tauri dialog), POSTs it here to register,
        # and then sends project_id with every chat request so the agent
        # runs with that folder as its working_dir.

        @app.get("/api/projects")
        async def list_projects_endpoint():
            """List all registered projects, sorted by pinned then last_used_at."""
            from . import projects as _projects
            return {"projects": _projects.list_projects()}

        @app.post("/api/projects")
        async def create_project_endpoint(request: dict):
            """Register a new project.

            Body: {"name": "...", "path": "/abs/path/to/folder", "pinned"?: bool}
            The folder must already exist on disk — the Tauri folder picker
            only returns existing folders, and we don't silently create one
            here so users can't accidentally register "/" or similar.
            """
            from . import projects as _projects
            name = (request.get("name") or "").strip()
            path = (request.get("path") or "").strip()
            pinned = bool(request.get("pinned", False))
            if not path:
                raise HTTPException(status_code=400, detail="path is required")
            try:
                return _projects.create_project(name, path, pinned=pinned)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @app.patch("/api/projects/{project_id}")
        async def update_project_endpoint(project_id: str, request: dict):
            """Rename and/or pin/unpin a project.

            Body: {"name"?: "...", "pinned"?: bool}
            """
            from . import projects as _projects
            if "name" in request:
                updated = _projects.rename_project(project_id, request["name"])
                if updated is None:
                    raise HTTPException(status_code=404, detail="project not found")
            if "pinned" in request:
                updated = _projects.set_pinned(project_id, bool(request["pinned"]))
                if updated is None:
                    raise HTTPException(status_code=404, detail="project not found")
            return _projects.get_project(project_id) or {}

        @app.delete("/api/projects/{project_id}")
        async def delete_project_endpoint(project_id: str):
            """Remove a project from the registry. Does NOT touch the folder on disk."""
            from . import projects as _projects
            ok = _projects.delete_project(project_id)
            if not ok:
                raise HTTPException(status_code=404, detail="project not found")
            return {"deleted": True}

        # ========== 记忆系统扩展 API ==========

        @app.get("/api/memory/details")
        async def get_memory_details():
            """获取记忆系统详细状态（短期/长期条数、配置开关等）"""
            cfg = config_manager.config.memory
            data = {
                "enabled": cfg.enabled,
                "long_term_enabled": cfg.long_term_enabled,
                "short_term_max": cfg.short_term_max,
                "auto_summary": cfg.auto_summary,
                "summary_interval": cfg.summary_interval,
                "stats": {},
            }
            if self.memory:
                try:
                    data["stats"] = self.memory.stats or {}
                except Exception:
                    pass
            return data

        # ========== 工具与权限 API ==========

        @app.get("/api/tools")
        async def list_tools():
            """列出所有工具类别及开关状态.

            DeepSeek-Harness-style: 从 ToolRegistry 派生 (不再硬编码),
            这样新增工具自动出现在 Settings 面板里. 类别 = Tool.category,
            开关状态从 ~/.hakus/config.yaml 的 tools.disabled 读取.
            """
            from hakus.tools.registry import ToolRegistry
            # 用一个临时 registry 来获取完整类别列表 (不污染正在跑的 agent)
            _reg = ToolRegistry()
            _reg.register_builtin()
            # 读 ~/.hakus/config.yaml 里的 tools 段, 看哪些类别被禁用
            import os as _os, yaml as _yaml
            from pathlib import Path as _Path2
            config_path = _Path2(_os.path.expanduser("~/.hakus/config.yaml"))
            raw: dict = {}
            if config_path.exists():
                try:
                    raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
                except Exception:
                    raw = {}
            disabled = set(raw.get("tools", {}).get("disabled", []) or [])
            # 把 disabled 同步到 registry, 这样 list_tools() 也会跳过它们
            _reg.set_disabled_categories(disabled)
            cats = _reg.get_categories()
            # 转成前端期望的 list shape (id/name/desc/dangerous/enabled)
            _CAT_NAMES = {
                "filesystem": "文件读写",
                "shell": "Shell 命令",
                "search": "代码搜索",
                "vcs": "Git 版本控制",
                "web": "网页抓取",
                "browser": "浏览器自动化",
                "task": "任务管理",
                "plan": "计划与待办",
                "interactive": "交互问答",
                "general": "通用",
            }
            tools = []
            for cat_id, info in cats.items():
                tools.append({
                    "id": cat_id,
                    "name": _CAT_NAMES.get(cat_id, cat_id.title()),
                    "desc": f"{len(info['tools'])} 个工具: {', '.join(info['tools'][:5])}{'…' if len(info['tools']) > 5 else ''}",
                    "dangerous": info["dangerous"],
                    "enabled": cat_id not in disabled,
                    "tools": info["tools"],
                })
            return {"tools": tools}

        @app.post("/api/tools/toggle")
        async def toggle_tool(request: dict):
            """开关某个工具类别。请求体: {tool_id: "shell", enabled: false}

            DeepSeek-Harness-style: tool_id 现在是 *类别* (不是单个工具),
            与 Tool.category 对齐. 切换后立刻同步到所有正在跑的 AgentCore
            的 ToolRegistry, 这样下一轮 LLM 调用就会看到新的工具集.
            """
            import os, yaml as _yaml
            from pathlib import Path as _Path
            tool_id = request.get("tool_id")
            enabled = request.get("enabled")
            if not tool_id or enabled is None:
                raise HTTPException(status_code=400, detail="tool_id and enabled are required")
            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            raw: dict = {}
            if config_path.exists():
                try:
                    raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
                except Exception:
                    raw = {}
            tools_cfg = raw.setdefault("tools", {})
            disabled = set(tools_cfg.get("disabled", []) or [])
            if enabled:
                disabled.discard(tool_id)
            else:
                disabled.add(tool_id)
            tools_cfg["disabled"] = sorted(disabled)
            try:
                config_path.write_text(
                    _yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False),
                    encoding="utf-8",
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to write config: {e}")
            # 同步到所有正在跑的 AgentCore 的 registry — 之前是 write-only bug
            try:
                from .agent_bridge import _agent_cache
                for agent in _agent_cache.values():
                    try:
                        agent._tool_registry.set_disabled_categories(disabled)
                    except Exception as _e:
                        logger.warning(f"set_disabled_categories on agent failed: {_e}")
            except Exception as _e:
                logger.warning(f"sync disabled categories to agents failed: {_e}")
            return {"tool_id": tool_id, "enabled": enabled, "disabled_categories": sorted(disabled)}

        # ========== 五档权限引擎（Codex-style profiles） ==========

        _FIVE_MODES = ["read_only", "auto", "granular", "guardian", "full_access"]

        @app.get("/api/permission")
        async def get_permission():
            """获取当前五档权限模式 + granular 规则 + profile"""
            import os, yaml as _yaml
            from pathlib import Path as _Path
            from hakus.permissions.engine import get_engine, PROFILES

            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            raw: dict = {}
            if config_path.exists():
                try:
                    raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
                except Exception:
                    raw = {}
            perm_cfg = raw.get("permission", {}) or {}
            mode = perm_cfg.get("mode", "auto")
            if mode not in _FIVE_MODES:
                # legacy modes map into the five tiers
                mode = {"ask": "auto", "bypass": "full_access"}.get(mode, "auto")
            engine = get_engine()
            # Engine state is the source of truth for the running process;
            # config.yaml only seeds it on first call.
            return {
                "mode": engine.mode.value,
                "granular_rules": engine.rules.to_dict(),
                "profile": PROFILES[engine.mode.value],
                "available_modes": _FIVE_MODES,
                "config_mode": mode,
            }

        @app.post("/api/permission")
        async def set_permission(request: dict):
            """设置五档权限模式。

            请求体: {mode, granular_rules?: {shell, write_paths, network}}
            持久化到 config.yaml 并即时应用到所有活跃 agent。
            """
            import os, yaml as _yaml
            from pathlib import Path as _Path
            from hakus.permissions.engine import get_engine

            mode = request.get("mode")
            if mode not in _FIVE_MODES:
                raise HTTPException(
                    status_code=400,
                    detail=f"mode must be one of {_FIVE_MODES}",
                )
            granular_rules = request.get("granular_rules")
            engine = get_engine()
            state = engine.set_mode(mode, rules=granular_rules)

            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            raw: dict = {}
            if config_path.exists():
                try:
                    raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
                except Exception:
                    raw = {}
            perm_cfg = raw.setdefault("permission", {})
            perm_cfg["mode"] = mode
            if granular_rules is not None:
                perm_cfg["granular_rules"] = granular_rules
            try:
                config_path.write_text(
                    _yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False),
                    encoding="utf-8",
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to write config: {e}")

            # Hot-apply to every live agent's PermissionManager
            from . import agent_bridge as _bridge
            with _bridge._agent_cache_lock:
                live_agents = list(_bridge._agent_cache.values())
            for _agent in live_agents:
                try:
                    engine.apply_to_manager(_agent._permission)
                except Exception as _e:
                    logger.warning(f"apply permission mode to agent failed: {_e}")

            return {"mode": state["mode"], "granular_rules": state["granular_rules"],
                    "profile": state["profile"]}

        # ========== 审批流（五档权限引擎的 approval_required） ==========

        @app.get("/api/approvals")
        async def list_approvals(session_id: str = "", pending: int = 1):
            """列出待审批（pending=1）或全部审批记录"""
            from .approvals import get_store
            store = get_store()
            if pending:
                items = store.pending(session_id or None)
            else:
                with store._lock:
                    items = [a for a in store._approvals.values()
                             if not session_id or a.session_id == session_id]
            return {"approvals": [a.to_dict() for a in items]}

        @app.post("/api/approvals/{approval_id}/approve")
        async def approve_approval(approval_id: str, request: dict = None):
            """批准审批。body: {scope: "once"|"session"}（默认 once）"""
            from .approvals import get_store
            store = get_store()
            scope = (request or {}).get("scope", "once")
            if scope not in ("once", "session"):
                scope = "once"
            approval = store.resolve(approval_id, scope)
            if approval is None:
                raise HTTPException(status_code=404, detail="approval not found or already resolved")
            # session 范围 → 写入该会话 agent 的白名单，后续同 key 自动放行
            if scope == "session":
                with agent_bridge._agent_cache_lock:
                    agents = [v for k, v in agent_bridge._agent_cache.items()
                              if k[0] == approval.session_id]
                for _agent in agents:
                    try:
                        _agent._permission.approve_for_session(approval.action_key)
                    except Exception as _e:
                        logger.warning(f"approve_for_session failed: {_e}")
            return approval.to_dict()

        @app.post("/api/approvals/{approval_id}/deny")
        async def deny_approval(approval_id: str):
            from .approvals import get_store
            store = get_store()
            approval = store.resolve(approval_id, "deny")
            if approval is None:
                raise HTTPException(status_code=404, detail="approval not found or already resolved")
            return approval.to_dict()

        # ========== 配置导出/导入 ==========

        @app.get("/api/config/export")
        async def export_config():
            """导出完整配置（脱敏：api_key 用 mask 显示）"""
            import os, yaml as _yaml, copy as _copy
            from pathlib import Path as _Path
            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            if not config_path.exists():
                return {"config": {}}
            try:
                raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to read config: {e}")
            # 脱敏
            safe = _copy.deepcopy(raw)
            api_keys = safe.get("api_keys", {}) or {}
            for k, v in list(api_keys.items()):
                if v and isinstance(v, str):
                    api_keys[k] = (v[:4] + "..." + v[-4:]) if len(v) > 8 else "*" * len(v)
            return {"config": safe}

        @app.post("/api/config/import")
        async def import_config(request: dict):
            """导入配置（覆盖 ~/.hakus/config.yaml）。请求体: {config: {...}}"""
            import os, yaml as _yaml
            from pathlib import Path as _Path
            new_config = request.get("config")
            if not isinstance(new_config, dict):
                raise HTTPException(status_code=400, detail="config must be an object")
            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            config_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                config_path.write_text(
                    _yaml.dump(new_config, allow_unicode=True, default_flow_style=False, sort_keys=False),
                    encoding="utf-8",
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"failed to write config: {e}")
            try:
                await config_manager.reload()
            except Exception as e:
                logger.warning(f"Config imported but reload failed: {e}")
            return {"message": "Config imported"}

        # ========== 角色API ==========
        
        @app.get("/api/character")
        async def get_character():
            """获取角色信息 — 直接从 ~/.hakus/config.yaml 读取，确保返回用户实际配置而非默认值"""
            import os, yaml as _yaml
            from pathlib import Path as _Path
            config_path = _Path(os.path.expanduser("~/.hakus/config.yaml"))
            raw: dict = {}
            if config_path.exists():
                try:
                    raw = _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
                except Exception:
                    raw = {}
            char = raw.get("character", {}) or {}
            # 同时获取 avatar_type（兼容旧逻辑）
            avatar_type = "live2d"
            try:
                av = config_manager.config.avatar.type
                avatar_type = av.value if hasattr(av, "value") else str(av)
            except Exception:
                pass
            return {
                "name": char.get("name", "小雪"),
                "nickname": char.get("nickname"),
                "personality": char.get("personality", "你是一个温柔善良的AI助手"),
                "scenario": char.get("scenario"),
                "first_message": char.get("first_message"),
                "avatar_type": avatar_type,
            }
        
        # ========== 记忆API ==========
        
        @app.get("/api/memory/stats")
        async def get_memory_stats():
            """获取记忆统计"""
            if not self.memory:
                return {"error": "Memory not initialized"}
            
            return self.memory.stats
        
        @app.post("/api/memory/clear")
        async def clear_memory(request: dict = None):
            """清空记忆。

            请求体 (可选):
            {
                "session_id": "default"  // 不传则清所有 session 的 AgentCore cache
            }
            """
            session_id = (request or {}).get("session_id")
            if self.memory:
                await self.memory.clear()
                # 同时清空 BaseAgent 历史（旧路径）
                if self.agent:
                    try:
                        self.agent.clear_history()
                    except Exception as e:
                        logger.warning(f"BaseAgent clear_history failed: {e}")

            # 清空 AgentCore session cache（新路径）
            if USE_AGENTCORE_FOR_CHAT:
                if session_id:
                    agentcore_clear_session(session_id)
                else:
                    # 没指定 session — 清所有缓存的 agent
                    from .agent_bridge import _agent_cache, _agent_cache_lock
                    with _agent_cache_lock:
                        _agent_cache.clear()

            return {"message": "Memory cleared"}
        
        # ========== TTS API ==========
        
        @app.post("/api/tts")
        async def text_to_speech(request: dict):
            """
            文本转语音
            
            请求体:
            {
                "text": "要合成的文本",
                "voice": "xiaoxiao",  // 可选
                "speed": 1.0          // 可选
            }
            
            返回音频文件 (MP3)
            """
            if not self.tts_engine:
                raise HTTPException(status_code=503, detail="TTS not initialized")
            
            text = request.get("text", "")
            voice = request.get("voice")
            speed = request.get("speed", 1.0)
            
            if not text:
                raise HTTPException(status_code=400, detail="Text is required")
            
            try:
                from fastapi.responses import Response
                
                # 合成语音
                result = await self.tts_engine.synthesize(text, voice=voice, speed=speed)
                
                if result is None:
                    raise HTTPException(status_code=500, detail="TTS synthesis returned no audio")
                
                return Response(
                    content=result.audio_data,
                    media_type="audio/mpeg",
                    headers={
                        "Content-Disposition": f"attachment; filename=tts.mp3",
                        "X-Sample-Rate": str(result.sample_rate),
                    }
                )
            except Exception as e:
                logger.error(f"TTS error: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @app.get("/api/tts/voices")
        async def list_tts_voices():
            """列出可用的TTS语音"""
            from hakusai_core.voice.tts import tts_registry
            providers = tts_registry.list_providers()
            return {
                "providers": providers,
            }

        @app.post("/api/voice/asr")
        async def voice_asr(
            audio: UploadFile = File(...),
            provider: Optional[str] = Form(None),
            language: Optional[str] = Form(None),
        ):
            """Transcribe a short WAV utterance with HakusAI built-in ASR."""
            suffix = Path(audio.filename or "voice.wav").suffix or ".wav"
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                    tmp_path = tmp.name
                    tmp.write(await audio.read())

                from .celia_voice import transcribe_audio

                text = await asyncio.to_thread(
                    transcribe_audio,
                    tmp_path,
                    provider=provider,
                    language=language,
                )
                return {"text": text}
            except Exception as e:
                logger.error(f"ASR error: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))
            finally:
                if tmp_path:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

        # ========== 语音通话 API ==========

        @app.websocket("/ws/voice")
        async def websocket_voice(websocket: WebSocket):
            """
            语音通话 WebSocket 接口

            全双工语音通话：前端持续发送 PCM 音频帧，
            后端 VAD -> ASR -> LLM -> TTS -> 音频推送

            Query params:
                session_id: 会话 ID（默认 "default"）
                api_key: DashScope API Key（可选，前端设置传入）
            """
            from .voice_call_handler import VoiceCallHandler, VoiceCallConfig

            session_id = websocket.query_params.get("session_id", "default")
            api_key = websocket.query_params.get("api_key", "")

            # 从配置构建 VoiceCallConfig
            config = config_manager.config
            # provider 可能是 Enum 值，统一转 str
            raw_asr = config.voice.asr.provider if config.voice.enabled else "funasr"
            raw_tts = config.voice.tts.provider if config.voice.enabled else "cosyvoice"
            asr_provider = str(raw_asr.value) if hasattr(raw_asr, 'value') else str(raw_asr)
            tts_provider = str(raw_tts.value) if hasattr(raw_tts, 'value') else str(raw_tts)

            # 从模型配置读取 LLM 连接信息（语音 Agent 独立调用，不走 agent_bridge）
            model_cfg = config.model
            llm_api_key = model_cfg.api_key or ""
            llm_base_url = model_cfg.base_url or ""
            llm_model_name = model_cfg.model_name or "deepseek-chat"

            voice_call_config = VoiceCallConfig(
                asr_provider=asr_provider,
                asr_language="zh",
                tts_provider=tts_provider,
                tts_voice="",
                tts_model="cosyvoice-v3-flash",
                vad_threshold=0.5,
                sample_rate=16000,
                dashscope_api_key=api_key,
                llm_api_key=llm_api_key,
                llm_base_url=llm_base_url,
                llm_model_name=llm_model_name,
            )

            handler = VoiceCallHandler(config=voice_call_config, agent_bridge=self)
            await handler.handle_connection(websocket, session_id=session_id)

        @app.post("/api/voice/clone")
        async def voice_clone(
            audio: UploadFile = File(...),
            api_key: Optional[str] = Form(None),
        ):
            """
            语音复刻上传端点

            接收 WAV 格式音频文件，复制到 hakusai_data/voice/ref_audio.wav，
            然后调用 CosyVoiceTTS.clone_voice() 开始克隆。
            """
            # 验证文件格式
            if not audio.filename or not audio.filename.lower().endswith(".wav"):
                raise HTTPException(status_code=400, detail="仅支持 WAV 格式音频文件")

            voice_data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "hakusai_data", "voice"))
            ref_audio_path = os.path.join(voice_data_dir, "ref_audio.wav")

            try:
                # 确保目录存在
                os.makedirs(voice_data_dir, exist_ok=True)

                # 保存参考音频
                content = await audio.read()
                with open(ref_audio_path, "wb") as f:
                    f.write(content)

                # 重置状态文件
                status_path = os.path.join(voice_data_dir, "voice_status.txt")
                error_path = os.path.join(voice_data_dir, "voice_error.txt")
                for p in [status_path, error_path]:
                    if os.path.exists(p):
                        try:
                            os.remove(p)
                        except Exception:
                            pass

                logger.info(f"语音复刻: 参考音频已保存到 {ref_audio_path} ({len(content)} bytes)")

                # 校验音频时长（CosyVoice 要求 >= 10 秒）
                import wave
                try:
                    with wave.open(ref_audio_path, "rb") as wf:
                        frames = wf.getnframes()
                        sr = wf.getframerate()
                        duration = frames / sr if sr > 0 else 0
                    if duration < 8:
                        return JSONResponse(
                            status_code=400,
                            content={"status": "error", "message": f"音频太短 ({duration:.1f}s)，CosyVoice 需要至少 10 秒。请上传 10~20 秒的 WAV 文件"},
                        )
                    logger.info(f"语音复刻: 音频时长 {duration:.1f}s")
                except Exception as wave_err:
                    logger.warning(f"语音复刻: 无法解析 WAV 时长，跳过校验: {wave_err}")

                # 触发克隆
                try:
                    from hakusai_core.voice.tts.cosyvoice import CosyVoiceTTS
                    tts_config = config_manager.config.voice.tts.model_dump() if config_manager.config.voice.enabled else {}
                    tts_config.setdefault("model", "cosyvoice-v3-flash")
                    # 前端设置的 API Key 优先，覆盖环境变量
                    if api_key:
                        tts_config["api_key"] = api_key
                        logger.info(f"语音复刻: 使用前端传入 API Key ({len(api_key)} 字符)")
                    else:
                        logger.warning("语音复刻: 未收到前端 API Key，尝试使用配置/环境变量")
                    cosy = CosyVoiceTTS(tts_config)
                    logger.info(f"语音复刻: CosyVoiceTTS api_key 是否配置: {bool(cosy.api_key)}")
                    # 异步执行克隆（不等待完成）
                    asyncio.create_task(cosy.clone_voice(ref_audio=ref_audio_path))
                except Exception as clone_err:
                    logger.warning(f"语音复刻启动失败: {clone_err}")
                    return JSONResponse(
                        status_code=500,
                        content={"status": "error", "message": f"声音复刻启动失败: {str(clone_err)}"},
                    )

                return {"status": "cloning", "message": "声音复刻已启动"}

            except Exception as e:
                logger.error(f"语音复刻上传错误: {e}")
                raise HTTPException(status_code=500, detail=str(e))

        @app.get("/api/voice/clone/status")
        async def voice_clone_status():
            """
            语音复刻状态查询

            读取 hakusai_data/voice/ 下的状态文件，返回当前复刻状态。
            """
            voice_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "hakusai_data", "voice"))
            voice_id_path = os.path.join(voice_dir, "voice_id.txt")
            status_path = os.path.join(voice_dir, "voice_status.txt")
            error_path = os.path.join(voice_dir, "voice_error.txt")

            # 1. 已缓存 voice_id -> completed
            if os.path.exists(voice_id_path):
                try:
                    with open(voice_id_path, "r", encoding="utf-8") as f:
                        voice_id = f.read().strip()
                    if voice_id:
                        return {"status": "completed", "voice_id": voice_id}
                except Exception as e:
                    logger.error(f"读取 voice_id 失败: {e}")

            # 2. 读取状态文件
            status = "pending"
            if os.path.exists(status_path):
                try:
                    with open(status_path, "r", encoding="utf-8") as f:
                        status = f.read().strip() or "pending"
                except Exception as e:
                    logger.warning(f"读取语音复刻状态失败: {e}")

            # 3. 失败时读取错误信息
            error = ""
            if status == "failed" and os.path.exists(error_path):
                try:
                    with open(error_path, "r", encoding="utf-8") as f:
                        error = f.read().strip()
                except Exception as e:
                    logger.warning(f"读取语音复刻错误信息失败: {e}")

            return {"status": status, "voice_id": None, "error": error}

        @app.get("/api/voice/settings")
        async def voice_settings():
            """
            语音设置查询

            返回当前 TTS/ASR/VAD 配置。
            """
            config = config_manager.config
            return {
                "voice_enabled": config.voice.enabled,
                "asr": {
                    "provider": config.voice.asr.provider,
                    "language": getattr(config.voice.asr, "language", "zh"),
                },
                "tts": {
                    "provider": config.voice.tts.provider,
                    "model": getattr(config.voice.tts, "model", "cosyvoice-v3-flash"),
                },
                "vad": {
                    "provider": "funasr",
                    "threshold": 0.5,
                },
                "sample_rate": 16000,
            }
        
        # ========== WebSocket路由 ==========
        
        @app.websocket("/ws/chat")
        async def websocket_chat(websocket: WebSocket):
            """WebSocket聊天接口 — Phase 4 加入心跳/超时/resume_session。

            协议 (客户端 -> 服务端):
              {"type": "message", "content": "...", "session_id": "...", "provider"?}
                -> 流式响应: 多个 {"type":"stream", ...} + 最后 {"type":"stream", "done":true}
              {"type": "ping"}
                -> {"type": "pong"}
              {"type": "pong"}
                -> (无响应, 仅刷新服务端 last_seen)
              {"type": "resume_session", "session_id": "..."}
                -> {"type": "resume_ok", "session_id": "...", "messages_restored": N}
                   或 {"type": "resume_failed", "reason": "..."}
              {"type": "interrupt"}
                -> 取消当前流式 turn (best-effort)
              {"type": "answer", "session_id": "...", "question_id": "...", "choice": "..."}
                -> 回答 ask_user 提出的问题, {"type":"answer_ack", "accepted": true|false}

            服务端 -> 客户端 (主动):
              {"type": "ping", "ts": ...} — 每 30s 一次心跳, 客户端应回 pong

            AgentCore 路径下，stream 事件携带 event_type 字段
            (text_delta / tool_call_started / ... / turn_completed / question_asked)，
            旧客户端只看 content + done 即可。

            Phase 4 关键改动:
              - receive_json 加 120s 超时 — 客户端崩溃/断网时服务端不会无限阻塞
              - 收到任意消息都刷新 last_seen (阻止 cleanup_loop 收尸)
              - resume_session: 客户端重连后恢复会话历史
              - 服务端 _heartbeat_loop 主动 ping (在 WebSocketManager 内)
            """
            await self.websocket_manager.connect(websocket)
            try:
                while True:
                    # 120s 超时 — 正常情况下客户端至少每 30s 回一次 pong (响应服务端 ping),
                    # 120s 都没动静 = 客户端挂了/网络断了, 主动断开。
                    try:
                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=120.0,
                        )
                    except asyncio.TimeoutError:
                        logger.info("WebSocket receive timeout (120s no message), closing.")
                        break

                    # 任意消息都刷新 last_seen
                    self.websocket_manager.update_last_seen(websocket)

                    message_type = data.get("type", "message")

                    if message_type == "message":
                        content = data.get("content", "")
                        session_id = data.get("session_id", "default")
                        # WebSocket clients can also pass a per-message
                        # provider override (same semantics as the REST
                        # ChatRequest.provider field).
                        ws_provider = data.get("provider")

                        await event_bus.emit(
                            EventType.CHAT_MESSAGE_RECEIVED,
                            {"content": content, "websocket_id": id(websocket)}
                        )

                        # Phase 1: 等 AI 初始化完成（最多 10s），仍没好就发 init_pending
                        if not await self._ensure_ready(timeout=10.0):
                            await websocket.send_json({
                                "type": "error",
                                "message": "AI still initializing, please retry in a few seconds",
                                "code": "init_pending",
                                "retry_after_s": 2,
                            })
                            continue

                        # AgentCore 路径
                        if USE_AGENTCORE_FOR_CHAT:
                            if not self.model_adapter:
                                await websocket.send_json({
                                    "type": "error",
                                    "message": f"Model not initialized: {self._init_error or 'unknown reason'}",
                                    "code": "init_failed",
                                    "diagnostics_url": "/api/diagnostics",
                                })
                                continue
                            try:
                                # Phase 5: WS 路径也计 turn + 跟踪 LLM/checkpoint 事件
                                self._inc_metric("total_turns", provider=ws_provider or "default")
                                ws_turn_failed = False
                                # Resolve active project (if any) — same as SSE path.
                                from . import projects as _projects
                                ws_project_id = data.get("project_id")
                                ws_working_dir = _projects.resolve_working_dir(ws_project_id)
                                selected_content = _message_with_selected_skills(
                                    content, ws_working_dir,
                                )
                                async for chunk in agentcore_run_turn_stream(
                                    selected_content, session_id,
                                    provider=ws_provider,
                                    working_dir=ws_working_dir,
                                ):
                                    etype = chunk.get("event_type", "")
                                    if etype == "token_usage":
                                        self._inc_metric("llm_calls", provider=ws_provider or "default")
                                    elif etype == "checkpoint_saved":
                                        self._inc_metric("checkpoints_saved")
                                    elif etype == "turn_failed":
                                        ws_turn_failed = True
                                        self._inc_metric("total_errors", provider=ws_provider or "default")
                                    await websocket.send_json({
                                        "type": "stream",
                                        **chunk,
                                    })
                                    # 每次成功 send 都刷新 last_seen
                                    self.websocket_manager.update_last_seen(websocket)
                            except Exception as e:
                                logger.error(f"WS AgentCore stream error: {e}", exc_info=True)
                                if not ws_turn_failed:
                                    self._inc_metric("total_errors", provider=ws_provider or "default")
                                await websocket.send_json({
                                    "type": "error",
                                    "message": str(e),
                                    "code": "stream_error",
                                })
                            continue

                        # 旧路径
                        if not self.agent:
                            await websocket.send_json({
                                "type": "error",
                                "message": f"Agent not initialized: {self._init_error or 'unknown reason'}",
                                "code": "init_failed",
                                "diagnostics_url": "/api/diagnostics",
                            })
                            continue

                        legacy_working_dir = _skill_project_dir(data.get("project_id"))
                        selected_content = _message_with_selected_skills(
                            content, legacy_working_dir,
                        )
                        context = AgentContext(session_id=session_id)

                        async for response in self.agent.chat(selected_content, context, stream=True):
                            await websocket.send_json({
                                "type": "stream",
                                "content": response.content,
                                "emotion": response.emotion,
                                "done": False
                            })
                            self.websocket_manager.update_last_seen(websocket)

                        await websocket.send_json({
                            "type": "stream",
                            "content": "",
                            "done": True
                        })

                    elif message_type == "ping":
                        await websocket.send_json({"type": "pong"})

                    elif message_type == "pong":
                        # 客户端响应服务端 ping — last_seen 已在上面刷新, 这里无需再发任何东西
                        pass

                    elif message_type == "interrupt":
                        # Best-effort: 取消当前 AgentCore turn。AgentCore 内部
                        # 会监听 session_id 的 cancel 信号。这里发完就 continue。
                        try:
                            from .agent_bridge import cancel_session_turn
                            session_id = data.get("session_id", "default")
                            cancel_session_turn(session_id)
                            await websocket.send_json({"type": "interrupt_ack", "session_id": session_id})
                        except Exception as e:
                            logger.warning(f"WS interrupt failed: {e}")
                            await websocket.send_json({
                                "type": "error",
                                "message": f"interrupt failed: {e}",
                                "code": "interrupt_failed",
                            })

                    elif message_type == "resume_session":
                        # Phase 4: 客户端重连后恢复会话历史
                        session_id = data.get("session_id", "default")
                        try:
                            from . import session_store
                            msgs = session_store.list_messages(session_id)
                            await websocket.send_json({
                                "type": "resume_ok",
                                "session_id": session_id,
                                "messages_restored": len(msgs) if msgs else 0,
                            })
                        except Exception as e:
                            logger.warning(f"WS resume_session failed: {e}")
                            await websocket.send_json({
                                "type": "resume_failed",
                                "session_id": session_id,
                                "reason": str(e),
                            })

                    elif message_type == "answer":
                        # 回答 ask_user 提出的问题
                        session_id = data.get("session_id", "default")
                        question_id = data.get("question_id", "")
                        choice = data.get("choice", "")
                        try:
                            ok = agentcore_post_answer(
                                session_id, question_id, choice,
                            )
                            await websocket.send_json({
                                "type": "answer_ack",
                                "session_id": session_id,
                                "question_id": question_id,
                                "accepted": ok,
                            })
                        except Exception as e:
                            logger.warning(f"WS answer failed: {e}")
                            await websocket.send_json({
                                "type": "error",
                                "message": f"answer failed: {e}",
                                "code": "answer_failed",
                            })

                    else:
                        # 未知消息类型 — 仅记录, 不 disconnect (宽容协议)
                        logger.debug(f"WS unknown message type: {message_type}")

            except WebSocketDisconnect:
                self.websocket_manager.disconnect(websocket)
            except Exception as e:
                logger.error(f"WebSocket error: {e}", exc_info=True)
                self.websocket_manager.disconnect(websocket)
        
        @app.websocket("/ws/vtuber")
        async def websocket_vtuber(websocket: WebSocket):
            """
            虚拟主播 WebSocket 接口
            
            全双工通信，支持:
            - 文本消息 -> LLM -> 流式TTS -> 音频流
            - 实时口型同步数据
            - 语音打断
            """
            await vtuber_handler.handle_connection(websocket, session_id="vtuber_main")
        
        @app.websocket("/ws/vtuber/{session_id}")
        async def websocket_vtuber_session(websocket: WebSocket, session_id: str):
            """虚拟主播 WebSocket 接口（支持多会话）"""
            await vtuber_handler.handle_connection(websocket, session_id=session_id)

        # ========== 自定义 404 / 500 JSON 处理器 ==========
        # FastAPI 默认 404 返回 HTML ("{\"detail\":\"Not Found\"}")，前端 fetch
        # 解析 JSON 会失败。这里改成统一返回 JSON，并加上 sidecar_api_version
        # 字段，方便前端检测 "sidecar 版本过旧"（旧 sidecar 没有某个端点 → 404）。

        @app.exception_handler(404)
        async def not_found_handler(request, exc):
            path = request.url.path
            # SPA 路径（无 /api/ 前缀）依然返回 index.html，让前端路由处理
            # 但因为我们在 mount 静态文件时已经注册了 catch-all，这里基本不会触发。
            # /api/ 路径返回 JSON 404，附带 sidecar 版本提示。
            return JSONResponse(
                status_code=404,
                content={
                    "detail": "Not Found",
                    "path": path,
                    "sidecar_api_version": SIDECAR_API_VERSION,
                    "sidecar_api_version_int": SIDECAR_API_VERSION_INT,
                    "hint": (
                        "This endpoint does not exist on the running sidecar. "
                        "If you upgraded the desktop client but see this, the bundled "
                        "sidecar.exe may be outdated. Reinstall the latest client "
                        "to get a matching sidecar."
                    ),
                },
            )

        @app.exception_handler(500)
        async def server_error_handler(request, exc):
            logger.exception(f"500 error on {request.url.path}: {exc}")
            return JSONResponse(
                status_code=500,
                content={
                    "detail": str(exc) if exc else "Internal Server Error",
                    "path": request.url.path,
                    "sidecar_api_version": SIDECAR_API_VERSION,
                },
            )

        # ========== 微信 ClawBot API ==========

        @app.get("/api/wechat/status")
        async def wechat_status():
            """获取微信连接状态"""
            wechat = platform_manager.get("wechat")
            if not wechat:
                return {"enabled": False, "status": "not_configured", "connected": False}
            # 周期性验证 session 存活（每 60 秒最多一次，不阻塞快速返回）
            if wechat.login_status == "connected":
                await wechat.check_session_alive()
            return {
                "enabled": wechat.config.enabled or wechat.is_connected,
                "auto_reply": wechat.wechat_config.auto_reply,
                "status": wechat.login_status,
                "connected": wechat.is_connected,
                "account_id": wechat._account_id,
            }

        @app.post("/api/wechat/login")
        async def wechat_login():
            """触发微信扫码登录"""
            wechat = platform_manager.get("wechat")
            if not wechat:
                raise HTTPException(status_code=404, detail="WeChat platform not configured")
            try:
                qrcode_b64 = await wechat.start_qrcode_login()
                return {"status": "qrcode", "qrcode_base64": qrcode_b64}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        @app.post("/api/wechat/disconnect")
        async def wechat_disconnect():
            """断开微信连接"""
            wechat = platform_manager.get("wechat")
            if not wechat:
                raise HTTPException(status_code=404, detail="WeChat platform not configured")
            await wechat.disconnect()
            return {"status": "disconnected"}

        @app.patch("/api/wechat/settings")
        async def update_wechat_settings(request: dict):
            wechat = platform_manager.get("wechat")
            if not wechat:
                raise HTTPException(status_code=404, detail="WeChat platform not configured")
            enabled = request.get("enabled")
            if not isinstance(enabled, bool):
                raise HTTPException(status_code=400, detail="enabled must be a boolean")
            wechat.wechat_config.auto_reply = enabled
            return {"enabled": enabled}

        @app.post("/api/wechat/send")
        async def wechat_send(request: dict):
            """手动发送微信消息"""
            wechat = platform_manager.get("wechat")
            if not wechat or not wechat.is_connected:
                raise HTTPException(status_code=400, detail="WeChat not connected")
            user_id = request.get("user_id")
            text = request.get("text", "")
            if not user_id or not text:
                raise HTTPException(status_code=400, detail="user_id and text required")
            msg = SendMessage(content=text, metadata={"user_id": user_id})
            success = await wechat.send_message(msg)
            return {"success": success}

        # ========== 文件上传 API ==========
        # 文件存储位置: ~/.hakus/uploads/
        # 单文件大小限制: 10MB. 文本文件会生成前 2000 字符的预览.

        _UPLOAD_DIR = Path(os.path.expanduser("~/.hakus/uploads"))
        _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        # 文本文件扩展名集合 — 这些类型的文件会生成 text_preview
        _TEXT_EXTENSIONS = {
            ".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml",
            ".xml", ".html", ".css", ".java", ".c", ".cpp", ".go", ".rs",
            ".rb", ".sh", ".sql",
        }

        # 单文件大小限制: 10MB
        _MAX_UPLOAD_SIZE = 10 * 1024 * 1024

        @app.post("/api/upload")
        async def upload_files(files: List[UploadFile] = File(...)):
            """上传文件 (支持多文件, multipart/form-data).

            返回每个文件的元数据: file_id / filename / size / content_type /
            text_preview (仅文本文件, 前 2000 字符) / is_text.

            单文件限制 10MB. 文件存储到 ~/.hakus/uploads/{file_id}_{filename}.
            支持所有文件类型, 但只有文本类型会生成 text_preview.
            """
            results = []
            for upload in files:
                # 读文件内容到内存 (限制 10MB)
                content = await upload.read()
                if len(content) > _MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"File '{upload.filename}' too large: "
                            f"{len(content)} bytes (max {_MAX_UPLOAD_SIZE})"
                        ),
                    )

                file_id = uuid.uuid4().hex
                filename = upload.filename or f"upload_{file_id}"
                content_type = upload.content_type or "application/octet-stream"

                # 判断是否是文本文件 (按扩展名)
                ext = Path(filename).suffix.lower()
                is_text = ext in _TEXT_EXTENSIONS

                # 生成 text_preview (仅文本文件, 前 2000 字符)
                text_preview = None
                if is_text:
                    try:
                        text = content.decode("utf-8", errors="replace")
                        text_preview = text[:2000]
                    except Exception as e:
                        logger.warning(f"Failed to generate text_preview for {filename}: {e}")

                # 存储文件: {file_id}_{filename} 避免重名覆盖
                safe_filename = f"{file_id}_{filename}"
                dest_path = _UPLOAD_DIR / safe_filename
                try:
                    with open(dest_path, "wb") as f:
                        f.write(content)
                except Exception as e:
                    logger.error(f"Failed to save uploaded file {filename}: {e}")
                    raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")

                logger.info(
                    f"Uploaded file saved: {filename} -> {dest_path.name} "
                    f"({len(content)} bytes, is_text={is_text})"
                )

                results.append({
                    "file_id": file_id,
                    "filename": filename,
                    "size": len(content),
                    "content_type": content_type,
                    "text_preview": text_preview,
                    "is_text": is_text,
                })

            return {"files": results}

        @app.get("/api/files/{file_id}")
        async def get_file(file_id: str):
            """获取上传的文件内容.

            返回文件流 (FileResponse). 如果找不到, 返回 404.
            file_id 必须是 32 位 uuid hex, 防止路径穿越.
            """
            # file_id 是 uuid hex (32 位十六进制), 严格校验防止路径穿越
            if len(file_id) != 32 or not all(c in "0123456789abcdef" for c in file_id.lower()):
                raise HTTPException(status_code=400, detail="Invalid file_id")

            # 在 uploads 目录中查找以 "{file_id}_" 开头的文件
            matches = list(_UPLOAD_DIR.glob(f"{file_id}_*"))
            if not matches:
                raise HTTPException(status_code=404, detail="File not found")

            file_path = matches[0]
            # 去掉 "{file_id}_" 前缀还原原始文件名
            original_name = file_path.name[len(file_id) + 1:]
            return FileResponse(
                path=file_path,
                filename=original_name,
            )

        @app.get("/api/files")
        async def list_files():
            """列出所有已上传的文件.

            返回每个文件的元数据 (不含文件内容).
            按上传时间倒序排列 (最新在前).
            """
            files = []
            for entry in _UPLOAD_DIR.iterdir():
                if not entry.is_file():
                    continue
                name = entry.name
                # 文件名格式: {file_id}_{original_filename}
                if "_" not in name:
                    continue
                file_id, original_name = name.split("_", 1)
                stat = entry.stat()
                ext = Path(original_name).suffix.lower()
                is_text = ext in _TEXT_EXTENSIONS
                files.append({
                    "file_id": file_id,
                    "filename": original_name,
                    "size": stat.st_size,
                    "content_type": "application/octet-stream",  # 未持久化 content_type, 用默认值
                    "is_text": is_text,
                    "uploaded_at": stat.st_mtime,
                })
            # 按上传时间倒序 (最新在前)
            files.sort(key=lambda x: x.get("uploaded_at", 0), reverse=True)
            return {"files": files}

        # ============ Git / Workspace (Codex-style review panel) ============
        # These endpoints back the right-hand Review/Terminal pane in the
        # desktop client. They inspect the *agent* working directory
        # (_REPO_ROOT, two levels above this file), so the diff the user
        # sees matches what the agent actually operates on.

        import asyncio as _asyncio
        import asyncio.subprocess as _asub

        # Project root — same definition as agent_bridge._REPO_ROOT.
        _WORKDIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

        _GIT_STATUS_MAP = {
            "M": "modified", "A": "added", "D": "deleted",
            "R": "renamed", "C": "renamed", "??": "untracked",
        }

        async def _run_git(args: List[str], cwd: str = _WORKDIR, timeout: float = 30.0) -> tuple[str, str, int]:
            """Run a git command asynchronously, returning (stdout, stderr, returncode)."""
            try:
                proc = await _asyncio.create_subprocess_exec(
                    "git", "--no-pager", *args,
                    stdout=_asub.PIPE,
                    stderr=_asub.PIPE,
                    cwd=cwd,
                )
            except FileNotFoundError:
                return "", "git not found on PATH", 127
            try:
                stdout, stderr = await _asyncio.wait_for(proc.communicate(), timeout=timeout)
            except _asyncio.TimeoutError:
                try:
                    proc.kill()
                except Exception:
                    pass
                return "", "git command timed out", 124
            return (
                stdout.decode("utf-8", errors="replace"),
                stderr.decode("utf-8", errors="replace"),
                proc.returncode if proc.returncode is not None else 1,
            )

        def _parse_porcelain_unused():  # kept as reference; parsing is inlined below
            return []

        @app.get("/api/git/status")
        async def git_status():
            """Branch + changed file list for the agent working directory."""
            # Branch
            branch_out, _, _ = await _run_git(["rev-parse", "--abbrev-ref", "HEAD"])
            branch = branch_out.strip()
            # Detect repo
            inside_out, _, inside_rc = await _run_git(["rev-parse", "--is-inside-work-tree"])
            is_repo = inside_rc == 0 and inside_out.strip() == "true"

            if not is_repo:
                return {
                    "branch": "",
                    "workdir": _WORKDIR,
                    "is_repo": False,
                    "unstaged": [],
                    "staged": [],
                    "untracked": [],
                }

            # Porcelain v1: "XY path" — X=staged, Y=unstaged, ??=untracked
            porcelain, _, _ = await _run_git(["status", "--porcelain=v1"])
            unstaged: List[Dict[str, Any]] = []
            staged: List[Dict[str, Any]] = []
            untracked: List[Dict[str, Any]] = []
            for raw in porcelain.splitlines():
                if not raw or len(raw) < 4:
                    continue
                xy = raw[:2]
                path = raw[3:]
                x, y = xy[0], xy[1]
                if x == "?" or y == "?":
                    untracked.append({"path": path, "status": "untracked", "staged": False})
                    continue
                if x != " " and x != "?":
                    staged.append({"path": path, "status": _GIT_STATUS_MAP.get(x, "unknown"), "staged": True})
                if y != " " and y != "?":
                    unstaged.append({"path": path, "status": _GIT_STATUS_MAP.get(y, "unknown"), "staged": False})

            return {
                "branch": branch,
                "workdir": _WORKDIR,
                "is_repo": True,
                "unstaged": unstaged,
                "staged": staged,
                "untracked": untracked,
            }

        @app.get("/api/git/diff")
        async def git_diff(staged: bool = False, ref: Optional[str] = None, paths: Optional[str] = None):
            """Unified diff text. staged=True → --cached; ref=HEAD~1 → diff against ref."""
            args = ["diff", "--no-color", "--no-ext-diff"]
            if staged:
                args.append("--cached")
            if ref:
                args.append(ref)
            if paths:
                args.append("--")
                args.extend([p.strip() for p in paths.split(",") if p.strip()])

            out, err, rc = await _run_git(args)
            if rc != 0:
                # Not a repo or git error — return empty diff with a hint
                raise HTTPException(status_code=400, detail=err.strip() or "git diff failed")

            truncated = False
            max_chars = 60000
            if len(out) > max_chars:
                half = max_chars // 2
                out = out[:half] + f"\n... [truncated, {len(out)} total chars] ...\n" + out[-half:]
                truncated = True

            return {"diff": out, "truncated": truncated, "workdir": _WORKDIR}

        class StageRequest(BaseModel):
            path: str
            unstage: bool = False

        @app.post("/api/git/stage")
        async def git_stage(req: StageRequest):
            """Stage (git add) or unstage (git restore --staged) a path."""
            # Validate path to avoid shell injection — git takes argv, but
            # reject anything trying to escape via path traversal.
            target = req.path.strip()
            if not target or target.startswith("--") or "\x00" in target:
                raise HTTPException(status_code=400, detail="invalid path")
            if req.unstage:
                args = ["restore", "--staged", "--", target]
            else:
                args = ["add", "--", target]
            out, err, rc = await _run_git(args)
            if rc != 0:
                raise HTTPException(status_code=400, detail=err.strip() or "git stage failed")
            return {"ok": True, "path": target, "unstage": req.unstage}

        # The Python PTY terminal used to live here. It was retired because the
        # Rust Runtime is the only execution authority (docs/REFACTOR_SPEC.md,
        # Phase 2: "block direct desktop and Python tool execution on the default
        # path"), and because this handler was strictly weaker than its Rust
        # replacement: it accepted any WebSocket with no Origin check and went
        # straight to spawning an interactive shell, bypassing the agent
        # permission engine entirely.
        #
        # The Rust route is `runtime_api::terminal_ws`
        # (crates/tui/src/runtime_api/terminal.rs), served at the same
        # `/ws/terminal` path on the Runtime port. It requires a loopback peer
        # AND an allowlisted Origin (tauri://localhost, http://localhost:1420,
        # ...), and clamps the requested terminal dimensions. It also speaks the
        # `{"type":"init", cwd, cols, rows}` handshake the desktop client sends
        # (TerminalPanel.tsx), which this handler never implemented.
        #
        # Kept as an explicit refusal rather than deleted outright: a silent 404
        # on a websocket route reads as a transport bug, and this way any client
        # still speaking the old `{"type":"stdin"}` protocol gets told why.
        @app.websocket("/ws/terminal")
        async def terminal_ws_retired(websocket: WebSocket):
            await websocket.accept()
            await websocket.send_json({
                "type": "error",
                "message": (
                    "This Python terminal route has been retired. Use the Rust "
                    "Runtime's /ws/terminal on the Runtime port (default 48081), "
                    "which enforces a loopback + Origin check. See Phase 2 of "
                    "docs/REFACTOR_SPEC.md."
                ),
            })
            await websocket.close()

    async def start(self):
        """启动服务器"""
        if self.app is None:
            self.create_app()
        
        config = uvicorn.Config(
            self.app,
            host=self.config.server.host,
            port=self.config.server.port,
            log_level="info"
        )
        server = uvicorn.Server(config)
        await server.serve()
    
    def run(self):
        """运行服务器（阻塞）"""
        if self.app is None:
            self.create_app()
        
        # 尝试使用配置的端口，如果被占用则尝试其他端口
        port = self.config.server.port
        import socket
        for _ in range(10):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind((self.config.server.host, port))
                    break
            except OSError:
                logger.warning(f"Port {port} is in use, trying {port + 1}")
                port += 1
        
        logger.info(f"Starting server on port {port}")
        uvicorn.run(
            self.app,
            host=self.config.server.host,
            port=port,
            log_level="info"
        )


class WebSocketManager:
    """
    WebSocket连接管理器 — Phase 4 加入心跳/清理循环。

    设计目标 (5h SWE 稳定性):
      - 每个连接维护 ``_last_seen`` 时间戳，任何收到的消息都刷新它。
      - 后台 ``_cleanup_loop`` 每 60s 扫描一次，关闭 180s 内无任何消息
        (即没收到 ping/pong/任何数据) 的连接。这样客户端崩溃/断网时
        服务端不会无限挂着 zombie 连接 — 对 5h 长任务尤其关键，否则
        内存会缓慢累积。
      - 服务端主动 ping: ``_heartbeat_loop`` 每 30s 向所有连接发 ping,
        客户端应在 60s 内回 pong (或任意消息)。客户端不响应就靠
        cleanup_loop 来收尸。
    """

    HEARTBEAT_INTERVAL_S = 30.0   # 服务端每 30s 发一次 ping
    CLEANUP_INTERVAL_S = 60.0     # 每 60s 扫描一次僵尸连接
    STALE_THRESHOLD_S = 180.0     # 180s 没消息 = zombie

    def __init__(self):
        self.active_connections: list = []
        # websocket -> last seen unix timestamp (monotonic 不行, 跨线程/进程没意义)
        # 用 wall time 即可, 心跳容忍秒级误差。
        self._last_seen: Dict[WebSocket, float] = {}
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None

    async def connect(self, websocket: WebSocket) -> None:
        """接受新连接并初始化 last_seen。"""
        await websocket.accept()
        self.active_connections.append(websocket)
        self._last_seen[websocket] = time.time()
        logger.info(f"WebSocket connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket) -> None:
        """断开连接并清理 last_seen。"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        self._last_seen.pop(websocket, None)
        logger.info(f"WebSocket disconnected. Total: {len(self.active_connections)}")

    def update_last_seen(self, websocket: WebSocket) -> None:
        """收到任意消息时调用 — 刷新 last_seen 以阻止 cleanup_loop 收尸。"""
        self._last_seen[websocket] = time.time()

    async def start_background_loops(self) -> None:
        """启动心跳和清理后台任务。在 lifespan 启动阶段调用一次。"""
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop_background_loops(self) -> None:
        """停止心跳和清理任务。在 lifespan 关闭阶段调用。"""
        for task in (self._heartbeat_task, self._cleanup_task):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.warning(f"WS background task error during stop: {e}")
        self._heartbeat_task = None
        self._cleanup_task = None

    async def _heartbeat_loop(self) -> None:
        """每 HEARTBEAT_INTERVAL_S 秒向所有连接发 ping。

        这是服务端主动 ping —— 客户端只需在 onmessage 里识别 ``type=ping``
        并回 ``type=pong`` 即可。即使客户端不回, 也无所谓 —— cleanup_loop
        会按 last_seen 判定僵尸并收尸。
        """
        while True:
            try:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL_S)
                if not self.active_connections:
                    continue
                ping_msg = {"type": "ping", "ts": time.time()}
                dead: list = []
                for conn in list(self.active_connections):
                    try:
                        await conn.send_json(ping_msg)
                    except Exception as e:
                        logger.debug(f"Heartbeat send failed: {e}")
                        dead.append(conn)
                for conn in dead:
                    self.disconnect(conn)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Heartbeat loop iteration error: {e}", exc_info=True)

    async def _cleanup_loop(self) -> None:
        """每 CLEANUP_INTERVAL_S 秒扫描, 关闭 STALE_THRESHOLD_S 内无消息的连接。"""
        while True:
            try:
                await asyncio.sleep(self.CLEANUP_INTERVAL_S)
                if not self._last_seen:
                    continue
                now = time.time()
                stale = [
                    ws for ws, ts in self._last_seen.items()
                    if now - ts > self.STALE_THRESHOLD_S
                ]
                for ws in stale:
                    logger.warning(
                        f"Closing stale WebSocket: no message for "
                        f"{now - self._last_seen.get(ws, now):.1f}s"
                    )
                    try:
                        # 1001 = Going Away; 用 1008 (policy violation) 也行,
                        # 但客户端对 1001 重连更友好。
                        await ws.close(code=1001)
                    except Exception as e:
                        logger.debug(f"Stale ws close failed: {e}")
                    self.disconnect(ws)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Cleanup loop iteration error: {e}", exc_info=True)

    async def broadcast(self, message: dict):
        """广播消息到所有连接"""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
                self._last_seen[connection] = time.time()
            except Exception:
                disconnected.append(connection)

        # 清理断开的连接
        for conn in disconnected:
            self.disconnect(conn)


# 全局服务器实例
server = HakusAIServer()


if __name__ == "__main__":
    import os
    import socket as _socket
    import sys as _sys

    # Windows 中文系统下，stdout/stderr 被管道接管（桌面端 sidecar、
    # PowerShell 捕获、重定向到文件）时 Python 默认用 GBK 编码输出，
    # 而消费方（Tauri backend.rs 的 from_utf8_lossy、UTF-8 终端）按
    # UTF-8 解码 → 中文日志全部乱码。这里强制 UTF-8，与消费方对齐。
    for _stream in (_sys.stdout, _sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    port = int(os.environ.get("HAKUSAI_PORT", "48081"))
    host = server.config.server.host
    for p in range(port, port + 10):
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                port = p
                break
            except OSError:
                continue

    # Print the chosen port to stdout so Electron's sidecar.ts can parse it.
    # This matches the behaviour of sidecar/hakusai_server_entry.py.
    print(f"HAKUSAI_PORT={port}", flush=True)
    server.config.server.host = host
    server.config.server.port = port
    server.run()
