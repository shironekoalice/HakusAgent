"""Guardian LLM Configuration — create a lightweight, independent LLM client
for the Guardian AI approval system.

The Guardian must use a SEPARATE model from the agent's main model to
prevent self-approval attacks. This module configures a cheap, fast model
(e.g., deepseek-chat / deepseek-v4-flash) specifically for Guardian.

Design:
  1. Guardian client is created independently from the main agent client
  2. Uses a cheaper/faster model variant (flash/lite) when available
  3. Falls back to the main model if Guardian-specific config is missing
  4. Can be overridden via config.yaml [guardian] section
"""
from __future__ import annotations

import os
from typing import Any, Optional

from utils.logger import get_logger

logger = get_logger(__name__)


# Default Guardian model configs per provider
# These are intentionally lighter/cheaper than the main agent models
_GUARDIAN_MODEL_DEFAULTS = {
    "deepseek": {
        "model_name": "deepseek-chat",  # DeepSeek-V3 (cheap, fast)
        "base_url": "https://api.deepseek.com",
        "api_key_env": "DEEPSEEK_API_KEY",
    },
    "openai": {
        "model_name": "gpt-4o-mini",  # Cheap OpenAI model
        "base_url": "https://api.openai.com/v1",
        "api_key_env": "OPENAI_API_KEY",
    },
    "anthropic": {
        "model_name": "claude-3-5-haiku-20241022",  # Cheapest Claude
        "base_url": "https://api.anthropic.com",
        "api_key_env": "ANTHROPIC_API_KEY",
    },
    "qwen": {
        "model_name": "qwen-turbo",  # Cheapest Qwen
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key_env": "DASHSCOPE_API_KEY",
    },
    "glm": {
        "model_name": "glm-4-flash",  # GLM Flash (free tier)
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "api_key_env": "GLM_API_KEY",
    },
    "gemini": {
        "model_name": "gemini-2.0-flash",  # Gemini Flash
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "api_key_env": "GEMINI_API_KEY",
    },
    "opencode": {
        "model_name": "deepseek/deepseek-chat-v3-0324:free",  # OpenCode free
        "base_url": "https://openrouter.ai/api/v1",
        "api_key_env": "OPENCODE_API_KEY",
    },
}


def create_guardian_client(
    provider: Optional[str] = None,
    model_name: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    timeout: float = 15.0,
) -> Optional[Any]:
    """Create a lightweight LLM client for Guardian AI.

    The Guardian client is intentionally separate from the main agent
    model to prevent self-approval. It uses a cheaper/faster variant.

    Args:
        provider: Provider ID (defaults to "deepseek")
        model_name: Override model name (e.g., "deepseek-v4-flash")
        api_key: Override API key (defaults to env var)
        base_url: Override base URL
        timeout: Guardian call timeout in seconds

    Returns:
        BaseLLMClient instance, or None if creation fails

    Example:
        # Simple usage — auto-detect cheapest model
        guardian_client = create_guardian_client()

        # Explicit deepseek-v4-flash
        guardian_client = create_guardian_client(
            provider="deepseek",
            model_name="deepseek-v4-flash",
        )

        # Then wire into P1Enhancements
        agent.enable_p1_enhancements(guardian_model_client=guardian_client)
    """
    provider = provider or "deepseek"

    # Check for config.yaml override
    try:
        from utils.config import _resolved_config
        guardian_cfg = _resolved_config.get("guardian", {})
        if guardian_cfg:
            provider = guardian_cfg.get("provider", provider)
            model_name = guardian_cfg.get("model_name", model_name)
            api_key = guardian_cfg.get("api_key", api_key)
            base_url = guardian_cfg.get("base_url", base_url)
    except Exception:
        pass

    defaults = _GUARDIAN_MODEL_DEFAULTS.get(provider, {})

    # Resolve API key: explicit > env var > hakus_config
    if not api_key:
        env_var = defaults.get("api_key_env", "")
        if env_var:
            api_key = os.environ.get(env_var, "")
    if not api_key:
        try:
            from utils.hakus_config import get_config
            config = get_config()
            prov_cfg = getattr(config.models, provider, None)
            if prov_cfg:
                api_key = getattr(prov_cfg, "api_key", "") or api_key
                if not base_url:
                    base_url = getattr(prov_cfg, "base_url", "") or base_url
        except Exception:
            pass

    # Resolve model name
    if not model_name:
        model_name = defaults.get("model_name", "")

    # Resolve base URL
    if not base_url:
        base_url = defaults.get("base_url", "")

    if not api_key:
        logger.warning(
            f"Guardian: no API key found for provider '{provider}'. "
            f"Set {defaults.get('api_key_env', 'API_KEY')} env var or configure in config.yaml."
        )
        return None

    # Create the client
    try:
        from .models.base_client import LLMProvider, ModelConfig
        from .models.legacy_provider_adapter import (
            LegacyProviderAdapter,
            redact_provider_diagnostic,
        )
        from .models.openai_compatible_client import OpenAICompatibleClient

        provider_enum = LLMProvider(provider.lower())
        config = ModelConfig(
            provider=provider_enum,
            api_key=api_key,
            base_url=base_url,
            model_name=model_name,
            timeout=timeout,
        )
        adapter = LegacyProviderAdapter(provider_enum)
        client = adapter.bind_preconfigured(lambda: OpenAICompatibleClient(config))
        logger.info(
            f"Guardian LLM client created: {provider}/{model_name} "
            f"(independent from main agent model)"
        )
        return client
    except Exception as e:
        logger.warning(
            f"Failed to create Guardian LLM client: "
            f"{redact_provider_diagnostic(e)}"
        )
        return None


def configure_guardian_in_agent(
    agent: Any,
    provider: Optional[str] = None,
    model_name: Optional[str] = None,
) -> bool:
    """Convenience: create Guardian client and enable P1 enhancements on an agent.

    Args:
        agent: AgentCore instance
        provider: Guardian model provider (default: deepseek)
        model_name: Guardian model name (default: provider-specific)

    Returns:
        True if Guardian was successfully configured
    """
    guardian_client = create_guardian_client(
        provider=provider,
        model_name=model_name,
    )

    if not guardian_client:
        logger.warning("Guardian client creation failed — Guardian will be disabled")
        return False

    # Enable P1 with Guardian client
    p1 = agent.enable_p1_enhancements(
        enable_guardian=True,
        guardian_model_client=guardian_client,
    )

    if p1 and p1.guardian and p1.guardian.enabled:
        logger.info("Guardian AI successfully configured and enabled")
        return True
    else:
        logger.warning("Guardian AI enabled but not active — check model client")
        return False


def get_guardian_status(agent: Any) -> dict:
    """Get the current Guardian configuration status."""
    p1 = getattr(agent, "_p1", None)
    if not p1 or not p1.guardian:
        return {"enabled": False, "reason": "P1 or Guardian not initialized"}

    guardian = p1.guardian
    stats = guardian.get_stats()
    return {
        "enabled": guardian.enabled,
        "model_available": bool(guardian._model),
        "model_name": getattr(guardian._model, "model_name", "unknown") if guardian._model else "none",
        **stats,
    }
