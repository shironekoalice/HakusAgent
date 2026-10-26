"""Compatibility facade for the optional voice extension plane.

The Rust Runtime owns extension activation and process policy. The legacy
Python AgentCore must not import audio engines, spawn workers, or accept a
developer supplied Celia path, so this facade preserves the historical API
while returning an explicit unavailable/no-op result.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

from utils.logger import get_logger

logger = get_logger(__name__)

__all__ = ["VoiceBridge", "PYAUDIO_AVAILABLE"]

PYAUDIO_AVAILABLE = False


class VoiceBridge:
    """Unavailable compatibility adapter until ``voice.celia`` is installed."""

    unavailable_reason = (
        "voice extension unavailable; install and trust the reviewed voice.celia extension"
    )

    def __init__(self, agent: Any = None, config: Optional[Any] = None):
        self.agent = agent
        self.config = config
        self._running = False
        self._speaking = False
        self._processing = False

    def init(self, enable_asr: bool = True) -> None:
        del enable_asr
        logger.warning(self.unavailable_reason)

    def init_text_mode(self) -> None:
        logger.warning(self.unavailable_reason)

    def start_voice(self) -> bool:
        logger.warning(self.unavailable_reason)
        return False

    def stop_voice(self) -> None:
        self._running = False
        self._speaking = False
        self._processing = False

    async def process_text_with_voice(self, text: str) -> Tuple[str, Optional[str]]:
        del text
        logger.warning(self.unavailable_reason)
        return "", None

    @property
    def is_voice_active(self) -> bool:
        return False

    @property
    def is_listening(self) -> bool:
        return False
