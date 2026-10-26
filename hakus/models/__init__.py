"""HakusAI 模型适配器包 — LLM 抽象层 + Legacy 兼容层.

架构 (Phase 2 重构后):
  _legacy.py          — 原始单文件实现 (DeepSeekModel/QwenModel/...), 保持兼容
  base_client.py      — BaseLLMClient(ABC) + LLMProvider(Enum) + 数据类
  openai_compatible_client.py — 通用 OpenAI SDK 客户端
  *_client.py         — 各 Provider 便捷封装 (deepseek/qwen/gemini/glm/mimo/ollama)
  client_factory.py   — 工厂函数 create_client() / create_client_from_config()

用法 (新代码):
  from hakus.models.client_factory import create_client
  client = create_client("deepseek")
  response = await client.chat(messages, tools)

用法 (旧代码, 仍可工作):
  from hakus.models import DeepSeekModel
  model = DeepSeekModel()
"""
# Legacy 兼容重导出
from ._legacy import (
    _BaseModel,
    DeepSeekModel,
    QwenModel,
    GeminiModel,
    GLMModel,
    MiMoModel,
    OllamaModel,
)

# 新抽象层重导出 (方便 from hakus.models import ... 使用)
from .base_client import (
    BaseLLMClient,
    LLMProvider,
    LLMMessage,
    LLMResponse,
    ModelConfig,
)
from .client_factory import create_client, create_client_from_config
from .legacy_provider_adapter import (
    LegacyProviderAdapter,
    LegacyProviderRouteError,
    LegacyProviderStatus,
    redact_provider_diagnostic,
)
from .provider_registry import PROVIDERS, get_provider_ids, is_valid_provider

__all__ = [
    # Legacy
    "_BaseModel",
    "DeepSeekModel",
    "QwenModel",
    "GeminiModel",
    "GLMModel",
    "MiMoModel",
    "OllamaModel",
    # 新抽象层
    "BaseLLMClient",
    "LLMProvider",
    "LLMMessage",
    "LLMResponse",
    "ModelConfig",
    "create_client",
    "create_client_from_config",
    "LegacyProviderAdapter",
    "LegacyProviderRouteError",
    "LegacyProviderStatus",
    "redact_provider_diagnostic",
    # Provider registry
    "PROVIDERS",
    "get_provider_ids",
    "is_valid_provider",
]
