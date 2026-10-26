"""HakusAI built-in voice ASR module.

Uses hakusai_core.voice.asr (FunASR/Sherpa-ONNX/Whisper) for speech recognition.
No external Celia dependency required.
"""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Dict, Optional

from .logging_config import get_logger

logger = get_logger("haku.sidecar.voice")

_lock = threading.Lock()
_asr_engine = None
_asr_provider = None
_asr_language = None


def _get_asr_engine(provider: str | None = None, language: str | None = None):
    """Get or create the built-in ASR engine (singleton).

    Args:
        provider: ASR provider name. Defaults to config or "funasr".
                  Supported: "funasr", "whisper"
        language: ASR language override, e.g. "zh" or "en".
    """
    global _asr_engine, _asr_provider, _asr_language

    with _lock:
        # Determine provider / language
        if provider is None:
            provider = os.environ.get("HAKUSAI_ASR_PROVIDER", "funasr")
        if language is None:
            language = os.environ.get("HAKUSAI_ASR_LANGUAGE", "zh")

        # Return cached engine if params match
        if (
            _asr_engine is not None
            and _asr_provider == provider
            and _asr_language == language
        ):
            return _asr_engine

        _asr_provider = provider
        _asr_language = language

        try:
            from hakusai_core.voice.asr.base import asr_registry

            # Import available engines to trigger registration
            try:
                from hakusai_core.voice.asr.funasr import FunASR  # noqa: F401
            except ImportError:
                pass
            try:
                from hakusai_core.voice.asr.whisper import WhisperASR  # noqa: F401
            except ImportError:
                pass

            available = asr_registry.list_providers()
            logger.info(f"Available ASR providers: {available}")

            # Fall back if requested provider is not available
            if provider not in available:
                logger.warning(f"ASR provider '{provider}' not available, falling back")
                for fallback in ["funasr", "whisper"]:
                    if fallback in available:
                        provider = fallback
                        break
                else:
                    raise RuntimeError(
                        f"No ASR engine available. Install one of: "
                        f"funasr, openai-whisper"
                    )

            # Create engine with default config
            config = {
                "provider": provider,
                "language": language,
                "sample_rate": int(os.environ.get("HAKUSAI_ASR_SAMPLE_RATE", "16000")),
            }

            _asr_engine = asr_registry.create_engine(provider, config)

            # Initialize synchronously (in event loop this would be async)
            loop = asyncio.new_event_loop()
            loop.run_until_complete(_asr_engine.initialize())
            loop.close()

            _asr_provider = provider
            logger.info(f"ASR engine initialized: {provider}")

        except Exception as e:
            logger.error(f"Failed to initialize ASR engine: {e}")
            raise

        return _asr_engine


def transcribe_audio(
    audio_path: str,
    *,
    provider: str | None = None,
    language: str | None = None,
    **kwargs,
) -> str:
    """Transcribe an audio file using HakusAI's built-in ASR.

    Args:
        audio_path: Path to the WAV/MP3 audio file.
        provider: ASR provider override (funasr/whisper).
        language: ASR language override (zh/en/auto).

    Returns:
        Transcribed text (stripped).
    """
    engine = _get_asr_engine(provider, language)

    # Use transcribe_file for file-based input
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(engine.transcribe_file(audio_path))
        return (result.text or "").strip()
    finally:
        loop.close()


def transcribe_audio_async(
    audio_path: str,
    *,
    provider: str | None = None,
    language: str | None = None,
) -> str:
    """Async version of transcribe_audio for use in async handlers."""
    engine = _get_asr_engine(provider, language)
    result = asyncio.get_event_loop().run_until_complete(engine.transcribe_file(audio_path))
    return (result.text or "").strip()


def transcribe_audio_celia(
    audio_path: str,
    *,
    celia_path: str | None = None,
    config_path: str | None = None,
) -> str:
    """Report that Celia is unavailable until the reviewed extension is installed.

    This compatibility symbol intentionally keeps its old call shape so a
    legacy sidecar can fail closed. It must not import Celia modules, mutate
    ``sys.path``, or interpret a caller supplied filesystem path as an
    executable extension. The desktop host owns the eventual
    ``voice.celia`` activation through ``hakus.extension.v1``.
    """
    del audio_path, celia_path, config_path
    raise RuntimeError(
        "Celia voice is unavailable; install and trust the reviewed voice.celia extension"
    )
