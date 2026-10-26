"""Provider Registry — 权威模型提供商列表（单一数据源）.

所有 UI (ModelOverlay)、命令 (/model)、向导 (SetupWizard)
都从这里读取提供商列表，保证三处一致。
支持从 config.yaml 的 model_providers 段动态加载自定义 provider。
"""
from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Dict, List, Union

# ── 内置列表 ──────────────────────────────────────────────
# 每个条目: id(机器标识), name(显示名), desc(简短描述)
# 顺序即 UI 中的显示顺序

_BUILTIN_PROVIDERS: List[Dict[str, str]] = [
    {"id": "opencode",   "name": "OpenCode",     "desc": "Zen · 免费模型"},
    {"id": "deepseek",   "name": "DeepSeek",     "desc": "默认 · 性价比高"},
    {"id": "openai",     "name": "OpenAI",       "desc": "GPT-4o / o3"},
    {"id": "anthropic",  "name": "Anthropic",    "desc": "Claude Sonnet / Opus"},
    {"id": "qwen",       "name": "通义千问 Qwen", "desc": "阿里百炼 · 中文优化"},
    {"id": "gemini",     "name": "Gemini",       "desc": "Google 2.5 Flash / Pro"},
    {"id": "glm",        "name": "智谱 GLM",      "desc": "GLM-4 Flash / Plus"},
    {"id": "mimo",       "name": "MiMo",         "desc": "小米多模态"},
    {"id": "ollama",     "name": "Ollama",       "desc": "本地模型 · 无需 Key"},
]


def _load_custom_providers() -> List[Dict[str, str]]:
    """从 config.yaml model_providers 段加载自定义 provider."""
    custom = []
    try:
        from utils.config import _resolved_config
        providers = _resolved_config.get("model_providers") or {}
        for pid, cfg in providers.items():
            name = cfg.get("name", pid)
            model = cfg.get("model_name", "")
            desc = f"{name} · {model}" if model else name
            custom.append({"id": pid, "name": name, "desc": desc})
    except Exception:
        pass
    return custom


def get_providers() -> List[Dict[str, str]]:
    """返回所有 provider（内置 + 自定义）."""
    return _BUILTIN_PROVIDERS + _load_custom_providers()


class _ProvidersView(Sequence[Dict[str, str]]):
    """动态只读视图，保留旧的 ``PROVIDERS`` 导出接口。"""

    def __iter__(self) -> Iterator[Dict[str, str]]:
        return iter(get_providers())

    def __len__(self) -> int:
        return len(get_providers())

    def __getitem__(
        self,
        index: Union[int, slice],
    ) -> Dict[str, str] | List[Dict[str, str]]:
        return get_providers()[index]


# 兼容旧接口，同时避免把配置加载时的自定义 provider 冻结在模块导入时。
PROVIDERS = _ProvidersView()


def get_provider_ids() -> List[str]:
    """返回所有提供商 ID 列表（用于命令白名单校验）."""
    return [p["id"] for p in get_providers()]


def get_provider_names() -> List[str]:
    """返回显示名列表."""
    return [p["name"] for p in get_providers()]


def find_provider(provider_id: str) -> Dict[str, str]:
    """按 ID 查找提供商，找不到抛 ValueError."""
    for p in get_providers():
        if p["id"] == provider_id.lower():
            return p
    raise ValueError(f"未知模型商: '{provider_id}' · 可用: {get_provider_ids()}")


def is_valid_provider(provider_id: str) -> bool:
    """检查 ID 是否有效."""
    try:
        find_provider(provider_id)
        return True
    except ValueError:
        return False
