"""
Provider operations: connection testing + model list fetching + multi-key + custom headers.

These are the runtime-side helpers called by the FastAPI endpoints in server.py.
They are kept separate from the main client_factory / BaseLLMClient hierarchy
because they're not part of the chat path — they're "configuration-time" ops
the user runs from the settings panel.

Design notes:
- Uses httpx directly (already in deps) so we don't drag in provider-specific SDKs.
- Reads raw ~/.hakus/config.yaml for api_keys/base_url, NOT the pydantic config.
  This matches what server.py's list_providers / update_provider already do —
  raw YAML is the source of truth for these fields.
- Resolves ${VAR:default} placeholders the same way list_providers does, so
  the test runs against the actual user-visible config.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import yaml as _yaml

logger = logging.getLogger(__name__)

# --- placeholder resolution ---
#
# Public API: resolve_placeholder(val) — used by server.py list_providers,
# _resolve_provider_config, list_provider_keys. Single source of truth so
# base_url / model_name / api_key all get the same ${VAR:default} handling.
#
# Background: previously this function was duplicated in server.py:list_providers
# and only applied to base_url + model_name, NOT api_key. That left api_key as
# the literal "${OPENAI_API_KEY:sk-xxx}" template string, which got masked as
# "${OPE...xxx}" and shown in the UI. Fixed by centralizing here and applying
# to all three fields.

_PLACEHOLDER_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)(?::(-?[^}]*))?\}")


def redact_provider_text(value: Any, *, secrets: Tuple[str, ...] = ()) -> str:
    """Return bounded provider diagnostics without credentials or env values."""
    text = str(value or "")
    for secret in secrets:
        if secret and len(secret) >= 3:
            text = text.replace(secret, "<redacted>")
    text = re.sub(r"(?i)(bearer\s+)[^\s,;\"']+", r"\1<redacted>", text)
    text = re.sub(
        r"(?i)(api[_-]?key|token|secret|password)(\s*[=:]\s*)[^\s&,}\"']+",
        r"\1\2<redacted>",
        text,
    )
    text = re.sub(
        r"(?i)([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+",
        r"\1<redacted>",
        text,
    )
    text = re.sub(r"\$\{[^}]+\}", "<env-redacted>", text)
    return text[:500]


def resolve_placeholder(val: str) -> str:
    """Resolve ${VAR:default} placeholders using env vars.

    - If env var is set and non-empty → env value.
    - Else if a default is given (after ':' or ':-') → default.
    - Else → original string unchanged (lets caller detect unresolved
      placeholders via looks_like_placeholder()).
    - Non-string input passes through unchanged.
    """
    if not isinstance(val, str):
        return val

    def _sub(m):
        var_name, default_val = m.group(1), m.group(2)
        if default_val is not None and default_val.startswith("-"):
            default_val = default_val[1:]
        env_val = os.environ.get(var_name)
        if env_val is not None and env_val != "":
            return env_val
        return default_val if default_val is not None else m.group(0)

    return _PLACEHOLDER_RE.sub(_sub, val)


# Backward-compat alias (some internal call sites still use the underscore name).
_resolve_placeholder = resolve_placeholder


def looks_like_placeholder(val: str) -> bool:
    """Return True if val still contains an unresolved ${VAR} placeholder.

    Used by UI to render a friendly '<未设置环境变量>' mask instead of leaking
    the template syntax to the user.
    """
    if not isinstance(val, str):
        return False
    return bool(_PLACEHOLDER_RE.search(val))


# --- provider metadata (single source for provider APIs) ---

PROVIDER_META: Dict[str, Dict[str, Any]] = {
    "opencode":  {"key_name": "opencode_api_key",  "has_url": True,  "display": "OpenCode",            "default_url": "https://api.opencode.ai/v1",     "default_model": "deepseek-v4-flash-free"},
    "deepseek":  {"key_name": "deepseek_api_key",  "has_url": True,  "display": "DeepSeek",            "default_url": "https://api.deepseek.com/v1",    "default_model": "deepseek-chat"},
    "openai":    {"key_name": "openai_api_key",    "has_url": True,  "display": "OpenAI",              "default_url": "https://api.openai.com/v1",      "default_model": "gpt-4o"},
    "anthropic": {"key_name": "anthropic_api_key", "has_url": True,  "display": "Anthropic Claude",    "default_url": "https://api.anthropic.com",      "default_model": "claude-3-5-sonnet-20241022"},
    "qwen":      {"key_name": "dashscope_api_key", "has_url": True,  "display": "Qwen (通义千问)",      "default_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "default_model": "qwen-plus"},
    "gemini":    {"key_name": "gemini_api_key",    "has_url": True,  "display": "Gemini",              "default_url": "https://generativelanguage.googleapis.com/v1beta/openai", "default_model": "gemini-1.5-flash"},
    "glm":       {"key_name": "glm_api_key",       "has_url": True,  "display": "GLM (智谱)",          "default_url": "https://open.bigmodel.cn/api/paas/v4", "default_model": "glm-4-flash"},
    "mimo":      {"key_name": "mimo_api_key",      "has_url": True,  "display": "MiMo (小米)",         "default_url": "https://api.mimo.xiaomi.com/v1", "default_model": "mimo-7b-rl"},
    # AISZ is an OpenAI-compatible gateway.  The existing config uses the
    # shared openai_api_key field for this provider.
    "aisz":      {"key_name": "openai_api_key",     "has_url": True,  "display": "AISZ GPT",             "default_url": "https://api1.aisz.mom/v1",     "default_model": "gpt-5.6-luna"},
    "sensenova": {"key_name": "sensenova_api_key", "has_url": True,  "display": "SenseNova",             "default_url": "https://token.sensenova.cn/v1",     "default_model": "glm-5.2"},
    "stepfun":   {"key_name": "stepfun_api_key",   "has_url": True,  "display": "StepFun",               "default_url": "https://api.stepfun.com/v1",         "default_model": "step-5-preview"},
    "ollama":    {"key_name": "",                  "has_url": True,  "display": "Ollama (本地)",       "default_url": "http://localhost:11434/v1",      "default_model": "qwen2.5:7b"},
}

# Provider groups for the settings panel list (similar to Cherry Studio's
# grouping — domestic / international / local / aggregator).
PROVIDER_GROUPS: List[Tuple[str, List[str]]] = [
    ("国内",      ["deepseek", "qwen", "glm", "mimo"]),
    ("国际",      ["openai", "anthropic", "gemini"]),
    ("本地",      ["ollama"]),
    ("聚合",      ["opencode", "aisz", "sensenova", "stepfun"]),
]


def get_provider_meta(provider_id: str) -> Optional[Dict[str, Any]]:
    return PROVIDER_META.get(provider_id)


def list_known_providers() -> List[Dict[str, Any]]:
    """Return all providers with their group, for the frontend list."""
    groups_map: Dict[str, str] = {}
    for group_name, pids in PROVIDER_GROUPS:
        for pid in pids:
            groups_map[pid] = group_name
    out = []
    for pid, meta in PROVIDER_META.items():
        out.append({
            "id": pid,
            "display_name": meta["display"],
            "has_url": meta["has_url"],
            "group": groups_map.get(pid, "其他"),
            "default_url": meta["default_url"],
            "default_model": meta["default_model"],
        })
    return out


# --- raw config reader (single source of truth) ---

def _config_path() -> Path:
    """Return the provider config path, honoring an explicit runtime override."""
    override = os.environ.get("HAKUS_CONFIG_PATH", "").strip()
    if override:
        return Path(os.path.expandvars(os.path.expanduser(override)))
    return Path(os.path.expanduser("~/.hakus/config.yaml"))


def _load_raw_config(config_path: Optional[Path] = None) -> dict:
    config_path = config_path or _config_path()
    if not config_path.exists():
        return {}
    try:
        return _yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _save_raw_config(raw: dict) -> None:
    config_path = _config_path()
    config_dir = config_path.parent
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        _yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )


def _resolve_provider_config(provider_id: str, raw: Optional[dict] = None) -> Dict[str, str]:
    """Get resolved (api_key, base_url, model_name) for a provider.

    Returns a dict with keys: api_key, base_url, model_name.
    Falls back to PROVIDER_META defaults if config is missing.
    """
    if raw is None:
        raw = _load_raw_config()
    meta = PROVIDER_META.get(provider_id)
    if not meta:
        return {"api_key": "", "base_url": "", "model_name": ""}

    api_keys = raw.get("api_keys", {}) or {}
    models_cfg = raw.get("models", {}) or {}
    # New config files group provider overrides under models.providers, while
    # older installations stored them directly under models.  Read both so
    # health checks and the chat path resolve the same user-visible settings.
    prov_cfg = _provider_config_block(models_cfg, provider_id)

    key_name = meta["key_name"]
    # api_key must also be resolved — otherwise "${OPENAI_API_KEY:sk-xxx}"
    # gets passed to httpx as a literal Bearer token and connection test
    # always 401s.
    # Current configs keep credentials beside the provider definition.  Older
    # configs keep them under top-level api_keys; accept both, preferring the
    # provider-local value so a shared key name (AISZ/OpenAI) is unambiguous.
    api_key_raw = prov_cfg.get("api_key", "") if isinstance(prov_cfg, dict) else ""
    if not api_key_raw and key_name:
        api_key_raw = api_keys.get(key_name, "")
    if not api_key_raw and provider_id == "aisz":
        api_key_raw = api_keys.get("aisz_api_key", "")
    api_key = resolve_placeholder(api_key_raw) if api_key_raw else ""
    base_url = resolve_placeholder(prov_cfg.get("base_url", "") or meta["default_url"])
    model_name = resolve_placeholder(prov_cfg.get("model_name", "") or meta["default_model"])

    if not base_url:
        base_url = meta["default_url"]
    if not model_name:
        model_name = meta["default_model"]

    return {
        "api_key": api_key,
        "base_url": base_url,
        "model_name": model_name,
    }


def _provider_config_block(models_cfg: dict, provider_id: str) -> dict:
    """Read a provider block from current or legacy model config layouts."""
    provider_cfgs = models_cfg.get("providers", {}) or {}
    nested = provider_cfgs.get(provider_id, {}) if isinstance(provider_cfgs, dict) else {}
    legacy = models_cfg.get(provider_id, {})
    if isinstance(nested, dict) and nested:
        return nested
    return legacy if isinstance(legacy, dict) else {}


# --- connection test ---

@dataclass
class ConnectionTestResult:
    ok: bool
    message: str
    # Stable machine-readable state for UI and automation consumers.
    status: str = "error"
    detail: Optional[str] = None
    latency_ms: Optional[int] = None


async def test_provider_connection(
    provider_id: str,
    *,
    override_api_key: Optional[str] = None,
    override_base_url: Optional[str] = None,
    override_model: Optional[str] = None,
    timeout: float = 15.0,
) -> ConnectionTestResult:
    """Test connectivity + auth to a provider.

    Strategy:
    1. Try GET {base_url}/models — cheapest test, list available models.
       Works for OpenAI-compatible providers (deepseek/openai/qwen/glm/mimo/opencode/ollama).
    2. For Anthropic: POST {base_url}/v1/messages with a 1-token test message
       (Anthropic has no /models endpoint).
    3. For Gemini: GET {base_url}/models?key=... (Google-specific).

    Returns ConnectionTestResult with ok=True if any of these succeed.
    """
    meta = PROVIDER_META.get(provider_id)
    if not meta:
        return ConnectionTestResult(
            ok=False, message=f"未知 provider: {provider_id}", status="unknown_provider"
        )

    cfg = _resolve_provider_config(provider_id)
    api_key = override_api_key or cfg["api_key"]
    base_url = (override_base_url or cfg["base_url"]).rstrip("/")
    model_name = override_model or cfg["model_name"]

    # Ollama doesn't need a key
    if provider_id != "ollama" and not api_key:
        return ConnectionTestResult(
            ok=False,
            message=f"未配置 {meta['display']} 的 API Key，无法测试连接",
            status="unconfigured",
            detail="请在配置中填入 API Key 后再点测试按钮。",
        )

    headers: Dict[str, str] = {}
    if provider_id != "ollama":
        if provider_id == "anthropic":
            headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
        else:
            headers["Authorization"] = f"Bearer {api_key}"

    start = asyncio.get_event_loop().time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if provider_id == "anthropic":
                # Anthropic: POST /v1/messages with minimal payload
                url = f"{base_url}/v1/messages"
                payload = {
                    "model": model_name,
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "hi"}],
                }
                resp = await client.post(url, json=payload, headers=headers)
            elif provider_id == "gemini" and "googleapis.com" in base_url:
                # Gemini OpenAI-compat endpoint actually supports /models
                resp = await client.get(f"{base_url}/models", headers=headers)
            else:
                # OpenAI-compatible: GET /models
                resp = await client.get(f"{base_url}/models", headers=headers)

        latency = int((asyncio.get_event_loop().time() - start) * 1000)

        if resp.status_code == 200:
            return ConnectionTestResult(
                ok=True,
                message=f"{meta['display']} 连接成功 ({latency} ms)",
                status="healthy",
                latency_ms=latency,
            )
        elif resp.status_code == 401:
            return ConnectionTestResult(
                ok=False,
                message="API Key 无效或已过期",
                status="unauthorized",
                detail=f"HTTP 401 — 服务端拒绝了你的 API Key。请检查 Key 是否正确，是否对应当前选择的 provider。",
                latency_ms=latency,
            )
        elif resp.status_code == 403:
            return ConnectionTestResult(
                ok=False,
                message="API Key 权限不足",
                status="forbidden",
                detail=f"HTTP 403 — Key 有效但无权限访问 {model_name}。检查该 Key 是否开通了对应模型权限。",
                latency_ms=latency,
            )
        elif resp.status_code == 404:
            return ConnectionTestResult(
                ok=False,
                message="Base URL 错误 (404)",
                status="misconfigured",
                detail=f"{redact_provider_text(base_url, secrets=(api_key,))} 返回 404。请检查 Base URL 是否正确（注意是否带 /v1 后缀）。",
                latency_ms=latency,
            )
        elif resp.status_code == 429:
            return ConnectionTestResult(
                ok=False,
                message="请求频率超限 (429)",
                status="rate_limited",
                detail="Key 连接是通的，但当前请求频率超限。稍后再试。",
                latency_ms=latency,
            )
        else:
            body_excerpt = redact_provider_text(resp.text, secrets=(api_key,))
            return ConnectionTestResult(
                ok=False,
                message=f"HTTP {resp.status_code}",
                status="error",
                detail=body_excerpt,
                latency_ms=latency,
            )

    except httpx.ConnectError as e:
        return ConnectionTestResult(
            ok=False,
            message="无法连接到服务器",
            status="unavailable",
            detail=redact_provider_text(
                f"ConnectError: {e}\n检查 Base URL 是否正确，以及网络/代理是否拦截了请求。",
                secrets=(api_key,),
            ),
        )
    except httpx.TimeoutException:
        return ConnectionTestResult(
            ok=False,
            message=f"连接超时 (>{timeout:.0f}s)",
            status="unavailable",
            detail="服务端未在超时时间内响应。可能 Base URL 错误，或网络不通。",
        )
    except Exception as e:
        logger.warning(
            "test_provider_connection(%s) failed: %s",
            provider_id,
            redact_provider_text(repr(e), secrets=(api_key,)),
        )
        return ConnectionTestResult(
            ok=False,
            message=f"测试失败: {type(e).__name__}",
            status="error",
            detail=redact_provider_text(str(e), secrets=(api_key,)),
        )


# --- fetch models ---

@dataclass
class FetchModelsResult:
    ok: bool
    models: List[Dict[str, Any]]
    message: str
    detail: Optional[str] = None


async def fetch_provider_models(
    provider_id: str,
    *,
    override_api_key: Optional[str] = None,
    override_base_url: Optional[str] = None,
    timeout: float = 20.0,
) -> FetchModelsResult:
    """Fetch the list of available models from the provider's /models endpoint.

    Returns a list of {id, name, owned_by?} dicts.

    For providers that don't have a /models endpoint (Anthropic), we return
    a curated list of currently-known models.
    """
    meta = PROVIDER_META.get(provider_id)
    if not meta:
        return FetchModelsResult(ok=False, models=[], message=f"未知 provider: {provider_id}")

    cfg = _resolve_provider_config(provider_id)
    api_key = override_api_key or cfg["api_key"]
    base_url = (override_base_url or cfg["base_url"]).rstrip("/")

    if provider_id != "ollama" and not api_key:
        return FetchModelsResult(
            ok=False,
            models=[],
            message=f"未配置 {meta['display']} 的 API Key",
            detail="获取模型列表需要 API Key 认证。请先填入 API Key。",
        )

    # Anthropic has no /models endpoint — return a curated list.
    if provider_id == "anthropic":
        return FetchModelsResult(
            ok=True,
            models=[
                {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet"},
                {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku"},
                {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus"},
                {"id": "claude-3-sonnet-20240229", "name": "Claude 3 Sonnet"},
                {"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku"},
            ],
            message="Anthropic 无 /models 端点，返回内置模型列表",
        )

    headers: Dict[str, str] = {}
    if provider_id != "ollama":
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{base_url}/models", headers=headers)

        if resp.status_code != 200:
            return FetchModelsResult(
                ok=False,
                models=[],
                message=f"获取模型列表失败 (HTTP {resp.status_code})",
                detail=redact_provider_text(resp.text, secrets=(api_key,)),
            )

        data = resp.json()
        # OpenAI-compatible format: { data: [{id, object, owned_by}, ...] }
        raw_models = data.get("data", []) if isinstance(data, dict) else data
        if not isinstance(raw_models, list):
            return FetchModelsResult(
                ok=False,
                models=[],
                message="响应格式异常",
                detail=redact_provider_text(
                    f"expected list, got {type(raw_models).__name__}: {data}",
                    secrets=(api_key,),
                ),
            )

        models: List[Dict[str, Any]] = []
        for m in raw_models:
            if not isinstance(m, dict):
                continue
            mid = m.get("id") or m.get("name") or ""
            if not mid:
                continue
            models.append({
                "id": mid,
                "name": m.get("name") or mid,
                "owned_by": (m.get("owned_by") or {}).get("id") if isinstance(m.get("owned_by"), dict) else m.get("owned_by"),
            })
        # Sort by id for stable display
        models.sort(key=lambda x: x["id"])
        return FetchModelsResult(
            ok=True,
            models=models,
            message=f"获取到 {len(models)} 个可用模型",
        )

    except httpx.ConnectError as e:
        return FetchModelsResult(
            ok=False,
            models=[],
            message="无法连接到服务器",
            detail=redact_provider_text(f"ConnectError: {e}", secrets=(api_key,)),
        )
    except httpx.TimeoutException:
        return FetchModelsResult(
            ok=False,
            models=[],
            message=f"连接超时 (>{timeout:.0f}s)",
        )
    except Exception as e:
        logger.warning(
            "fetch_provider_models(%s) failed: %s",
            provider_id,
            redact_provider_text(repr(e), secrets=(api_key,)),
        )
        return FetchModelsResult(
            ok=False,
            models=[],
            message=f"获取失败: {type(e).__name__}",
            detail=redact_provider_text(str(e), secrets=(api_key,)),
        )


# --- multi-key management ---

# Config schema (in ~/.hakus/config.yaml):
#   api_keys:
#     deepseek_api_key: sk-xxx          # primary key (legacy, single key)
#     deepseek_api_keys:                # multiple keys (new, optional)
#       - id: deepseek-1
#         key: sk-xxx
#         label: "主号"
#         enabled: true
#       - id: deepseek-2
#         key: sk-yyy
#         label: "备用"
#         enabled: true

def _multi_key_field_name(provider_id: str) -> str:
    meta = PROVIDER_META.get(provider_id)
    if not meta or not meta["key_name"]:
        return ""
    # deepseek_api_key → deepseek_api_keys
    return meta["key_name"] + "s"


def list_provider_keys(provider_id: str) -> List[Dict[str, Any]]:
    """List all API keys configured for a provider (multi-key).

    Returns list of {id, label, masked_key, enabled, is_primary}.
    Always includes the legacy single-key entry as "primary" if set.
    """
    raw = _load_raw_config()
    api_keys = raw.get("api_keys", {}) or {}
    meta = PROVIDER_META.get(provider_id)
    if not meta:
        return []

    out: List[Dict[str, Any]] = []
    # Use the same resolver as connection tests so provider-local credentials
    # and legacy top-level credentials produce the same primary entry.
    primary_raw = _resolve_provider_config(provider_id, raw)["api_key"]
    # Resolve ${VAR:default} so the masked_key shown in UI is the real key
    # (or a friendly "<未设置>" hint if env var not set), not the literal
    # "${OPENAI_API_KEY:sk-xxx}" template.
    primary = primary_raw
    if primary:
        out.append({
            "id": "__primary__",
            "label": "主 Key",
            "masked_key": _mask_key(primary),
            "enabled": True,
            "is_primary": True,
        })

    multi_field = _multi_key_field_name(provider_id)
    multi = api_keys.get(multi_field, []) if multi_field else []
    if isinstance(multi, list):
        for entry in multi:
            if not isinstance(entry, dict):
                continue
            k_raw = entry.get("key", "")
            if not k_raw:
                continue
            k = resolve_placeholder(k_raw)
            if not k:
                continue
            out.append({
                "id": entry.get("id", ""),
                "label": entry.get("label", ""),
                "masked_key": _mask_key(k),
                "enabled": bool(entry.get("enabled", True)),
                "is_primary": False,
            })

    return out


def add_provider_key(provider_id: str, key: str, label: str = "") -> Dict[str, Any]:
    """Add an additional API key for a provider. Returns the new key entry."""
    if not key:
        raise ValueError("key 不能为空")
    meta = PROVIDER_META.get(provider_id)
    if not meta or not meta["key_name"]:
        raise ValueError(f"provider {provider_id} 不支持 API Key")

    raw = _load_raw_config()
    raw.setdefault("api_keys", {})
    multi_field = _multi_key_field_name(provider_id)
    multi = raw["api_keys"].setdefault(multi_field, [])
    if not isinstance(multi, list):
        multi = []
        raw["api_keys"][multi_field] = multi

    import uuid
    kid = f"{provider_id}-{len(multi)+1}-{uuid.uuid4().hex[:6]}"
    entry = {"id": kid, "key": key, "label": label, "enabled": True}
    multi.append(entry)
    _save_raw_config(raw)
    return {
        "id": kid,
        "label": label,
        "masked_key": _mask_key(key),
        "enabled": True,
        "is_primary": False,
    }


def delete_provider_key(provider_id: str, key_id: str) -> bool:
    """Delete an additional API key. Cannot delete the primary key."""
    if key_id == "__primary__":
        raise ValueError("不能删除主 Key，请通过清空 API Key 字段来移除")
    raw = _load_raw_config()
    api_keys = raw.get("api_keys", {}) or {}
    multi_field = _multi_key_field_name(provider_id)
    multi = api_keys.get(multi_field, []) if multi_field else []
    if not isinstance(multi, list):
        return False
    before = len(multi)
    multi = [e for e in multi if isinstance(e, dict) and e.get("id") != key_id]
    if len(multi) == before:
        return False
    api_keys[multi_field] = multi
    raw["api_keys"] = api_keys
    _save_raw_config(raw)
    return True


def _mask_key(k: str) -> str:
    """Mask an API key for display in the UI.

    - Empty → empty string.
    - Still looks like an unresolved ${VAR} placeholder (no env, no default)
      → "<未设置环境变量>" so the user understands the key isn't actually
      configured, instead of seeing the raw template syntax.
    - Length > 8 → first 4 + "..." + last 4.
    - Otherwise → all asterisks.
    """
    if not k:
        return ""
    if looks_like_placeholder(k):
        return "<未设置环境变量>"
    if len(k) > 8:
        return k[:4] + "..." + k[-4:]
    return "*" * len(k)


# --- custom HTTP headers ---

# Config schema:
#   models:
#     deepseek:
#       model_name: ...
#       base_url: ...
#       custom_headers:           # new field
#         X-Custom-Header: value

def get_provider_custom_headers(provider_id: str) -> Dict[str, str]:
    raw = _load_raw_config()
    models_cfg = raw.get("models", {}) or {}
    prov_cfg = models_cfg.get(provider_id, {}) or {}
    h = prov_cfg.get("custom_headers", {}) or {}
    return h if isinstance(h, dict) else {}


def set_provider_custom_headers(provider_id: str, headers: Dict[str, str]) -> None:
    raw = _load_raw_config()
    raw.setdefault("models", {})
    prov_cfg = raw["models"].setdefault(provider_id, {})
    # Filter out empty values
    cleaned = {k: v for k, v in headers.items() if k and v}
    if cleaned:
        prov_cfg["custom_headers"] = cleaned
    else:
        prov_cfg.pop("custom_headers", None)
    _save_raw_config(raw)
