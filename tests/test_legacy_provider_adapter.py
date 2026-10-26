"""Contract checks for the Python provider compatibility boundary."""

import pytest
from types import SimpleNamespace


def test_adapter_binds_selected_provider_and_reports_safe_status():
    from hakus.models.legacy_provider_adapter import LegacyProviderAdapter

    client = SimpleNamespace(provider=SimpleNamespace(value="deepseek"), model_name="test")
    calls = []

    def factory(provider, *, allow_fallback):
        calls.append((provider, allow_fallback))
        return client

    adapter = LegacyProviderAdapter("DeepSeek", factory=factory)

    assert adapter.bind() is client
    assert adapter.bind() is client
    assert calls == [("deepseek", False)]
    assert adapter.status.to_dict() == {
        "requested_provider": "deepseek",
        "bound_provider": "deepseek",
        "state": "bound",
        "fallback_policy": "disabled",
        "canonical_plane": "rust_runtime",
    }


def test_strict_adapter_rejects_a_factory_route_change():
    from hakus.models.legacy_provider_adapter import (
        LegacyProviderAdapter,
        LegacyProviderRouteError,
    )

    def factory(provider, *, allow_fallback):
        return SimpleNamespace(provider=SimpleNamespace(value="qwen"))

    adapter = LegacyProviderAdapter("deepseek", factory=factory)

    with pytest.raises(LegacyProviderRouteError, match="route changed"):
        adapter.bind()

    status = adapter.status.to_dict()
    assert status["state"] == "unavailable"
    assert status["bound_provider"] is None


def test_preconfigured_client_still_uses_strict_route_validation():
    from hakus.models.legacy_provider_adapter import LegacyProviderAdapter

    client = SimpleNamespace(provider=SimpleNamespace(value="opencode"))
    adapter = LegacyProviderAdapter("opencode")

    assert adapter.bind_preconfigured(lambda: client) is client
    assert adapter.status.state == "bound"
    assert adapter.status.bound_provider == "opencode"


def test_adapter_failure_status_redacts_credentials_and_paths():
    from hakus.models.legacy_provider_adapter import LegacyProviderAdapter

    def factory(provider, *, allow_fallback):
        raise RuntimeError(
            "connect failed api_key=sk-secret "
            "https://provider.invalid/v1?token=secret path=C:\\Users\\alice\\config.yaml"
        )

    adapter = LegacyProviderAdapter("deepseek", factory=factory)

    with pytest.raises(RuntimeError):
        adapter.bind()

    error = adapter.status.to_dict()["error"]
    assert "sk-secret" not in error
    assert "token=secret" not in error
    assert "https://provider.invalid/v1?" in error
    assert "C:\\Users\\alice" not in error


def test_compatibility_provider_failure_does_not_fallback(monkeypatch):
    from hakus.models import client_factory

    calls = []

    def fail_for_selected(provider):
        calls.append(provider)
        raise ValueError("selected provider is unavailable")

    monkeypatch.setattr(client_factory, "create_client", fail_for_selected)
    monkeypatch.setattr(
        client_factory,
        "_FALLBACK_ORDER",
        [client_factory.LLMProvider.DEEPSEEK],
    )

    with pytest.raises(ValueError, match="selected provider is unavailable"):
        client_factory.create_client_from_config("legacy-provider", allow_fallback=False)

    assert calls == ["legacy-provider"]


def test_cli_provider_factory_keeps_legacy_fallback_opt_in_by_default(monkeypatch):
    from hakus.models import client_factory

    fallback = object()
    calls = []

    def select_fallback(provider):
        calls.append(provider)
        if provider == "legacy-provider":
            raise ValueError("selected provider is unavailable")
        return fallback

    monkeypatch.setattr(client_factory, "create_client", select_fallback)
    monkeypatch.setattr(
        client_factory,
        "_FALLBACK_ORDER",
        [client_factory.LLMProvider.DEEPSEEK],
    )

    assert client_factory.create_client_from_config("legacy-provider") is fallback
    assert calls == ["legacy-provider", client_factory.LLMProvider.DEEPSEEK]


def test_factory_warning_redacts_provider_credentials(monkeypatch, caplog):
    from hakus.models import client_factory

    def fail_for_selected(provider):
        raise ValueError("provider rejected api_key=sk-factory-secret")

    monkeypatch.setattr(client_factory, "create_client", fail_for_selected)
    monkeypatch.setattr(client_factory, "_FALLBACK_ORDER", [])

    with pytest.raises(RuntimeError, match="All LLM client initializations failed"):
        client_factory.create_client_from_config("legacy-provider")

    assert "sk-factory-secret" not in caplog.text
    assert "api_key=<redacted>" in caplog.text


def test_agentcore_passes_strict_route_policy_to_factory(monkeypatch):
    from hakus import agent

    calls = []

    def fail_selected(model_type, *, allow_fallback):
        calls.append((model_type, allow_fallback))
        raise ValueError("selected provider is unavailable")

    monkeypatch.setattr(agent, "create_client_from_config", fail_selected)
    instance = agent.AgentCore.__new__(agent.AgentCore)
    instance._model_type = "legacy-provider"
    instance._allow_provider_fallback = False

    with pytest.raises(RuntimeError, match="All LLM client initializations failed"):
        instance._init_model()

    assert calls == [("legacy-provider", False)]
