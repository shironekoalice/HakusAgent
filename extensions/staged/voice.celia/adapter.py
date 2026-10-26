"""Runtime bridge for the staged Celia voice implementation.

The bundle contains Celia's runtime code, while its model and device inputs
stay outside the bundle. The reviewed host forwards only the HAKUS_* runtime
settings listed in the extension host; no arbitrary executable or config path
crosses the protocol.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any


PROTOCOL = "hakus.extension.v1"
EXTENSION_ID = "voice.celia"
PROTOCOL_STREAM = sys.stdout


class _SilentStdout:
    def write(self, _value: str) -> int:
        return 0

    def flush(self) -> None:
        return


# Third-party ASR libraries print startup notices to stdout. The extension
# wire is newline-delimited JSON, so those notices must never share it.
sys.stdout = _SilentStdout()


class VoiceRuntime:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.engine: Any = None
        self.recorder: Any = None
        self.state = "stopped"
        self.error: str | None = None
        self.last_transcript = ""

    def model_path(self) -> Path | None:
        candidates = []
        for key in ("HAKUS_CELIA_ASR_MODEL", "HAKUS_CELIA_MODEL_DIR"):
            value = os.environ.get(key, "").strip()
            if value:
                candidates.append(Path(value).expanduser())
        root = os.environ.get("HAKUS_CELIA_ROOT", "").strip()
        if root:
            candidates.append(Path(root).expanduser() / "models" / "asr" / "fun_asr")
        for candidate in candidates:
            if candidate.is_dir():
                return candidate
        return None

    @staticmethod
    def microphone_available() -> bool:
        try:
            import pyaudio

            audio = pyaudio.PyAudio()
            try:
                return any(
                    info.get("maxInputChannels", 0) > 0
                    for info in (
                        audio.get_device_info_by_index(index)
                        for index in range(audio.get_device_count())
                    )
                )
            finally:
                audio.terminate()
        except Exception:
            return False

    def health(self) -> dict[str, Any]:
        with self.lock:
            return {
                "state": self.state,
                "runtime_ready": self.state == "ready",
                "model_configured": self.model_path() is not None,
                "model_ready": self.engine is not None,
                "microphone_available": self.microphone_available(),
                "last_transcript_available": bool(self.last_transcript),
                **({"reason": self.error} if self.error else {}),
            }

    def _on_speech(self, segment: Any) -> None:
        """Keep the real Celia ASR path useful without requiring its Agent tree."""
        try:
            text = self.engine.transcribe(segment.audio_path)
            with self.lock:
                self.last_transcript = text.strip()
        except Exception as error:
            with self.lock:
                self.error = f"ASR transcription failed: {type(error).__name__}"

    def start(self, *, capture_microphone: bool = True) -> tuple[bool, dict[str, Any]]:
        with self.lock:
            if self.state == "ready" and (not capture_microphone or self.recorder is not None):
                return True, self.health()
            model_path = self.model_path()
            if model_path is None:
                self.state = "unavailable"
                self.error = "set HAKUS_CELIA_ASR_MODEL or HAKUS_CELIA_ROOT to a local ASR model"
                return False, self.health()
            self.state = "starting"
            self.error = None

        try:
            from source.celia_live.config import Config
            from source.celia_live.core import ASREngine, AudioRecorder

            config = Config()
            config.asr.model_path = str(model_path)
            engine = ASREngine(config)
            # Celia/FunASR writes diagnostic logs to stdout; keep stdout a
            # protocol-only channel for the Runtime host.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                original_cwd = os.getcwd()
                # The checked-in Celia model config uses repository-relative
                # tokenizer/custom-code paths. Resolve those paths from the
                # external Celia root while the model is constructed.
                celia_root = os.environ.get("HAKUS_CELIA_ROOT", "").strip()
                load_cwd = Path(celia_root).expanduser() if celia_root else model_path.parents[2]
                try:
                    os.chdir(load_cwd)
                    self._patch_sentencepiece_windows_path()
                    engine.init()
                finally:
                    os.chdir(original_cwd)
                recorder = None
                if capture_microphone:
                    recorder = AudioRecorder(config, self._on_speech)
                    recorder.start()
            with self.lock:
                self.engine = engine
                self.recorder = recorder
                self.state = "ready"
            return True, self.health()
        except Exception as error:
            with self.lock:
                self.state = "unavailable"
                self.error = f"Celia runtime failed to start: {type(error).__name__}"
            return False, self.health()

    @staticmethod
    def _patch_sentencepiece_windows_path() -> None:
        """Load a Unicode Windows model path through SentencePiece bytes."""
        try:
            import sentencepiece as spm
        except ImportError:
            return
        if getattr(spm.SentencePieceProcessor.load, "_hakus_unicode_safe", False):
            return
        original = spm.SentencePieceProcessor.load

        def load(self: Any, model_file: str) -> Any:
            try:
                return original(self, model_file)
            except OSError:
                return self.LoadFromSerializedProto(Path(model_file).read_bytes())

        load._hakus_unicode_safe = True
        spm.SentencePieceProcessor.load = load

    def transcribe_samples(self, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        samples = payload.get("audio_samples")
        if not isinstance(samples, list) or not samples:
            return False, {"state": "rejected", "reason": "audio_samples must be a non-empty list"}
        if len(samples) > 2_000_000 or any(not isinstance(value, int) for value in samples):
            return False, {"state": "rejected", "reason": "audio_samples is invalid"}
        if self.engine is None:
            ok, _ = self.start(capture_microphone=False)
            if not ok:
                return False, self.health()
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output:
                path = Path(output.name)
            try:
                with wave.open(str(path), "wb") as wav_file:
                    wav_file.setnchannels(1)
                    wav_file.setsampwidth(2)
                    wav_file.setframerate(int(payload.get("sample_rate", 16000)))
                    wav_file.writeframes(b"".join(int(value).to_bytes(2, "little", signed=True) for value in samples))
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    text = self.engine.transcribe(str(path)).strip()
            finally:
                path.unlink(missing_ok=True)
            with self.lock:
                self.last_transcript = text
            return True, {"state": "ready", "text": text, "model": "Celia/FunASR"}
        except Exception as error:
            return False, {"state": "unavailable", "reason": f"ASR transcription failed: {type(error).__name__}"}

    def stop(self) -> None:
        with self.lock:
            recorder = self.recorder
            self.recorder = None
            self.state = "stopped"
        if recorder is not None:
            try:
                recorder.stop()
            except Exception:
                pass
        self.stop_event.set()


runtime = VoiceRuntime()


def response(request: dict[str, Any], *, ok: bool, event_type: str, payload: dict[str, Any]) -> None:
    output = {
        "protocol": PROTOCOL,
        "request_id": request.get("request_id", ""),
        "extension_id": EXTENSION_ID,
        "event_type": event_type,
        "ok": ok,
        "payload": payload,
    }
    PROTOCOL_STREAM.write(json.dumps(output, separators=(",", ":")) + "\n")
    PROTOCOL_STREAM.flush()


def main() -> int:
    keep_alive = False
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            return 2
        if not isinstance(request, dict):
            return 2
        if (
            request.get("protocol") != PROTOCOL
            or request.get("extension_id") != EXTENSION_ID
            or not isinstance(request.get("request_id"), str)
        ):
            return 3

        event_type = request.get("event_type")
        payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
        if event_type == "extension.ping":
            response(request, ok=True, event_type=event_type, payload={"state": "ready", "source": "Celia/celia_live", "asr": "FunASR/SenseVoiceSmall"})
        elif event_type == "voice.health":
            response(request, ok=True, event_type=event_type, payload=runtime.health())
        elif event_type == "voice.start":
            ok, result = runtime.start()
            response(request, ok=ok, event_type=event_type, payload=result)
            keep_alive = ok
        elif event_type == "voice.transcribe":
            ok, result = runtime.transcribe_samples(payload)
            response(request, ok=ok, event_type=event_type, payload=result)
        elif event_type == "extension.stop":
            runtime.stop()
            response(request, ok=True, event_type=event_type, payload={"state": "stopped"})
            return 0
        elif event_type == "extension.crash":
            os._exit(17)
        else:
            response(request, ok=False, event_type=str(event_type or "unknown"), payload={"state": "rejected", "reason": "unsupported event"})
    if keep_alive:
        runtime.stop_event.wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
