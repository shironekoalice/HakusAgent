"""Five-tier permission engine with configurable permission profiles.

The five tiers combine ``sandbox_mode`` + ``approval_policy``
+ ``approver``:

  - ``read_only``  — all mutating tools hard-denied (no prompt)
  - ``auto``       — safe ops run free, mutating ops require user approval
  - ``granular``   — like auto, plus fine-grained rules that can
                     auto-approve subsets of mutating ops (shell level,
                     write-path globs, network) without prompting
  - ``guardian``   — like auto, but high-risk ops escalate to the
                     Guardian reviewer (LLM-approver) before the user
  - ``full_access``— everything allowed (BYPASS semantics)

The engine is the *coordination* layer: it owns the current five-tier
mode + granular rules and projects them onto the legacy two-layer stack
(:class:`hakus.permission.PermissionManager` + its strict
:class:`hakus.permissions.checker.PermissionChecker`). Legacy callers
(ASK/BYPASS) keep working unchanged.
"""
from __future__ import annotations

import fnmatch
import logging
import re
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class FiveMode(str, Enum):
    READ_ONLY = "read_only"
    AUTO = "auto"
    GRANULAR = "granular"
    GUARDIAN = "guardian"
    FULL_ACCESS = "full_access"


# Codex-style profile: what each tier means at the policy level.
PROFILES: Dict[str, Dict[str, str]] = {
    FiveMode.READ_ONLY.value: {
        "sandbox_mode": "read-only",
        "approval_policy": "never",
        "approver": "none",
    },
    FiveMode.AUTO.value: {
        "sandbox_mode": "workspace-write",
        "approval_policy": "on-request",
        "approver": "user",
    },
    FiveMode.GRANULAR.value: {
        "sandbox_mode": "workspace-write",
        "approval_policy": "granular",
        "approver": "user",
    },
    FiveMode.GUARDIAN.value: {
        "sandbox_mode": "workspace-write",
        "approval_policy": "guardian-approvals",
        "approver": "guardian",
    },
    FiveMode.FULL_ACCESS.value: {
        "sandbox_mode": "danger-full-access",
        "approval_policy": "never",
        "approver": "none",
    },
}

_VALID_SHELL_LEVELS = ("none", "read_only", "all")

_SHELL_READ_ONLY_RE = re.compile(
    r"^(ls|dir|cat|head|tail|pwd|whoami|date|which|where|echo|printf|"
    r"git\s+(status|log|diff|branch|remote|show)|"
    r"wc|sort|uniq|grep|find|du|df|free|top|ps|type)\b",
    re.IGNORECASE,
)

# Tools that hit the network (used by granular network rule)
_NETWORK_TOOLS = frozenset({
    "web_search", "web_fetch", "web_post", "web_put", "web_delete",
    "fetch_url", "http_request",
})


@dataclass
class GranularRules:
    """Fine-grained auto-approval rules for the ``granular`` tier.

    Anything covered by these rules runs WITHOUT prompting; anything
    outside them falls back to the ``auto`` behavior (confirm).
    """

    shell: str = "none"            # none | read_only | all
    write_paths: List[str] = field(default_factory=list)  # glob allowlist
    network: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "shell": self.shell,
            "write_paths": list(self.write_paths),
            "network": self.network,
        }

    @classmethod
    def from_dict(cls, raw: Optional[Dict[str, Any]]) -> "GranularRules":
        if not raw:
            return cls()
        shell = raw.get("shell", "none")
        if shell not in _VALID_SHELL_LEVELS:
            shell = "none"
        paths = [str(p) for p in (raw.get("write_paths") or [])]
        return cls(shell=shell, write_paths=paths, network=bool(raw.get("network")))

    def allows_shell(self, command: str) -> bool:
        if self.shell == "all":
            return True
        if self.shell == "read_only":
            return bool(_SHELL_READ_ONLY_RE.match(command.strip()))
        return False

    def allows_write_path(self, path: str) -> bool:
        if not path:
            return False
        norm = path.replace("\\", "/")
        for pattern in self.write_paths:
            pat = pattern.replace("\\", "/")
            if fnmatch.fnmatch(norm, pat) or fnmatch.fnmatch(norm, pat.rstrip("/") + "/*"):
                return True
        return False

    def allows_network(self, tool_name: str) -> bool:
        return self.network and tool_name in _NETWORK_TOOLS


