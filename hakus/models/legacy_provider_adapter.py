"""Explicit provider binding for the Python compatibility plane.

The Rust Runtime is the canonical provider execution plane.  This module is
the narrow adapter kept for legacy ``AgentCore`` callers while the migration
is in progress.  It owns route binding and diagnostics so compatibility
callers do not each invent their own fallback or error handling.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from .base_client import BaseLLMClient


_MAX_DIAGNOSTIC_TEXT = 256
_SECRET_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)(\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+"),
    re.compile(r"\$\{ENV:[^}]+\}"),
)


def redact_provider_diagnostic(value: Any) -> str:
    """Return bounded, credential-safe text for compatibility diagnostics."""

    text = str(value or "")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda match: f"{match.group(1)}<redacted>" if match.lastindex else "<redacted>", text)
    text = re.sub(r"(?i)(https?://[^\s?]+)\?[^\s]+", r"\1?<redacted>", text)
    text = re.sub(
        r"(?i)(\b(?:path|file|filename)\s*[=:]\s*)(?:[A-Za-z]:\\|/)[^\s,;]+",
        r"\1<redacted>",
        text,
    )
    text = " ".join(text.split())
    if len(text) > _MAX_DIAGNOSTIC_TEXT:
        text = text[: _MAX_DIAGNOSTIC_TEXT - 3] + "..."
    return text


@dataclass(frozen=True)
class LegacyProviderStatus:
    """Safe state projection for one compatibility provider binding."""

    requested_provider: str
    bound_provider: Optional[str]
    state: str
    fallback_policy: str
    canonical_plane: str = "rust_runtime"
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "requested_provider": self.requested_provider,
            "bound_provider": self.bound_provider,
            "state": self.state,
            "fallback_policy": self.fallback_policy,
            "canonical_plane": self.canonical_plane,
        }
        if self.error:
            payload["error"] = redact_provider_diagnostic(self.error)
        return payload


class LegacyProviderRouteError(RuntimeError):
    """Raised when a compatibility client does not honor its selected route."""


class LegacyProviderAdapter:
    """Bind one legacy provider without silently changing the selected route.

    ``allow_fallback`` remains available for the historical CLI path.  The
    sidecar passes ``False`` and therefore gets a strict provider binding.
    ``factory`` is injectable so AgentCore and contract tests can observe the
    boundary without importing provider SDKs.
    """

    def __init__(
        self,
        provider: Any,
        *,
        allow_fallback: bool = False,
        factory: Optional[Callable[..., BaseLLMClient]] = None,
    ) -> None:
        normalized = str(getattr(provider, "value", provider) or "").strip().lower()
        if not normalized:
            raise ValueError("provider is required")
        self.requested_provider = normalized
        self.allow_fallback = bool(allow_fallback)
        self._factory = factory
        self._client: Optional[BaseLLMClient] = None
        self._status = LegacyProviderStatus(
            requested_provider=normalized,
            bound_provider=None,
            state="uninitialized",
            fallback_policy="enabled" if self.allow_fallback else "disabled",
        )

    @property
    def client(self) -> Optional[BaseLLMClient]:
        return self._client

    @property
    def status(self) -> LegacyProviderStatus:
        return self._status

    def bind(self) -> BaseLLMClient:
        """Create and validate the selected provider client exactly once."""

        if self._factory is None:
            from . import client_factory

            factory = client_factory.create_client_from_config
        else:
            factory = self._factory

        return self._bind_client(
            lambda: factory(
                self.requested_provider,
                allow_fallback=self.allow_fallback,
            )
        )

    def bind_preconfigured(
        self,
        factory: Callable[[], BaseLLMClient],
    ) -> BaseLLMClient:
        """Bind a client that already has an explicit Runtime-style config.

        Optional compatibility features such as Guardian may need a distinct
        model name/base URL and therefore cannot use the historical factory.
        They still pass through this route check instead of constructing a
        provider client outside the compatibility boundary.
        """

        return self._bind_client(factory)

    def _bind_client(self, factory: Callable[[], BaseLLMClient]) -> BaseLLMClient:
        if self._client is not None:
            return self._client

        try:
            client = factory()
            bound_provider = _provider_name(getattr(client, "provider", None))
            if not self.allow_fallback and bound_provider != self.requested_provider:
                raise LegacyProviderRouteError(
                    f"provider route changed from '{self.requested_provider}' "
                    f"to '{bound_provider or 'unknown'}'"
                )
        except Exception as exc:
            self._status = LegacyProviderStatus(
                requested_provider=self.requested_provider,
                bound_provider=None,
                state="unavailable" if isinstance(exc, (ValueError, ImportError, RuntimeError)) else "error",
                fallback_policy="enabled" if self.allow_fallback else "disabled",
                error=redact_provider_diagnostic(exc),
            )
            raise

        self._client = client
        self._status = LegacyProviderStatus(
            requested_provider=self.requested_provider,
            bound_provider=bound_provider or self.requested_provider,
            state="bound",
            fallback_policy="enabled" if self.allow_fallback else "disabled",
        )
        return client


def _provider_name(provider: Any) -> Optional[str]:
    if provider is None:
        return None
    value = getattr(provider, "value", provider)
    return str(value).strip().lower() or None


__all__ = [
    "LegacyProviderAdapter",
    "LegacyProviderRouteError",
    "LegacyProviderStatus",
    "redact_provider_diagnostic",
]
