"""
Tests for hakusai_server.provider_ops — Provider 运维操作 (P0 新增)

覆盖:
  - list_known_providers: 12 个 provider, 4 个分组, 字段完整
  - _resolve_placeholder: ${VAR:default} / ${VAR:-default} / env 覆盖 / 非 placeholder 透传
  - test_provider_connection: 未知 provider / 缺 Key / 假 Key
  - fetch_provider_models: Anthropic 内置列表 / 未知 provider
  - PROVIDER_META 一致性 (key_name 与 server.py 一致)
"""
import asyncio
import os
import yaml
from unittest.mock import patch

import pytest

from hakusai_server import provider_ops as p


# ============ list_known_providers ============

def test_list_known_providers_count():
    """12 个 provider, 与 server.py PROVIDER_META 数量一致."""
    providers = p.list_known_providers()
    assert len(providers) == 12


def test_list_known_providers_groups():
    """4 个分组: 国内 / 国际 / 本地 / 聚合."""
    providers = p.list_known_providers()
    groups = {p_["group"] for p_ in providers}
    assert groups == {"国内", "国际", "本地", "聚合"}


def test_list_known_providers_fields():
    """每个 provider 必须有 id / display_name / has_url / group / default_url / default_model."""
    for prov in p.list_known_providers():
        assert "id" in prov
        assert "display_name" in prov
        assert "has_url" in prov
        assert "group" in prov
        assert "default_url" in prov
        assert "default_model" in prov
        assert prov["default_url"].startswith("http"), f"{prov['id']} default_url not http"


def test_provider_groups_order():
    """PROVIDER_GROUPS 顺序应为 国内 → 国际 → 本地 → 聚合."""
    groups = [g[0] for g in p.PROVIDER_GROUPS]
    assert groups == ["国内", "国际", "本地", "聚合"]


def test_provider_meta_key_names():
    """PROVIDER_META key_name 必须与 server.py list_providers 一致."""
    assert p.PROVIDER_META["deepseek"]["key_name"] == "deepseek_api_key"
    assert p.PROVIDER_META["qwen"]["key_name"] == "dashscope_api_key"
    assert p.PROVIDER_META["aisz"]["key_name"] == "openai_api_key"
    assert p.PROVIDER_META["ollama"]["key_name"] == ""  # ollama 不需要 key


def test_resolve_provider_config_supports_nested_provider_overrides():
    """The current config format stores provider overrides under models.providers."""
    raw = {
        "api_keys": {"openai_api_key": "fixture-primary"},
        "models": {
            "default_model": "aisz",
            "providers": {
                "aisz": {
                    "base_url": "https://gateway.example/v1",
                    "model_name": "gpt-test",
                }
            },
        },
    }
    with patch.object(p, "_load_raw_config", return_value=raw):
        cfg = p._resolve_provider_config("aisz")
    assert cfg == {
        "api_key": "fixture-primary",
        "base_url": "https://gateway.example/v1",
        "model_name": "gpt-test",
    }


def test_resolve_provider_config_prefers_provider_local_api_key():
    raw = {
        "api_keys": {"openai_api_key": "fixture-top-level"},
        "models": {"providers": {"aisz": {
            "api_key": "fixture-provider-local",
            "model_name": "gpt-5.6-luna",
        }}},
    }
    assert p._resolve_provider_config("aisz", raw)["api_key"] == "fixture-provider-local"


def test_config_path_override_is_process_scoped(tmp_path, monkeypatch):
    """Provider resolution can target an explicit config without HOME hacks."""
    cfg_path = tmp_path / "desktop-config.yaml"
    cfg_path.write_text(
        "api_keys:\n"
        "  openai_api_key: fixture-explicit\n"
        "models:\n"
        "  providers:\n"
        "    aisz: {}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HAKUS_CONFIG_PATH", str(cfg_path))
    cfg = p._resolve_provider_config("aisz")
    assert cfg["api_key"] == "fixture-explicit"
    assert cfg["model_name"] == "gpt-5.6-luna"


