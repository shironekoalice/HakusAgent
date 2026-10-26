"""LLM Client 工厂 — 根据 provider 字符串或枚举创建对应 Client.

借鉴 trae-agent 的 LLMClient 工厂模式:
  create_client("deepseek") → DeepSeekClient()
  create_client(LLMProvider.QWEN) → QwenClient()
"""
from __future__ import annotations

import logging

from .base_client import BaseLLMClient, LLMProvider
from .deepseek_client import DeepSeekClient
from .openai_client import OpenAIClient
from .anthropic_client import AnthropicClient
from .qwen_client import QwenClient
from .gemini_client import GeminiClient
from .glm_client import GLMClient
from .mimo_client import MiMoClient
from .ollama_client import OllamaClient
from .opencode_client import OpenCodeClient
from .legacy_provider_adapter import redact_provider_diagnostic

# 可选: litellm (pip install litellm 启用)
try:
    from .litellm_client import LitellmClient
    _litellm_available = True
except ImportError:
    _litellm_available = False

logger = logging.getLogger(__name__)

_PROVIDER_CLIENT_MAP: dict[LLMProvider, type[BaseLLMClient]] = {
    LLMProvider.DEEPSEEK: DeepSeekClient,
    LLMProvider.OPENAI: OpenAIClient,
    LLMProvider.ANTHROPIC: AnthropicClient,
    LLMProvider.QWEN: QwenClient,
    LLMProvider.GEMINI: GeminiClient,
    LLMProvider.GLM: GLMClient,
    LLMProvider.MIMO: MiMoClient,
    LLMProvider.OLLAMA: OllamaClient,
    LLMProvider.OPENCODE: OpenCodeClient,
}

# Fallback 顺序: 首选 → 备选
_FALLBACK_ORDER: list[LLMProvider] = [
    LLMProvider.DEEPSEEK,
    LLMProvider.GLM,
    LLMProvider.QWEN,
    LLMProvider.OLLAMA,
    LLMProvider.MIMO,
    LLMProvider.GEMINI,
]


def create_client(provider: LLMProvider | str) -> BaseLLMClient:
    """工厂函数: 创建对应的 LLM Client.

    Args:
        provider: LLMProvider 枚举值或字符串 (如 "deepseek")

    Returns:
        初始化好的 Client 实例

    Raises:
        ValueError: 不支持的 provider
    """
    if isinstance(provider, str):
        try:
            provider = LLMProvider(provider.lower())
        except ValueError:
            raise ValueError(
                f"Unsupported LLM provider: '{provider}'. "
                f"Supported: {[p.value for p in LLMProvider]}"
            )

    cls = _PROVIDER_CLIENT_MAP.get(provider)
    if not cls:
        raise ValueError(f"Unsupported LLM provider: {provider}")
    return cls()


def create_client_from_config(
    model_type: str,
    *,
    allow_fallback: bool = True,
) -> BaseLLMClient:
    """从 BASE_CONFIG 中的 model_type 字符串创建 Client.

    这是 agent.py _init_model() 的替代品。
    ``allow_fallback`` defaults to the historical CLI behavior. Compatibility
    callers that bind a session to an explicitly selected provider must pass
    ``False`` so an unavailable provider is reported instead of silently
    changing the route the user selected.
    """
    try:
        return create_client(model_type)
    except Exception as e:
        logger.warning(
            f"Failed to init LLM client for '{redact_provider_diagnostic(model_type)}': "
            f"{redact_provider_diagnostic(e)}"
        )
        if not allow_fallback:
            raise

    # Fallback: 按顺序尝试其他 Provider
    try:
        primary = LLMProvider(model_type.lower())
    except ValueError:
        primary = None

    for fallback_provider in _FALLBACK_ORDER:
        if fallback_provider == primary:
            continue
        try:
            client = create_client(fallback_provider)
            logger.info(f"Fallback to {fallback_provider.value}")
            return client
        except Exception as e:
            logger.warning(
                f"Fallback {fallback_provider.value} failed: "
                f"{redact_provider_diagnostic(e)}"
            )

    raise RuntimeError("All LLM client initializations failed")
