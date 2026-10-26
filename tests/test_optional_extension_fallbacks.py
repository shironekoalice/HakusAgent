"""Regression checks for optional feature planes when reviewed bundles are absent."""

import asyncio


def test_voice_bridge_is_a_safe_noop_until_celia_is_installed():
    from hakus.voice_bridge import PYAUDIO_AVAILABLE, VoiceBridge

    bridge = VoiceBridge(config={"celia_path": r"C:\private\celia"})

    assert PYAUDIO_AVAILABLE is False
    bridge.init()
    bridge.init_text_mode()
    assert bridge.start_voice() is False
    assert asyncio.run(bridge.process_text_with_voice("hello")) == ("", None)
    assert bridge.is_voice_active is False
    assert bridge.is_listening is False


def test_celia_transcription_symbol_fails_closed_without_using_paths():
    from src.hakusai_server.celia_voice import transcribe_audio_celia

    try:
        transcribe_audio_celia(
            r"C:\private\audio.wav",
            celia_path=r"C:\private\celia",
            config_path=r"C:\private\config.yaml",
        )
    except RuntimeError as error:
        assert "voice.celia" in str(error)
    else:  # pragma: no cover - the assertion documents the fail-closed contract
        raise AssertionError("Celia must remain unavailable without a reviewed bundle")


class _FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.messages = []
        self.closed = None

    async def accept(self):
        self.accepted = True

    async def send_json(self, payload):
        self.messages.append(payload)

    async def close(self, code=None, reason=None):
        self.closed = (code, reason)


def test_vtuber_websocket_reports_unavailable_without_loading_optional_runtime():
    from src.hakusai_server.vtuber_websocket import VTuberWebSocketHandler

    handler = VTuberWebSocketHandler()
    websocket = _FakeWebSocket()

    asyncio.run(handler.initialize())
    asyncio.run(handler.handle_connection(websocket, session_id="fallback"))

    assert websocket.accepted is True
    assert websocket.messages == [
        {
            "action": "error",
            "code": "extension_unavailable",
            "extension_id": "avatar.vtuber",
            "message": "VTuber/Live2D is unavailable until its reviewed extension is installed",
        }
    ]
    assert websocket.closed == (1013, "extension unavailable")
    assert handler.sessions == {}