def test_config_api_writes_nested_provider_key_and_default(tmp_path, monkeypatch):
    """Config endpoints preserve the current models.providers layout."""
    cfg_path = tmp_path / "desktop-config.yaml"
    cfg_path.write_text(
        "api_keys: {}\nmodels:\n  providers:\n    aisz: {}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HAKUS_CONFIG_PATH", str(cfg_path))
    from fastapi.testclient import TestClient
    from hakusai_server.server import HakusAIServer

    with TestClient(HakusAIServer().create_app()) as client:
        response = client.post(
            "/api/config/providers",
            json={"provider": "aisz", "api_key": "fixture-nested", "model_name": "gpt-5.6-luna"},
        )
        assert response.status_code == 200
        response = client.post("/api/config/default-model", json={"provider": "aisz"})
        assert response.status_code == 200

    saved = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    assert saved["models"]["providers"]["aisz"]["api_key"] == "fixture-nested"
    assert saved["models"]["default_model"] == "aisz"


# ============ _resolve_placeholder ============

def test_resolve_placeholder_with_default():
    assert p._resolve_placeholder("${NONE_FOUND:default}") == "default"


def test_resolve_placeholder_with_dash_default():
    """${VAR:-default} 语法 (shell 风格)."""
    assert p._resolve_placeholder("${NONE_FOUND:-fallback}") == "fallback"


def test_resolve_placeholder_env_override():
    """env var 设置时, 优先用 env var 而非 default."""
    os.environ["TEST_PH_VAR"] = "from_env"
    try:
        assert p._resolve_placeholder("${TEST_PH_VAR:default}") == "from_env"
    finally:
        del os.environ["TEST_PH_VAR"]


def test_resolve_placeholder_no_default_passthrough():
    """无 default 且 env 未设置时, 保留原 placeholder."""
    assert "DOES_NOT_EXIST_VAR" not in os.environ
    result = p._resolve_placeholder("${DOES_NOT_EXIST_VAR}")
    assert result == "${DOES_NOT_EXIST_VAR}"


def test_resolve_placeholder_non_string_passthrough():
    """非字符串透传."""
    assert p._resolve_placeholder(123) == 123
    assert p._resolve_placeholder(None) is None


def test_resolve_placeholder_plain_string():
    """普通字符串无 ${} 不变."""
    assert p._resolve_placeholder("https://api.deepseek.com") == "https://api.deepseek.com"
    assert p._resolve_placeholder("deepseek-chat") == "deepseek-chat"


def test_redact_provider_text_removes_credentials_and_environment_placeholders():
    diagnostic = p.redact_provider_text(
        "POST https://gateway.example/v1?api_key=fixture-secret "
        "Authorization: Bearer fixture-secret body=${PROVIDER_KEY:fixture-default}",
        secrets=("fixture-secret",),
    )
    assert "fixture-secret" not in diagnostic
    assert "Bearer <redacted>" in diagnostic
    assert "<env-redacted>" in diagnostic
    assert "api_key=<redacted>" in diagnostic


def test_resolve_placeholder_multiple_in_string():
    """一个字符串里有多个 placeholder 全部解析."""
    os.environ["VAR_A"] = "aaa"
    os.environ["VAR_B"] = "bbb"
    try:
        result = p._resolve_placeholder("${VAR_A:x}-${VAR_B:y}")
        assert result == "aaa-bbb"
    finally:
        del os.environ["VAR_A"]
        del os.environ["VAR_B"]


# ============ test_provider_connection ============

@pytest.mark.asyncio
async def test_connection_unknown_provider():
    """未知 provider 返回 ok=False."""
    r = await p.test_provider_connection("nonexistent")
    assert not r.ok
    assert r.status == "unknown_provider"
    assert "未知" in r.message


@pytest.mark.asyncio
async def test_connection_missing_api_key():
    """非 ollama provider 且无 api_key (config 也没) → ok=False 提示需要 Key."""
    # 清掉 env 防干扰
    saved = os.environ.pop("OPENAI_API_KEY", None)
    try:
        # patch config to ensure no api_key present
        with patch.object(p, "_load_raw_config", return_value={}):
            r = await p.test_provider_connection("openai")
        assert not r.ok
        assert r.status == "unconfigured"
        assert "API Key" in r.message or "Key" in r.message
    finally:
        if saved is not None:
            os.environ["OPENAI_API_KEY"] = saved


@pytest.mark.asyncio
async def test_connection_fake_key_returns_401_or_network_error():
    """假 Key 测试 — 期望 401 (网络通) 或连接错误 (沙箱无网)."""
    r = await p.test_provider_connection(
        "deepseek",
        override_api_key="fixture-invalid-provider-key",
        timeout=8.0,
    )
    assert not r.ok
    # 接受 401 / 403 / 网络错误 — 沙箱环境可能无网
    msg = r.message + " " + (r.detail or "")
    acceptable = any(s in msg for s in [
        "401", "403", "无效", "权限不足", "无法连接", "超时", "ConnectError", "测试失败",
    ])
    assert acceptable, f"unexpected message: {r.message} / detail: {r.detail}"


