"""Dual audio output - speaker + virtual cable for OBS streaming"""
import os
import threading
import time
import wave
import logging
from typing import Optional, Callable
from queue import Queue, Empty

logger = logging.getLogger(__name__)

try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False


class DualAudioPlayer:
    """同时播放音频到默认扬声器和虚拟音频电缆（VB-Cable）

    用于 OBS 推流场景：
    - 默认扬声器：本地监听
    - 虚拟音频电缆：OBS 捕获作为音频源，推流到 Bilibili 直播间
    """

    def __init__(self, virtual_cable: bool = False, cable_device: str = "", speaker_device: str = ""):
        self.virtual_cable = virtual_cable
        self.cable_device = cable_device
        self.speaker_device = speaker_device
        self._pyaudio = None
        self._speaker_stream = None
        self._cable_stream = None
        self._playing = False
        self._interrupt = threading.Event()
        self._play_thread = None
        self._cable_device_index = None
        self._speaker_device_index = None

    def init(self):
        """初始化 PyAudio 并查找设备索引"""
        if not PYAUDIO_AVAILABLE:
            logger.warning("PyAudio 未安装，双音频输出不可用")
            return False

        try:
            self._pyaudio = pyaudio.PyAudio()

            if self.virtual_cable:
                self._find_devices()
                if self._cable_device_index is None:
                    logger.warning(f"未找到虚拟音频电缆设备 '{self.cable_device}'，将仅输出到默认扬声器")
                    self.virtual_cable = False

            logger.info(f"双音频播放器初始化完成（虚拟电缆: {self.virtual_cable}）")
            return True
        except Exception as e:
            logger.error(f"双音频播放器初始化失败: {e}")
            return False

    def _find_devices(self):
        """查找扬声器和虚拟电缆的设备索引"""
        device_count = self._pyaudio.get_device_count()

        for i in range(device_count):
            try:
                info = self._pyaudio.get_device_info_by_index(i)
                name = info.get('name', '')
                max_output = info.get('maxOutputChannels', 0)

                if max_output == 0:
                    continue

                # 查找虚拟音频电缆
                if self.cable_device and self.cable_device.lower() in name.lower():
                    self._cable_device_index = i
                    logger.info(f"找到虚拟音频电缆: [{i}] {name}")

                # 查找指定扬声器设备
                if self.speaker_device and self.speaker_device.lower() in name.lower():
                    self._speaker_device_index = i
                    logger.info(f"找到扬声器设备: [{i}] {name}")

            except Exception:
                continue

    def play_async(self, audio_path: str, on_done: Optional[Callable] = None):
        """异步播放音频文件到扬声器和虚拟电缆"""
        self.stop()
        self._interrupt.clear()
        self._playing = True

        def _play():
            try:
                # 读取音频文件
                with wave.open(audio_path, 'rb') as wf:
                    channels = wf.getnchannels()
                    sample_width = wf.getsampwidth()
                    sample_rate = wf.getframerate()
                    frames = wf.readframes(wf.getnframes())

                # 打开扬声器输出流
                speaker_kwargs = {
                    'format': pyaudio.paInt16,
                    'channels': channels,
                    'rate': sample_rate,
                    'output': True,
                }
                if self._speaker_device_index is not None:
                    speaker_kwargs['output_device_index'] = self._speaker_device_index

                self._speaker_stream = self._pyaudio.open(**speaker_kwargs)

                # 打开虚拟电缆输出流（如果启用）
                cable_stream = None
                if self.virtual_cable and self._cable_device_index is not None:
                    cable_stream = self._pyaudio.open(
                        format=pyaudio.paInt16,
                        channels=channels,
                        rate=sample_rate,
                        output=True,
                        output_device_index=self._cable_device_index
                    )
                    self._cable_stream = cable_stream

                # 分块播放（避免大文件一次性加载）
                chunk_size = 1024
                offset = 0
                while offset < len(frames) and not self._interrupt.is_set():
                    chunk = frames[offset:offset + chunk_size * sample_width * channels]
                    if not chunk:
                        break

                    try:
                        self._speaker_stream.write(chunk)
                    except Exception:
                        pass

                    if cable_stream:
                        try:
                            cable_stream.write(chunk)
                        except Exception:
                            pass

                    offset += chunk_size * sample_width * channels

            except Exception as e:
                logger.error(f"双音频播放失败: {e}")
            finally:
                self._cleanup_streams()
                self._playing = False
                if on_done:
                    on_done()

        self._play_thread = threading.Thread(target=_play, daemon=True)
        self._play_thread.start()

    def _cleanup_streams(self):
        """清理音频流"""
        if self._speaker_stream:
            try:
                self._speaker_stream.stop_stream()
                self._speaker_stream.close()
            except Exception:
                pass
            self._speaker_stream = None

        if self._cable_stream:
            try:
                self._cable_stream.stop_stream()
                self._cable_stream.close()
            except Exception:
                pass
            self._cable_stream = None

    def stop(self):
        """停止播放"""
        self._interrupt.set()
        if self._play_thread and self._play_thread.is_alive():
            self._play_thread.join(timeout=1.0)
        self._cleanup_streams()
        self._playing = False

    @property
    def is_playing(self):
        return self._playing

    def destroy(self):
        """销毁播放器"""
        self.stop()
        if self._pyaudio:
            try:
                self._pyaudio.terminate()
            except Exception:
                pass
            self._pyaudio = None
