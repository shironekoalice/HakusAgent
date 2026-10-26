"""Silero VAD adapter for voice activity detection"""
import numpy as np
import torch
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class SileroVADAdapter:
    """Silero VAD - deep learning based voice activity detection

    Much more accurate than RMS energy detection, can distinguish
    human speech from keyboard noise, fan noise, etc.
    """

    def __init__(self,
                 threshold: float = 0.5,
                 min_speech_duration: float = 0.25,
                 min_silence_duration: float = 0.1,
                 sample_rate: int = 16000):
        self.threshold = threshold
        self.min_speech_duration = min_speech_duration
        self.min_silence_duration = min_silence_duration
        self.sample_rate = sample_rate

        # Load Silero VAD model
        self.model, self.utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            trust_repo=True
        )
        self._reset_states()

    def _reset_states(self):
        """Reset internal state for new detection session"""
        self.model.reset_states()
        self._speech_frames = 0
        self._silence_frames = 0
        self._is_speaking = False

    def process_chunk(self, audio_chunk: np.ndarray) -> dict:
        """Process a single audio chunk and return VAD result

        Args:
            audio_chunk: numpy array of int16 audio data, 16000Hz, mono

        Returns:
            dict with keys:
                - is_speech: bool - whether speech is detected
                - speech_started: bool - speech just started (rising edge)
                - speech_ended: bool - speech just ended (falling edge)
        """
        # Convert to float32 tensor
        audio_float = audio_chunk.astype(np.float32) / 32768.0
        audio_tensor = torch.from_numpy(audio_float)

        # Get speech probability
        speech_prob = self.model(audio_tensor, self.sample_rate).item()
        is_speech = speech_prob > self.threshold

        result = {
            'is_speech': is_speech,
            'speech_started': False,
            'speech_ended': False
        }

        chunk_duration = len(audio_chunk) / self.sample_rate

        if is_speech:
            self._speech_frames += 1
            self._silence_frames = 0

            # Check if speech just started (after min_speech_duration)
            speech_duration = self._speech_frames * chunk_duration
            if not self._is_speaking and speech_duration >= self.min_speech_duration:
                self._is_speaking = True
                result['speech_started'] = True
        else:
            self._silence_frames += 1
            self._speech_frames = 0

            # Check if speech just ended (after min_silence_duration)
            if self._is_speaking:
                silence_duration = self._silence_frames * chunk_duration
                if silence_duration >= self.min_silence_duration:
                    self._is_speaking = False
                    result['speech_ended'] = True

        return result

    def is_voice(self, audio_data: bytes) -> bool:
        """Simple interface compatible with old VoiceDetector

        Args:
            audio_data: raw bytes of int16 audio data

        Returns:
            True if voice is detected
        """
        audio_array = np.frombuffer(audio_data, dtype=np.int16)
        result = self.process_chunk(audio_array)
        return result['is_speech']

    @property
    def is_speaking(self) -> bool:
        """Current speaking state"""
        return self._is_speaking


class EnergyVADAdapter:
    """Legacy RMS energy VAD - kept as fallback"""

    def __init__(self, energy_threshold: int = 2000, sample_rate: int = 16000):
        self.energy_threshold = energy_threshold
        self.sample_rate = sample_rate
        self._is_speaking = False

    def is_voice(self, audio_data: bytes) -> bool:
        audio_array = np.frombuffer(audio_data, dtype=np.int16).astype(np.float64)
        if len(audio_array) == 0:
            return False
        rms = np.sqrt(np.mean(audio_array ** 2))
        return rms > self.energy_threshold

    def process_chunk(self, audio_chunk: np.ndarray) -> dict:
        is_speech = self.is_voice(audio_chunk.tobytes())
        result = {
            'is_speech': is_speech,
            'speech_started': is_speech and not self._is_speaking,
            'speech_ended': not is_speech and self._is_speaking
        }
        self._is_speaking = is_speech
        return result

    @property
    def is_speaking(self) -> bool:
        return self._is_speaking


def create_vad(config) -> object:
    """Factory function to create VAD based on config

    Args:
        config: VADConfig object with provider field

    Returns:
        SileroVADAdapter or EnergyVADAdapter
    """
    provider = getattr(config, 'provider', 'silero')

    if provider == 'silero':
        try:
            return SileroVADAdapter(
                threshold=getattr(config, 'threshold', 0.5),
                min_speech_duration=getattr(config, 'min_speech_duration', 0.25),
                min_silence_duration=getattr(config, 'min_silence_duration', 0.1),
                sample_rate=16000
            )
        except Exception as e:
            logger.warning(f"Failed to load Silero VAD, falling back to energy VAD: {e}")
            return EnergyVADAdapter(
                energy_threshold=getattr(config, 'energy_threshold', 2000),
                sample_rate=16000
            )
    else:
        return EnergyVADAdapter(
            energy_threshold=getattr(config, 'energy_threshold', 2000),
            sample_rate=16000
        )