@pytest.mark.asyncio
async def test_connection_anthropic_with_fake_key():
    """Anthropic 走 /v1/messages 路径, 假 Key 应返回 401 或网络错误."""
    r = await p.test_provider_connection(
        "anthropic",
        override_api_key="fixture-invalid-anthropic-key",
        timeout=8.0,
    )
    assert not r.ok


@pytest.mark.asyncio
async def test_connection_error_detail_redacts_provider_secret(monkeypatch):
    class FakeResponse:
        status_code = 500
        text = "upstream rejected Authorization: Bearer fixture-secret?api_key=fixture-secret"

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(p.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    result = await p.test_provider_connection(
        "deepseek",
        override_api_key="fixture-secret",
        override_base_url="https://gateway.example/v1?api_key=fixture-secret",
    )
    assert result.status == "error"
    assert result.detail is not None
    assert "fixture-secret" not in result.detail
    assert "Bearer <redacted>" in result.detail


# ============ fetch_provider_models ============

@pytest.mark.asyncio
async def test_fetch_models_unknown_provider():
    r = await p.fetch_provider_models("nonexistent")
    assert not r.ok
    assert r.models == []


@pytest.mark.asyncio
async def test_fetch_models_anthropic_returns_curated_list():
    """Anthropic 没有 /models 端点, 返回内置列表."""
    r = await p.fetch_provider_models("anthropic", override_api_key="fixture-invalid-anthropic-key")
    assert r.ok
    assert len(r.models) >= 3
    model_ids = [m["id"] for m in r.models]
    assert any("claude" in mid for mid in model_ids)


@pytest.mark.asyncio
async def test_fetch_models_missing_key():
    """非 ollama 无 Key 应返回 ok=False."""
    saved = os.environ.pop("OPENAI_API_KEY", None)
    try:
        with patch.object(p, "_load_raw_config", return_value={}):
            r = await p.fetch_provider_models("openai")
        assert not r.ok
        assert r.models == []
    finally:
        if saved is not None:
            os.environ["OPENAI_API_KEY"] = saved


# ============ multi-key management ============

def test_multi_key_field_name():
    """deepseek_api_key → deepseek_api_keys."""
    assert p._multi_key_field_name("deepseek") == "deepseek_api_keys"
    assert p._multi_key_field_name("qwen") == "dashscope_api_keys"
    assert p._multi_key_field_name("ollama") == ""  # ollama 无 key


def test_mask_key():
    assert p._mask_key("") == ""
    assert p._mask_key("short") == "*****"
    assert p._mask_key("fixture-1234567890abcdef") == "fixt...cdef"


def test_list_provider_keys_empty():
    """无 config 时返回空列表."""
    with patch.object(p, "_load_raw_config", return_value={}):
        keys = p.list_provider_keys("deepseek")
    assert keys == []


def test_list_provider_keys_with_primary_only():
    """只有主 Key (legacy) 时, 返回 1 条 is_primary=True."""
    fake_config = {
        "api_keys": {"deepseek_api_key": "fixture-abcdef1234567890"}
    }
    with patch.object(p, "_load_raw_config", return_value=fake_config):
        keys = p.list_provider_keys("deepseek")
    assert len(keys) == 1
    assert keys[0]["is_primary"] is True
    assert keys[0]["id"] == "__primary__"
    assert "..." in keys[0]["masked_key"]


def test_list_provider_keys_reads_provider_local_primary_key():
    fake_config = {
        "models": {"providers": {"aisz": {"api_key": "fixture-local-primary"}}}
    }
    with patch.object(p, "_load_raw_config", return_value=fake_config):
        keys = p.list_provider_keys("aisz")
    assert len(keys) == 1
    assert keys[0]["is_primary"] is True
    assert keys[0]["masked_key"] == "fixt...mary"


def test_list_provider_keys_with_multi_keys():
    """有主 Key + 多 Key 时, 主 Key 在前."""
    fake_config = {
        "api_keys": {
            "deepseek_api_key": "fixture-primary-key-xxxxx",
            "deepseek_api_keys": [
                {"id": "k1", "key": "fixture-extra1-key-xxxxx", "label": "备用1", "enabled": True},
                {"id": "k2", "key": "fixture-extra2-key-xxxxx", "label": "备用2", "enabled": False},
            ],
        }
    }
    with patch.object(p, "_load_raw_config", return_value=fake_config):
        keys = p.list_provider_keys("deepseek")
    assert len(keys) == 3
    assert keys[0]["is_primary"] is True
    assert keys[1]["id"] == "k1"
    assert keys[1]["is_primary"] is False
    assert keys[1]["enabled"] is True
    assert keys[2]["id"] == "k2"
    assert keys[2]["enabled"] is False


def test_add_provider_key_writes_config():
    """添加 Key 应写入 config 的 multi_key 字段."""
    saved_config = {}
    with patch.object(p, "_load_raw_config", return_value={"api_keys": {}}):
        with patch.object(p, "_save_raw_config", side_effect=lambda r: saved_config.update(r)):
            entry = p.add_provider_key("deepseek", "fixture-new-key-xxxxx", "test-label")
    assert entry["id"].startswith("deepseek-")
    assert entry["masked_key"] == "fixt...xxxx"
    assert "deepseek_api_keys" in saved_config["api_keys"]
    assert len(saved_config["api_keys"]["deepseek_api_keys"]) == 1


def test_delete_provider_key_filters_list():
    """删除 Key 应从列表里移除对应 id."""
    fake_config = {
        "api_keys": {
            "deepseek_api_keys": [
                {"id": "k1", "key": "fixture-1xxxxxxxxxxxx", "label": "a", "enabled": True},
                {"id": "k2", "key": "fixture-2xxxxxxxxxxxx", "label": "b", "enabled": True},
            ]
        }
    }
    saved_config = {}
    with patch.object(p, "_load_raw_config", return_value=fake_config):
        with patch.object(p, "_save_raw_config", side_effect=lambda r: saved_config.update(r)):
            ok = p.delete_provider_key("deepseek", "k1")
    assert ok is True
    remaining = saved_config["api_keys"]["deepseek_api_keys"]
    assert len(remaining) == 1
    assert remaining[0]["id"] == "k2"


def test_delete_primary_key_raises():
    """不能删除主 Key."""
    with pytest.raises(ValueError, match="主 Key"):
        p.delete_provider_key("deepseek", "__primary__")


# ============ custom headers ============

def test_get_provider_custom_headers_empty():
    with patch.object(p, "_load_raw_config", return_value={}):
        h = p.get_provider_custom_headers("deepseek")
    assert h == {}


def test_get_provider_custom_headers_returns_existing():
    fake_config = {
        "models": {
            "deepseek": {
                "model_name": "deepseek-chat",
                "custom_headers": {"X-Custom": "value", "X-Source": "hakusai"},
            }
        }
    }
    with patch.object(p, "_load_raw_config", return_value=fake_config):
        h = p.get_provider_custom_headers("deepseek")
    assert h == {"X-Custom": "value", "X-Source": "hakusai"}


def test_set_provider_custom_headers_writes_config():
    saved_config = {}
    with patch.object(p, "_load_raw_config", return_value={"models": {"deepseek": {"model_name": "x"}}}):
        with patch.object(p, "_save_raw_config", side_effect=lambda r: saved_config.update(r)):
            p.set_provider_custom_headers("deepseek", {"X-Test": "abc"})
    assert saved_config["models"]["deepseek"]["custom_headers"] == {"X-Test": "abc"}


def test_set_provider_custom_headers_empty_clears_field():
    """传空字典应删除 custom_headers 字段."""
    saved_config = {}
    with patch.object(p, "_load_raw_config", return_value={"models": {"deepseek": {"model_name": "x", "custom_headers": {"old": "v"}}}}):
        with patch.object(p, "_save_raw_config", side_effect=lambda r: saved_config.update(r)):
            p.set_provider_custom_headers("deepseek", {})
    assert "custom_headers" not in saved_config["models"]["deepseek"]


def test_set_provider_custom_headers_filters_empty_values():
    """key 或 value 为空的条目应被过滤掉."""
    saved_config = {}
    with patch.object(p, "_load_raw_config", return_value={"models": {"deepseek": {}}}):
        with patch.object(p, "_save_raw_config", side_effect=lambda r: saved_config.update(r)):
            p.set_provider_custom_headers("deepseek", {"": "v", "k": "", "valid": "ok"})
    assert saved_config["models"]["deepseek"]["custom_headers"] == {"valid": "ok"}
