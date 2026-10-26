"""P1 Enhancement Integration — wire CodexMemories, GuardianAI,
RolloutRecorder, WorldState, MultiStageCompressor, and SandboxProvider
into AgentCore's main loop.

This module provides:
  1. `P1Enhancements` — a bundle that adds P1 capabilities to an
     existing AgentCore without modifying its internals
  2. `create_enhanced_agent` — factory function that creates an
     AgentCore with all P1 enhancements
  3. Integration hooks that can be called from agent.py's run_turn loop

Usage (in agent.py)::
    # Instead of:
    agent = AgentCore(model_type="deepseek", ...)
    # Use:
    from hakus.p1_integration import create_enhanced_agent
    agent, p1 = create_enhanced_agent(model_type="deepseek", ...)

Or, to add P1 to an existing AgentCore instance::
    from hakus.p1_integration import P1Enhancements
    p1 = P1Enhancements(agent_core, working_dir="/project")
    p1.initialize()
    # Then call p1 hooks at the appropriate points in run_turn
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

from utils.logger import get_logger

logger = get_logger("hakus.p1_integration")


class P1Enhancements:
    """P1 enhancement bundle for an existing AgentCore.

    This class holds all the P1 modules and provides hook methods
    that should be called at specific points in AgentCore's run_turn
    loop.

    Attributes:
        memories: CodexMemories instance
        guardian: GuardianAI instance
        rollout: RolloutRecorder instance
        worldstate: WorldState instance
        compressor: MultiStageCompressor instance
        sandbox: SandboxProvider instance
        agents_md_gen: AgentsMdGenerator instance
    """

    def __init__(
        self,
        agent_core: Any,
        working_dir: str = "",
        session_id: str = "",
        # Feature flags
        enable_memories: bool = True,
        enable_guardian: bool = True,
        enable_rollout: bool = True,
        enable_worldstate: bool = True,
        enable_compression: bool = True,
        enable_sandbox: bool = True,
        enable_agents_md: bool = True,
        # Configuration
        guardian_model_client: Any = None,
        sandbox_config: Any = None,
    ):
        self._agent = agent_core
        self._working_dir = working_dir or os.getcwd()
        self._session_id = session_id or getattr(agent_core, "_session_id", "unknown")

        # Feature flags
        self._enable_memories = enable_memories
        self._enable_guardian = enable_guardian
        self._enable_rollout = enable_rollout
        self._enable_worldstate = enable_worldstate
        self._enable_compression = enable_compression
        self._enable_sandbox = enable_sandbox
        self._enable_agents_md = enable_agents_md

        # P1 modules (initialized lazily)
        self.memories = None
        self.guardian = None
        self.rollout = None
        self.worldstate = None
        self.compressor = None
        self.sandbox = None
        self.agents_md_gen = None

        self._guardian_model = guardian_model_client
        self._sandbox_config = sandbox_config

        # Stats
        self._turns_processed = 0
        self._memories_extracted = 0
        self._guardian_evaluations = 0
        self._compression_events = 0

    def initialize(self) -> None:
        """Initialize all enabled P1 modules."""
        # CodexMemories
        if self._enable_memories:
            try:
                from .codex_memories import CodexMemories
                self.memories = CodexMemories(project_root=self._working_dir)
                self.memories.initialize()
                logger.info(f"CodexMemories initialized: {self._working_dir}")
            except Exception as e:
                logger.warning(f"CodexMemories init failed: {e}")
                self.memories = None

        # GuardianAI
        if self._enable_guardian:
            try:
                from .guardian import GuardianAI
                # Auto-create Guardian model client if not provided
                guardian_model = self._guardian_model
                if guardian_model is None:
                    guardian_model = self._create_guardian_model_client()
                self.guardian = GuardianAI(
                    model_client=guardian_model,
                    enabled=guardian_model is not None,
                    guardian_model=getattr(guardian_model, 'model_name', '') if guardian_model else '',
                )
                logger.info(f"GuardianAI initialized (model={'set: ' + getattr(guardian_model, 'model_name', '?') if guardian_model else 'none'})")
            except Exception as e:
                logger.warning(f"GuardianAI init failed: {e}")
                self.guardian = None

        # RolloutRecorder
        if self._enable_rollout:
            try:
                from .rollout import RolloutRecorder
                self.rollout = RolloutRecorder(
                    session_id=self._session_id,
                    project_root=self._working_dir,
                )
                self.rollout.start()
                logger.info(f"RolloutRecorder initialized: {self.rollout.filepath}")
            except Exception as e:
                logger.warning(f"RolloutRecorder init failed: {e}")
                self.rollout = None

        # WorldState
        if self._enable_worldstate:
            try:
                from .worldstate import WorldState
                self.worldstate = WorldState()
                ctx = getattr(self._agent, "_context", None)
                if ctx and hasattr(ctx, "estimate_tokens"):
                    self.worldstate.set_estimate_tokens_fn(ctx.estimate_tokens)
                logger.info("WorldState initialized")
            except Exception as e:
                logger.warning(f"WorldState init failed: {e}")
                self.worldstate = None

        # MultiStageCompressor
        if self._enable_compression:
            try:
                from .compression import MultiStageCompressor
                model_client = getattr(self._agent, "_llm_client", None) or getattr(self._agent, "_model", None)
                self.compressor = MultiStageCompressor(model_client=model_client)
                logger.info("MultiStageCompressor initialized")
            except Exception as e:
                logger.warning(f"MultiStageCompressor init failed: {e}")
                self.compressor = None

        # SandboxProvider
        if self._enable_sandbox:
            try:
                from .sandbox import SandboxProvider, SandboxConfig
                config = self._sandbox_config or SandboxConfig(
                    allowed_read_paths=[self._working_dir],
                    allowed_write_paths=[self._working_dir],
                )
                self.sandbox = SandboxProvider(config)
                logger.info(f"SandboxProvider initialized (backend: {self.sandbox.backend.value})")
            except Exception as e:
                logger.warning(f"SandboxProvider init failed: {e}")
                self.sandbox = None

        # AgentsMdGenerator
        if self._enable_agents_md:
            try:
                from .agents_md import AgentsMdGenerator
                self.agents_md_gen = AgentsMdGenerator(project_root=self._working_dir)
                logger.info("AgentsMdGenerator initialized")
            except Exception as e:
                logger.warning(f"AgentsMdGenerator init failed: {e}")
                self.agents_md_gen = None

    def shutdown(self) -> None:
        """Shutdown all P1 modules."""
        if self.rollout:
            try:
                self.rollout.stop()
            except Exception:
                pass
        if self.memories:
            try:
                self.memories.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Turn-level hooks (call these from agent.py's run_turn loop)
    # ------------------------------------------------------------------

    def hook_turn_start(self, user_message: str = "") -> None:
        """Called at the start of each turn."""
        self._turns_processed += 1
        if self.rollout and self.rollout.is_recording:
            self.rollout.record_turn_start(user_message=user_message)
        if self.worldstate:
            self._update_worldstate_dynamic_sections()

    def hook_turn_end(
        self,
        response: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        tool_calls_count: int = 0,
        duration_ms: int = 0,
        compressed: bool = False,
    ) -> None:
        """Called at the end of each turn."""
        if self.rollout and self.rollout.is_recording:
            self.rollout.record_turn_end(
                response=response,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                tool_calls_count=tool_calls_count,
                duration_ms=duration_ms,
                compressed=compressed,
            )

    def hook_turn_failed(self, error: str = "", code: str = "unknown") -> None:
        """Called when a turn fails."""
        if self.rollout and self.rollout.is_recording:
            self.rollout.record_turn_failed(error=error, code=code)

    def hook_llm_call(
        self,
        model: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        duration_ms: int = 0,
        cached: bool = False,
    ) -> None:
        """Called after each LLM API call."""
        if self.rollout and self.rollout.is_recording:
            self.rollout.record_llm_call(
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                duration_ms=duration_ms,
                cached=cached,
            )

    async def hook_tool_call(
        self,
        tool_name: str,
        args: Dict[str, Any],
        result: str = "",
        success: bool = True,
        duration_ms: int = 0,
        call_id: str = "",
    ) -> tuple:
        """Called before/after each tool call.

        Returns (allowed: bool, reason: str) — if not allowed,
        the tool call should be blocked by Guardian.
        """
        # Guardian: evaluate high-risk tools
        if self.guardian and self.guardian.enabled:
            from .guardian import GuardianVerdict
            decision = await self.guardian.evaluate(
                tool_name=tool_name,
                args=args,
                context=self._get_brief_context(),
                working_dir=self._working_dir,
            )
            self._guardian_evaluations += 1

            if self.rollout and self.rollout.is_recording:
                self.rollout.record_permission_decision(
                    tool_name=tool_name,
                    allowed=decision.verdict != GuardianVerdict.DENY,
                    reason=decision.reason,
                    mode="guardian",
                )

            if decision.verdict == GuardianVerdict.DENY:
                return (False, f"Guardian denied: {decision.reason}")

        # Rollout: record tool call
        if self.rollout and self.rollout.is_recording:
            self.rollout.record_tool_call(
                name=tool_name,
                args=args,
                result=result,
                success=success,
                duration_ms=duration_ms,
                call_id=call_id,
            )

        return (True, "")

    async def hook_after_tool_results(
        self,
        user_msg: str = "",
        assistant_msg: str = "",
        tool_results: Optional[List[str]] = None,
    ) -> List[str]:
        """Called after tool results are available. Extracts memories."""
        extracted = []
        if self.memories:
            try:
                extracted = self.memories.extract_from_turn(
                    user_msg=user_msg,
                    assistant_msg=assistant_msg,
                    tool_results=tool_results,
                    session_id=self._session_id,
                )
                self._memories_extracted += len(extracted)
                if self.rollout and self.rollout.is_recording:
                    self.rollout.record_memory_extraction(
                        memory_ids=extracted,
                        content_preview=user_msg[:100],
                    )
            except Exception as e:
                logger.warning(f"Memory extraction failed: {e}")
        return extracted

    async def hook_pre_compress(
        self,
        messages: List[Dict[str, Any]],
        budget: int,
    ) -> tuple:
        """Called before context compression. Returns (compressed_messages, metrics)."""
        if self.compressor:
            try:
                compressed, metrics = await self.compressor.pre_turn_compress(
                    messages, budget,
                    estimate_tokens_fn=self._get_estimate_tokens_fn(),
                )
                self._compression_events += 1
                if self.rollout and self.rollout.is_recording:
                    self.rollout.record_compression(
                        stage=metrics.stage.value,
                        before_tokens=metrics.before_tokens,
                        after_tokens=metrics.after_tokens,
                        before_messages=metrics.before_messages,
                        after_messages=metrics.after_messages,
                    )
                return (compressed, metrics)
            except Exception as e:
                logger.warning(f"Pre-turn compression failed: {e}")
        return (messages, None)

    # ------------------------------------------------------------------
    # WorldState integration
    # ------------------------------------------------------------------

    def hook_build_messages(
        self,
        conversation_messages: List[Dict[str, Any]],
    ) -> tuple:
        """Build messages using WorldState for prompt cache optimization.

        Returns (messages, cache_info).
        """
        if self.worldstate:
            try:
                messages, cache_info = self.worldstate.build_messages(conversation_messages)
                if cache_info and cache_info.cache_hit_rate > 0:
                    logger.debug(
                        f"WorldState cache hit rate: {cache_info.cache_hit_rate:.1%} "
                        f"({cache_info.cached_tokens}/{cache_info.total_tokens} tokens)"
                    )
                return (messages, cache_info)
            except Exception as e:
                logger.warning(f"WorldState build_messages failed: {e}")
        return (conversation_messages, None)

    def _update_worldstate_dynamic_sections(self) -> None:
        """Update WorldState sections from current agent state."""
        if not self.worldstate:
            return
        ctx = getattr(self._agent, "_context", None)
        if not ctx:
            return

        # System identity (static - only set once)
        identity_section = self.worldstate.get_section("system_identity")
        if identity_section and not identity_section.content:
            model_name = getattr(self._agent, "_model_type", "unknown")
            self.worldstate.update_section(
                "system_identity",
                f"You are HakusAI, an AI coding assistant. Model: {model_name}",
            )

        # System tools (static - only set once)
        tools_section = self.worldstate.get_section("system_tools")
        if tools_section and not tools_section.content:
            registry = getattr(self._agent, "_tool_registry", None)
            if registry:
                tools = registry.list_tools()
                self.worldstate.update_section(
                    "system_tools",
                    f"Available tools: {', '.join(tools[:50])}",
                )

        # Project memory (semi-static)
        if self.memories:
            injection = self.memories.get_injection_prompt(max_tokens=1000)
            if injection:
                self.worldstate.update_section("project_memory", injection)

        # Workspace context (dynamic)
        working_dir_context = ctx.get_working_dir_context()
        git_context = ctx.get_git_context()
        workspace_text = working_dir_context
        if git_context:
            workspace_text += "\n\n" + git_context
        self.worldstate.update_section("workspace_context", workspace_text)

        # Dynamic context (dynamic)
        from datetime import datetime
        now = datetime.now()
        self.worldstate.update_section(
            "dynamic_context",
            f"Current time: {now.strftime('%Y-%m-%d %H:%M:%S')}\nSession: {self._session_id}",
        )

    # ------------------------------------------------------------------
    # Agents.md integration
    # ------------------------------------------------------------------

    def generate_agents_md(self, write: bool = False) -> str:
        """Generate AGENTS.md from project analysis."""
        if not self.agents_md_gen:
            return ""
        intel = self.agents_md_gen.analyze()
        content = self.agents_md_gen.generate(intel)
        if self.memories:
            mem_injection = self.memories.get_injection_prompt(max_tokens=2000)
            if mem_injection:
                content += "\n\n" + mem_injection
        if write:
            self.agents_md_gen.write(content)
        return content

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_brief_context(self) -> str:
        """Get a brief context summary for Guardian evaluation."""
        ctx = getattr(self._agent, "_context", None)
        if not ctx:
            return ""
        messages = getattr(ctx, "_messages", [])
        for msg in reversed(messages):
            if msg.get("role") == "user":
                return (msg.get("content") or "")[:200]
        return ""

    def _create_guardian_model_client(self) -> Any:
        """Auto-create a Guardian model client from config (OpenCode mimo-v2.5-free).

        This method creates an OpenCodeClient (which is OpenAI-compatible)
        using the Guardian section of hakus_config. If no API key is found,
        it returns None and Guardian will operate in fail-closed mode.
        """
        try:
            from utils.hakus_config import get_config
            from .models.base_client import LLMProvider, ModelConfig
            from .models.legacy_provider_adapter import (
                LegacyProviderAdapter,
                redact_provider_diagnostic,
            )

            config = get_config()
            # Try guardian-specific config first, then fall back to opencode
            guardian_prov = config.models.get_provider("guardian")
            opencode_prov = config.models.get_provider("opencode")
            prov = guardian_prov or opencode_prov

            api_key = prov.api_key if prov else ""
            base_url = prov.base_url if prov else "https://opencode.ai/zen/v1"
            model_name = prov.model_name if prov else "mimo-v2.5-free"

            if not api_key:
                # Try environment variables as last resort
                api_key = os.getenv("GUARDIAN_API_KEY") or os.getenv("OPENCODE_API_KEY", "")

            if not api_key:
                logger.warning("No Guardian API key found — Guardian will be disabled (?fail-closed)")
                return None

            # Create an OpenCode client configured for Guardian
            from .models.openai_compatible_client import OpenAICompatibleClient
            config = ModelConfig(
                provider=LLMProvider.OPENCODE,
                api_key=api_key,
                base_url=base_url,
                model_name=model_name,
            )
            adapter = LegacyProviderAdapter(LLMProvider.OPENCODE)
            client = adapter.bind_preconfigured(lambda: OpenAICompatibleClient(config))

            logger.info(f"Guardian auto-client: {model_name} @ {base_url}")
            return client

        except Exception as e:
            logger.warning(
                f"Failed to auto-create Guardian client: "
                f"{redact_provider_diagnostic(e)}"
            )
            return None

    def _get_estimate_tokens_fn(self) -> Any:
        """Get the token estimation function from context manager."""
        ctx = getattr(self._agent, "_context", None)
        if ctx and hasattr(ctx, "estimate_tokens"):
            return ctx.estimate_tokens
        return None

    def get_stats(self) -> Dict[str, Any]:
        """Return P1 enhancement statistics."""
        stats = {
            "turns_processed": self._turns_processed,
            "memories_extracted": self._memories_extracted,
            "guardian_evaluations": self._guardian_evaluations,
            "compression_events": self._compression_events,
        }
        if self.memories:
            stats["memories"] = self.memories.get_stats()
        if self.guardian:
            stats["guardian"] = self.guardian.get_stats()
        if self.worldstate:
            stats["worldstate"] = self.worldstate.get_stats()
        if self.compressor:
            stats["compressor_cache"] = self.compressor.get_cache_stats()
        if self.rollout and self.rollout.is_recording:
            stats["rollout_events"] = self.rollout._events_count
        return stats


def create_enhanced_agent(
    model_type: Optional[str] = None,
    working_dir: Optional[str] = None,
    session_id: Optional[str] = None,
    guardian_model_client: Any = None,
    **kwargs: Any,
) -> tuple:
    """Create an AgentCore with all P1 enhancements.

    Args:
        guardian_model_client: Optional pre-configured Guardian LLM client.
            If None, auto-creates an OpenCodeClient with mimo-v2.5-free.

    Returns:
        (agent_core, p1_enhancements)
    """
    from .agent import AgentCore

    agent = AgentCore(
        model_type=model_type,
        working_dir=working_dir,
        session_id=session_id,
        **kwargs,
    )

    p1 = P1Enhancements(
        agent_core=agent,
        working_dir=working_dir or os.getcwd(),
        session_id=session_id or getattr(agent, "_session_id", ""),
        guardian_model_client=guardian_model_client,
    )
    p1.initialize()

    return (agent, p1)
