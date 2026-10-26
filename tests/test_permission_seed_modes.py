"""Tests for the five-tier permission engine's config seeding.

The one behaviour under test is the mode a fresh `PermissionEngine` ends up in
for each `permission.mode` value in `~/.hakus/config.yaml` — because that value
decides whether the agent's `bash` prompts a human or runs silently.

The trap this pins: the legacy two-layer stack treated `AUTO` as
"approve everything" (an alias of `BYPASS`, renamed away in
`hakus/permission.py:37-53` because it was unsafe), while the five-tier engine's
own `AUTO` tier means "safe ops free, mutating ops confirm". A mapping that
honoured the *name* rather than the *documented tier semantics* would silently
grant `full_access` to any config that says `auto`.
"""

from __future__ import annotations

import pytest
import yaml

from hakus.permissions.engine import FiveMode, PermissionEngine, seed_from_config


@pytest.fixture()
def hakus_home(tmp_path, monkeypatch):
    """Point the seeding path at a temp home and reset the module singleton.

    `seed_from_config` reads a hard-coded `~/.hakus/config.yaml` and runs once
    per process, so every test needs a fresh `HOME` and a fresh `_seeded` flag.
    """
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    import hakus.permissions.engine as engine_module

    monkeypatch.setattr(engine_module, "_seeded", False)
    engine = PermissionEngine()
    monkeypatch.setattr(engine_module, "_engine", engine)
    return tmp_path


def write_config(home, mode):
    config = home / ".hakus"
    config.mkdir(parents=True, exist_ok=True)
    (config / "config.yaml").write_text(
        yaml.safe_dump({"permission": {"mode": mode}}), encoding="utf-8"
    )


def test_absent_config_leaves_the_safe_default(hakus_home):
    """No config file → the engine's built-in default, which prompts."""
    seed_from_config()
    engine = __import__("hakus.permissions.engine", fromlist=["get_engine"]).get_engine()
    assert engine.mode is FiveMode.AUTO, "no config must leave the default tier"
    # And the default tier must NOT be full access.
    assert engine.mode is not FiveMode.FULL_ACCESS


def test_explicit_ask_maps_to_the_prompting_tier(hakus_home):
    write_config(hakus_home, "ask")
    seed_from_config()
    engine = __import__("hakus.permissions.engine", fromlist=["get_engine"]).get_engine()
    assert engine.mode is FiveMode.AUTO


@pytest.mark.parametrize("legacy", ["bypass", "danger_auto"])
def test_explicit_bypass_variants_map_to_full_access(hakus_home, legacy):
    """The legacy names that *meant* 'approve everything' still do."""
    write_config(hakus_home, legacy)
    seed_from_config()
    engine = __import__("hakus.permissions.engine", fromlist=["get_engine"]).get_engine()
    assert engine.mode is FiveMode.FULL_ACCESS


def test_explicit_auto_maps_to_the_prompting_tier_not_full_access(hakus_home):
    """`auto` must mean the five-tier AUTO tier, which prompts on mutations.

    A previous mapping sent config `auto` to `full_access`. That inverted the
    tier's documented meaning ("safe ops run free, mutating ops require user
    approval") for anyone who wrote `auto` expecting the engine default, and it
    is the one legacy name whose old semantics *disagree* with its new tier:
    `bypass`/`danger_auto` were honest about wanting no prompts, `auto` was not.
    """
    write_config(hakus_home, "auto")
    seed_from_config()
    engine = __import__("hakus.permissions.engine", fromlist=["get_engine"]).get_engine()
    assert engine.mode is FiveMode.AUTO
    assert engine.mode is not FiveMode.FULL_ACCESS


def test_configured_prompting_tier_projects_onto_the_manager(hakus_home):
    """End-to-end: a config `auto` must leave the manager in a prompting mode.

    This is the assertion that actually protects `bash`: `PermissionManager` in
    ASK mode calls the confirm callback (or denies if none is installed), while
    BYPASS-family modes approve everything without asking.
    """
    from hakus.permission import PermissionManager, PermissionMode

    write_config(hakus_home, "auto")
    seed_from_config()
    engine = __import__("hakus.permissions.engine", fromlist=["get_engine"]).get_engine()

    manager = PermissionManager(mode=PermissionMode.ASK)
    engine.apply_to_manager(manager)
    assert manager._mode is not PermissionMode.BYPASS, (
        "a config `auto` must not project onto a bypass-equivalent manager mode"
    )

    # A dangerous tool with no callback installed must be denied, not approved.
    manager._async_confirm_callback = None
    manager._confirm_callback = None
    result = manager.check_tool_execution("bash", is_dangerous=True, args={"command": "echo hi"})
    assert result.allowed is False, (
        "with no human to ask, the fail-safe answer for bash is deny"
    )