class PermissionEngine:
    """Owns the five-tier mode and projects it onto PermissionManagers."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._mode = FiveMode.AUTO
        self._rules = GranularRules()

    # ── state ──────────────────────────────────────────────────────────

    def current(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "mode": self._mode.value,
                "granular_rules": self._rules.to_dict(),
                "profile": PROFILES[self._mode.value],
            }

    @property
    def mode(self) -> FiveMode:
        return self._mode

    @property
    def rules(self) -> GranularRules:
        return self._rules

    def set_mode(
        self,
        mode: str | FiveMode,
        rules: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if isinstance(mode, str):
            try:
                mode = FiveMode(mode)
            except ValueError:
                raise ValueError(
                    f"mode must be one of {[m.value for m in FiveMode]}, got {mode!r}"
                )
        with self._lock:
            self._mode = mode
            if rules is not None:
                self._rules = GranularRules.from_dict(rules)
            return self.current()

    # ── projection onto the legacy PermissionManager ───────────────────

    def apply_to_manager(self, manager: Any) -> None:
        """Sync the current five-tier mode onto a PermissionManager.

        Mapping (legacy PermissionMode in hakus/permission.py):
          READ_ONLY  → PermissionMode.READ_ONLY  (new: hard-deny mutating)
          AUTO       → PermissionMode.ASK        (confirm via callback)
          GRANULAR   → PermissionMode.GRANULAR   (new: rules first, then confirm)
          GUARDIAN   → PermissionMode.ASK        (approver distinction lives in
                                                 the approval layer, P2)
          FULL_ACCESS→ PermissionMode.BYPASS
        """
        from hakus.permission import PermissionMode

        mapping = {
            FiveMode.READ_ONLY: PermissionMode.READ_ONLY,
            FiveMode.AUTO: PermissionMode.ASK,
            FiveMode.GRANULAR: PermissionMode.GRANULAR,
            FiveMode.GUARDIAN: PermissionMode.ASK,
            FiveMode.FULL_ACCESS: PermissionMode.BYPASS,
        }
        try:
            manager.mode = mapping[self._mode]
            if hasattr(manager, "set_granular_rules"):
                manager.set_granular_rules(self._rules)
        except Exception as e:
            logger.warning(f"apply_to_manager failed: {e}")


# Module-level singleton — server.py and agent_bridge share this instance
_engine: Optional[PermissionEngine] = None
_engine_lock = threading.Lock()


def get_engine() -> PermissionEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = PermissionEngine()
        return _engine


_seeded = False


def seed_from_config() -> None:
    """Seed the engine from ``~/.hakus/config.yaml`` (once per process).

    Legacy config modes map into the five tiers:
      ``ask`` → auto, ``bypass`` / ``danger_auto`` → full_access.

    ``auto`` maps to ``auto`` (the five-tier tier, which prompts on mutating
    ops). It previously mapped to ``full_access``, which granted silence where
    the legacy name only ever meant "unsafe auto-approve" in a stack that was
    renamed away from that behaviour precisely because it was unsafe
    (``hakus/permission.py``: ``AUTO`` is a deprecated alias of ``DANGER_AUTO``,
    and the default was changed to ``ASK``). A user writing ``auto`` to mean the
    engine's documented default tier got the opposite: every mutating call ran
    without a prompt. If a config genuinely wants no prompts, ``bypass`` names
    that honestly.
    """
    global _seeded
    if _seeded:
        return
    _seeded = True
    try:
        import os
        import yaml
        path = os.path.expanduser("~/.hakus/config.yaml")
        if not os.path.exists(path):
            return
        with open(path, encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        perm = raw.get("permission") or {}
        mode = perm.get("mode", "auto")
        mode = {"ask": "auto", "bypass": "full_access",
                "danger_auto": "full_access"}.get(mode, mode)
        valid = {m.value for m in FiveMode}
        if mode in valid:
            get_engine().set_mode(mode, rules=perm.get("granular_rules"))
            logger.info(f"permission engine seeded from config: mode={mode}")
    except Exception as e:
        logger.warning(f"seed_from_config failed (non-blocking): {e}")


def classify_granular(
    tool_name: str,
    *,
    is_dangerous: bool,
    args: Dict[str, Any],
    rules: GranularRules,
) -> Optional[bool]:
    """Granular-tier rule evaluation.

    Returns:
        True  — rule auto-approves this call
        False — rule explicitly prompts (fall back to confirm flow)
        None  — no granular rule applies (fall back to default behavior)
    """
    command = str(args.get("command") or "")
    path = str(args.get("path") or args.get("cwd") or "")
    if command:
        if rules.allows_shell(command):
            return True
    if path and tool_name in (
        "write_file", "edit_file", "create_file", "delete_file",
        "remove_file", "create_directory",
    ):
        if rules.allows_write_path(path):
            return True
    if rules.allows_network(tool_name):
        return True
    return None
