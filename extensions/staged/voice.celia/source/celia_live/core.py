import asyncio
import threading
import time
import os
import re
import sys
import wave
import numpy as np
from typing import Optional, Callable, Tuple
from dataclasses import dataclass
from queue import Queue, Empty

try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False

try:
    from funasr import AutoModel
    FUNASR_AVAILABLE = True
except ImportError:
    FUNASR_AVAILABLE = False

from .config import Config
from .vad import create_vad

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

@dataclass
class VoiceSegment:
    audio_data: bytes
    timestamp: float
    duration: float

class ASREngine:
    def __init__(self, config: Config):
        self.config = config
        self.model = None
        self._ready = False
    
    def init(self):
        if not FUNASR_AVAILABLE:
            raise ImportError("FunASR 未安装，请运行: pip install funasr")

        print("正在加载 ASR 模型...")
        # 优先使用 model_path（本地路径），回退到 model（模型名/在线ID）
        model_param = self.config.asr.model_path or self.config.asr.model
        # 如果是相对路径，转为基于项目根目录的绝对路径
        if model_param and not os.path.isabs(model_param) and not "/" in model_param:
            abs_path = os.path.join(PROJECT_ROOT, model_param)
            if os.path.exists(abs_path):
                model_param = abs_path
        self.model = AutoModel(
            model=model_param,
            trust_remote_code=True,
            disable_update=True
        )
        self._ready = True
        print("  ✓ ASR 模型加载完成")
    
    def transcribe(self, audio_path: str) -> str:
        if not self._ready:
            raise RuntimeError("ASR 未初始化")
        
        result = self.model.generate(input=audio_path, cache={}, language="auto", use_itn=False)
        if result and len(result) > 0:
            text = result[0]['text']
            if ">" in text:
                text = text.split(">")[-1]
            return text
        return ""

class AudioRecorder:
    def __init__(self, config: Config, on_speech: Callable[[VoiceSegment], None]):
        self.config = config
        self.on_speech = on_speech
        self.sample_rate = config.asr.sample_rate
        self.channels = 1
        self.chunk = 1024
        self.detector = create_vad(config.vad)
        
        self._running = False
        self._stream = None
        self._pyaudio = None
        self._buffer = []
        self._min_voice_frames = config.vad.min_voice_frames
        self._voice_frame_count = 0
        self._paused = False
    
    def start(self):
        if not PYAUDIO_AVAILABLE:
            raise ImportError("PyAudio 未安装，请运行: pip install pyaudio")
        
        self._running = True
        self._pyaudio = pyaudio.PyAudio()
        self._stream = self._pyaudio.open(
            format=pyaudio.paInt16,
            channels=self.channels,
            rate=self.sample_rate,
            input=True,
            frames_per_buffer=self.chunk
        )
        
        thread = threading.Thread(target=self._record_loop, daemon=True)
        thread.start()
    
    def stop(self):
        self._running = False
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
        if self._pyaudio:
            self._pyaudio.terminate()
    
    def pause(self):
        self._paused = True
    
    def resume(self):
        self._paused = False
        self._buffer.clear()
        self._voice_frame_count = 0
    
    def _record_loop(self):
        audio_buffer = []
        
        while self._running:
            data = self._stream.read(self.chunk, exception_on_overflow=False)
            
            if self._paused:
                continue
            
            audio_buffer.append(data)
            
            buffer_duration = len(audio_buffer) * self.chunk / self.sample_rate
            
            if buffer_duration >= self.config.vad.frame_duration:
                raw_audio = b''.join(audio_buffer)
                audio_array = np.frombuffer(raw_audio, dtype=np.int16)
                vad_result = self.detector.process_chunk(audio_array)
                
                if vad_result['speech_started']:
                    # Speech just started - begin buffering
                    self._buffer.append((raw_audio, time.time()))
                    self._voice_frame_count = 1
                elif vad_result['is_speech'] and self._buffer:
                    # Continue buffering during speech
                    self._buffer.append((raw_audio, time.time()))
                    self._voice_frame_count += 1
                elif vad_result['speech_ended']:
                    # Speech just ended - finalize segment
                    if self._buffer:
                        self._buffer.append((raw_audio, time.time()))
                        if self._voice_frame_count >= self._min_voice_frames:
                            self._save_and_emit()
                        else:
                            self._buffer.clear()
                            self._voice_frame_count = 0
                
                audio_buffer = []
    
    def _save_and_emit(self):
        if not self._buffer:
            return
        
        audio_frames = [seg[0] for seg in self._buffer]
        duration = sum(len(f) for f in audio_frames) / self.sample_rate / 2
        
        output_dir = self.config.tts.output_dir
        os.makedirs(output_dir, exist_ok=True)
        audio_path = f"{output_dir}/speech_{int(time.time() * 1000)}.wav"
        
        with wave.open(audio_path, 'wb') as wf:
            wf.setnchannels(self.channels)
            wf.setsampwidth(2)
            wf.setframerate(self.sample_rate)
            wf.writeframes(b''.join(audio_frames))
        
        segment = VoiceSegment(
            audio_data=b''.join(audio_frames),
            timestamp=self._buffer[0][1],
            duration=duration
        )
        segment.audio_path = audio_path
        self._buffer.clear()
        self._voice_frame_count = 0
        
        self.on_speech(segment)

class TTSEngine:
    def __init__(self, config: Config):
        self.config = config
        self._ready = False
        self._tts_manager = None
        self._emotion = None

    def init(self):
        try:
            from agent.tts import TTSManager

            tts_config = self.config.tts

            # 根据配置决定首选后端
            if tts_config.provider in ("cosyvoice", "cosyvoice-v3.5-plus"):
                backend = "cosyvoice"
            elif tts_config.provider in ("sherpa-onnx", "sherpa_onnx"):
                backend = "sherpa_onnx"
            else:
                backend = "bert_vits2"

            # 构建子配置
            cosyvoice = tts_config.cosyvoice
            bert_vits2 = tts_config.bert_vits2
            sherpa_onnx = tts_config.sherpa_onnx

            self._tts_manager = TTSManager(
                backend=backend,
                output_dir=tts_config.output_dir,
                # CosyVoice 配置
                cosyvoice_api_key=cosyvoice.api_key,
                cosyvoice_model=cosyvoice.model,
                cosyvoice_voice_id=cosyvoice.voice_id,
                cosyvoice_ref_audio=cosyvoice.ref_audio,
                cosyvoice_default_instruction=cosyvoice.instruction,
                cosyvoice_audio_format=cosyvoice.format,
                cosyvoice_sample_rate=cosyvoice.sample_rate,
                cosyvoice_base_url=cosyvoice.base_url,
                cosyvoice_proxy=cosyvoice.proxy,
                # Bert-VITS2 配置
                bert_vits2_config_path=bert_vits2.gen_config_path,
                bert_vits2_output_dir=tts_config.output_dir,
                # Sherpa-ONNX 配置
                sherpa_onnx_model_dir=sherpa_onnx.model_dir,
                sherpa_onnx_voice=sherpa_onnx.voice,
                sherpa_onnx_speed=sherpa_onnx.speed,
                sherpa_onnx_volume=sherpa_onnx.volume,
                sherpa_onnx_pitch=sherpa_onnx.pitch,
                sherpa_onnx_audio_format=sherpa_onnx.audio_format,
                sherpa_onnx_sample_rate=sherpa_onnx.sample_rate,
                sherpa_onnx_device=sherpa_onnx.device,
            )

            self._ready = self._tts_manager.is_ready
            if self._ready:
                print(f"  ✓ TTS 引擎初始化完成 (后端: {self._tts_manager.active_backend})")
            else:
                print("  ⚠ TTS 引擎初始化失败：所有后端均不可用")
        except Exception as e:
            print(f"  ⚠ TTS 初始化失败: {e}")
            self._ready = False

    def set_emotion(self, emotion):
        """设置当前情绪（用于情绪驱动的TTS）

        Args:
            emotion: EmotionType枚举值
        """
        self._emotion = emotion

    def generate(self, text: str) -> Optional[str]:
        if not self._ready or not self._tts_manager:
            return None

        try:
            return self._tts_manager.generate_sync(text, emotion=self._emotion)
        except Exception as e:
            print(f"TTS 生成失败: {e}")
            return None

    def generate_stream_to_file(self, text: str) -> Optional[str]:
        """流式生成音频并保存到文件

        使用流式接口收集音频数据，保存到临时文件后返回路径。
        相比非流式接口可以更快获得音频文件（首包延迟更低）。

        Args:
            text: 要转换为语音的文本

        Returns:
            音频文件路径，如果生成失败则返回None
        """
        if not self._ready or not self._tts_manager:
            return None

        try:
            return self._tts_manager.generate_stream_to_file_sync(text, emotion=self._emotion)
        except Exception as e:
            print(f"TTS 流式生成失败: {e}")
            return None

class AudioPlayer:
    def __init__(self, virtual_cable: bool = False, cable_device: str = "", speaker_device: str = ""):
        self._pygame_ready = False
        self._playing = False
        self._interrupt = threading.Event()
        self._play_thread = None
        # 双音频输出（OBS 推流）
        self._dual_player = None
        self._virtual_cable = virtual_cable
        self._cable_device = cable_device
        self._speaker_device = speaker_device

    def init(self):
        try:
            import pygame
            pygame.mixer.init(frequency=44100, size=-16, channels=1, buffer=512)
            self._pygame_ready = True
            print("  ✓ 音频播放器初始化完成")
        except Exception as e:
            print(f"  ⚠ 音频播放器初始化失败: {e}")

        # 初始化双音频播放器（OBS 推流用）
        if self._virtual_cable:
            try:
                from .audio_output import DualAudioPlayer
                self._dual_player = DualAudioPlayer(
                    virtual_cable=self._virtual_cable,
                    cable_device=self._cable_device,
                    speaker_device=self._speaker_device
                )
                if self._dual_player.init():
                    print("  ✓ 虚拟音频电缆输出已启用（OBS 推流就绪）")
            except Exception as e:
                print(f"  ⚠ 虚拟音频电缆初始化失败: {e}")
                self._dual_player = None

    def play_async(self, audio_path: str, on_done: Optional[Callable] = None):
        self.stop()
        self._interrupt.clear()
        self._playing = True

        # 如果启用虚拟电缆，使用双音频播放器
        if self._dual_player:
            self._dual_player.play_async(audio_path, on_done=on_done)
            return

        # 否则使用默认 pygame 播放
        def _play():
            try:
                import pygame
                pygame.mixer.music.load(audio_path)
                pygame.mixer.music.play()
                while pygame.mixer.music.get_busy() and not self._interrupt.is_set():
                    time.sleep(0.05)
                pygame.mixer.music.stop()
            except Exception as e:
                print(f"音频播放失败: {e}")
            finally:
                self._playing = False
                if on_done:
                    on_done()

        self._play_thread = threading.Thread(target=_play, daemon=True)
        self._play_thread.start()

    def play_stream_async(self, audio_path_getter, on_done: Optional[Callable] = None):
        """流式播放音频：在音频文件写入过程中开始播放

        适用于流式TTS场景：音频数据逐步写入文件，播放器在文件就绪后立即开始播放。
        audio_path_getter 是一个可调用对象，返回 (audio_path, ready_event) 元组，
        其中 ready_event 在音频文件写入完成时被设置。

        Args:
            audio_path_getter: 返回 (audio_path, ready_event) 的可调用对象
            on_done: 播放完成回调
        """
        self.stop()
        self._interrupt.clear()
        self._playing = True

        def _play():
            try:
                import pygame

                # 获取音频路径和就绪事件
                audio_path, ready_event = audio_path_getter()

                # 等待文件开始有数据（短暂等待确保文件已创建并写入头部）
                time.sleep(0.1)

                if not os.path.exists(audio_path):
                    ready_event.wait(timeout=30)

                if not os.path.exists(audio_path) or self._interrupt.is_set():
                    return

                # 加载并播放音频
                pygame.mixer.music.load(audio_path)
                pygame.mixer.music.play()

                while pygame.mixer.music.get_busy() and not self._interrupt.is_set():
                    time.sleep(0.05)

                pygame.mixer.music.stop()

                # 等待流式写入完成（确保文件完整）
                if not self._interrupt.is_set():
                    ready_event.wait(timeout=30)

            except Exception as e:
                print(f"流式音频播放失败: {e}")
            finally:
                self._playing = False
                if on_done:
                    on_done()

        self._play_thread = threading.Thread(target=_play, daemon=True)
        self._play_thread.start()

    def stop(self):
        self._interrupt.set()
        if self._play_thread and self._play_thread.is_alive():
            self._play_thread.join(timeout=1.0)
        if self._dual_player:
            self._dual_player.stop()
        try:
            import pygame
            if pygame.mixer.get_init():
                pygame.mixer.music.stop()
        except Exception:
            pass
        self._playing = False

    @property
    def is_playing(self):
        return self._playing

class CeliaLive:
    def __init__(self, config: Optional[Config] = None):
        self.config = config or Config()
        self.asr = ASREngine(self.config)
        self.tts = TTSEngine(self.config)
        self.player = AudioPlayer(
            virtual_cable=self.config.audio_output.virtual_cable,
            cable_device=self.config.audio_output.cable_device,
            speaker_device=self.config.audio_output.speaker_device
        )
        self.recorder = None
        self._running = False
        self._message_callback = None
        self._event_loop = None
        self._speaking = False
        self._interrupted = False
        self._processing = False
        self._speech_queue = Queue()
        self._tts_queue = Queue()
        self._cached_agent = None
        self._ws_callback = None
        self._current_emotion = None
        self._current_emotion_intensity = 0.0
    
    def set_message_callback(self, callback: Callable[[str, str], None]):
        self._message_callback = callback

    def set_ws_callback(self, callback):
        """Register a WebSocket callback for pushing events to browser frontend.

        The callback signature: callback(event_type: str, data: Any)
        It will be called from threads, so the callback must handle
        thread-safety (e.g., using asyncio.run_coroutine_threadsafe).
        """
        self._ws_callback = callback

    def _push_ws_event(self, event_type: str, data):
        """Push an event to the WebSocket callback if registered.
        
        Handles both sync and async callbacks. For async callbacks,
        schedules the coroutine on the agent event loop.
        """
        if self._ws_callback:
            try:
                result = self._ws_callback(event_type, data)
                # If callback is async, schedule it on the agent loop
                if asyncio.iscoroutine(result):
                    if hasattr(self, '_agent_loop') and self._agent_loop.is_running():
                        asyncio.run_coroutine_threadsafe(result, self._agent_loop)
                    else:
                        # Fallback: create a new event loop
                        threading.Thread(target=asyncio.run, args=(result,), daemon=True).start()
            except Exception as e:
                print(f"WebSocket event push failed: {e}")

    def set_emotion(self, emotion, intensity: float = 0.5):
        """Set current emotion and push expression event to WebSocket.

        Args:
            emotion: EmotionType enum value or string name
        """
        self._current_emotion = emotion
        self._current_emotion_intensity = max(0.0, min(1.0, float(intensity)))
        self.tts.set_emotion(emotion)
        emotion_name = emotion.value if hasattr(emotion, 'value') else str(emotion)
        self._push_ws_event("expression", {
            "emotion": emotion_name,
            "strength": self._current_emotion_intensity,
        })

    def _mood_payload(self, agent=None):
        """Serialize InnerMind's persistent state for the Live2D expression layer."""
        state = getattr(getattr(agent, "inner_mind", None), "emotional_state", None)
        if state is None:
            return {"emotion": "calm", "intensity": 0.0,
                    "happiness": 0.5, "anxiety": 0.3,
                    "affection": 0.5, "energy": 0.7,
                    "face": {"mouthForm": 0.0, "brow": 0.0,
                             "eyeOpenL": 1.0, "eyeOpenR": 1.0}}

        clamp = lambda value, low, high: max(low, min(high, float(value)))
        happiness = clamp(state.happiness, 0.0, 1.0)
        anxiety = clamp(state.anxiety, 0.0, 1.0)
        energy = clamp(state.energy, 0.0, 1.0)
        affection = clamp(state.affection, 0.0, 1.0)
        return {
            "emotion": state.current_emotion.value,
            "intensity": clamp(state.intensity, 0.0, 1.0),
            "happiness": happiness,
            "anxiety": anxiety,
            "affection": affection,
            "energy": energy,
            "face": {
                "mouthForm": clamp((happiness - 0.5) * 0.55 + (affection - 0.5) * 0.2, -1.0, 1.0),
                "brow": clamp((happiness - 0.5) * 0.18 - (anxiety - 0.3) * 0.35, -1.0, 1.0),
                "eyeOpenL": clamp(0.88 + energy * 0.12 - anxiety * 0.08, 0.0, 1.0),
                "eyeOpenR": clamp(0.88 + energy * 0.12 - anxiety * 0.08, 0.0, 1.0),
            },
        }
    
    def init(self, enable_asr: bool = True):
        if enable_asr:
            self.asr.init()
        self.tts.init()
        self.player.init()
        
        # Mark as running
        self._running = True
        
        # Initialize agent event loop (needed for both voice and web mode)
        self._agent_loop = asyncio.new_event_loop()
        def _run_loop():
            asyncio.set_event_loop(self._agent_loop)
            self._agent_loop.run_forever()
        self._agent_thread = threading.Thread(target=_run_loop, daemon=True)
        self._agent_thread.start()
        
        print("正在预热 Agent 系统...")
        self._preload_agent()
        print("✅ 所有组件加载完成！")
    
    def init_text_mode(self):
        self._running = True
        self.tts.init()
        
        # Initialize agent event loop
        self._agent_loop = asyncio.new_event_loop()
        def _run_loop():
            asyncio.set_event_loop(self._agent_loop)
            self._agent_loop.run_forever()
        self._agent_thread = threading.Thread(target=_run_loop, daemon=True)
        self._agent_thread.start()
        
        print("正在预热 Agent 系统...")
        self._preload_agent()
        print("✅ 所有组件加载完成！")
    
    def _preload_agent(self):
        try:
            from agent import process_message, get_agent
            agent = asyncio.run(get_agent("default", enable_tts=False))
            
            if not agent.orchestrator_ready:
                agent._init_orchestrator()
            
            if agent.memory_ready and agent.memory_manager:
                try:
                    agent.memory_manager._ensure_initialized()
                    print("  ✓ 记忆向量库已预加载")
                except Exception as e:
                    print(f"  ⚠ 记忆向量库预加载失败: {e}")
                
                try:
                    agent.memory_manager.get_recent_conversations(k=1)
                except Exception:
                    pass
            
            print(f"  ✓ Agent 已就绪 (模型: {agent.model_type})")
            print(f"  ✓ 记忆系统: {'已启用' if agent.memory_ready else '未启用'}")
            print(f"  ✓ 内心系统: {'已启用' if agent.mind_ready else '未启用'}")
            print(f"  ✓ 编排器: {'已启用' if agent.orchestrator_ready else '未启用'}")
        except Exception as e:
            print(f"  ⚠ Agent 预热失败: {e}")
    
    def start_voice(self):
        self._running = True
        
        # Agent loop already initialized in init()
        if not hasattr(self, '_agent_loop') or not self._agent_loop.is_running():
            self._agent_loop = asyncio.new_event_loop()
            def _run_loop():
                asyncio.set_event_loop(self._agent_loop)
                self._agent_loop.run_forever()
            self._agent_thread = threading.Thread(target=_run_loop, daemon=True)
            self._agent_thread.start()
        
        self.recorder = AudioRecorder(self.config, self._on_speech)
        self.recorder.start()
        
        print("🎤 麦克风已开启，可以说话了！按 Ctrl+C 停止")
    
    def stop_voice(self):
        self._running = False
        self._interrupted = True
        self.player.stop()
        if self.recorder:
            self.recorder.stop()
        if hasattr(self, '_agent_loop') and self._agent_loop.is_running():
            self._agent_loop.call_soon_threadsafe(self._agent_loop.stop)

    def pause_recording(self):
        """Pause microphone recording (for WebSocket control)."""
        if self.recorder:
            self.recorder.pause()
            self._push_ws_event("status", {"listening": False})

    def resume_recording(self):
        """Resume microphone recording (for WebSocket control)."""
        if self.recorder:
            self.recorder.resume()
            self._push_ws_event("status", {"listening": True})
    
    def _on_speech(self, segment: VoiceSegment):
        if self._processing:
            print("🔇 检测到打断！")
            self._interrupted = True
            self.player.stop()
        
        t0 = time.time()
        text = self.asr.transcribe(segment.audio_path)
        asr_time = time.time() - t0
        if not text.strip():
            return
        
        print(f"🗣️ 用户: {text}  [ASR: {asr_time:.2f}s]")

        self._push_ws_event("text", f"[用户] {text}")
        self._push_ws_event("status", {"listening": False, "speaking": True})
        
        self._speaking = True
        self._interrupted = False
        self._processing = True
        
        threading.Thread(
            target=self._stream_process, 
            args=(text,), 
            daemon=True
        ).start()
    
    def _stream_process(self, text: str):
        self._speaking = True
        self._interrupted = False
        self._processing = True
        self._push_ws_event("status", {"speaking": True})
        
        try:
            if self._cached_agent is None:
                from agent import get_agent
                
                future = asyncio.run_coroutine_threadsafe(
                    get_agent("default", enable_tts=False),
                    self._agent_loop
                )
                self._cached_agent = future.result(timeout=30)
            
            agent = self._cached_agent
            full_response = ""
            
            async def _run_stream():
                nonlocal full_response
                async for sentence in agent.process_stream(text):
                    if self._interrupted:
                        break
                    
                    if sentence.strip():
                        full_response += sentence
                        print(f"💬 {self.config.character_name}: {sentence}")
            
            stream_future = asyncio.run_coroutine_threadsafe(
                _run_stream(),
                self._agent_loop
            )
            stream_future.result(timeout=60)
            
            # Push complete response as one message
            if full_response:
                emotion = getattr(agent, "last_emotion", None)
                intensity = 0.5
                if getattr(agent, "inner_mind", None):
                    state = getattr(agent.inner_mind, "emotional_state", None)
                    if state is not None:
                        intensity = getattr(state, "intensity", 0.5)
                if emotion is not None:
                    self.set_emotion(emotion, intensity)
                    self._push_ws_event("mood", self._mood_payload(agent))

                self._push_ws_event("text", full_response)
                
                # Generate ONE audio for the entire response (like HakusAI_chat)
                print(f"[TTS] Generating audio for full response: {full_response[:40]}...")
                audio_file = self.tts.generate(full_response)
                if audio_file:
                    print(f"[TTS] Audio generated: {audio_file}")
                    self._push_ws_event("audio", audio_file)
                else:
                    print(f"[TTS] Audio generation failed")
            
            if self._message_callback and full_response:
                self._message_callback(text, full_response)
                
        except Exception as e:
            print(f"处理失败: {e}")
        finally:
            self._speaking = False
            self._processing = False
            self._push_ws_event("status", {"speaking": False})
    
    def _tts_worker(self):
        """TTS工作线程：从队列获取文本，生成音频并播放

        优化策略：
        1. 优先使用流式生成（SSE），降低首包延迟
        2. 使用独立线程预生成下一句音频，与当前播放并行
        3. 预生成的音频存储在 next_audio 中，当前音频播放完毕后可立即使用
        4. 流式生成失败时自动回退到非流式生成
        """
        next_audio = None
        next_audio_lock = threading.Lock()
        pregen_done = threading.Event()

        def _pregenerate(text):
            """在独立线程中预生成下一句音频"""
            nonlocal next_audio
            audio = self.tts.generate_stream_to_file(text)
            if audio is None:
                # 流式生成失败，回退到非流式
                audio = self.tts.generate(text)
            with next_audio_lock:
                next_audio = audio
            pregen_done.set()

        while self._running:
            try:
                text = self._tts_queue.get(timeout=0.5)
            except Empty:
                continue

            if text is None:
                self._speaking = False
                with next_audio_lock:
                    next_audio = None
                self._push_ws_event("status", {"speaking": False})
                continue

            if self._interrupted:
                with next_audio_lock:
                    next_audio = None
                continue

            print(f"[TTS Worker] Generating audio for: {text[:30]}...")
            # 获取当前句子的音频（优先使用预生成结果）
            with next_audio_lock:
                current_audio = next_audio
                next_audio = None
            pregen_done.clear()

            if current_audio is None:
                # 没有预生成结果，使用流式生成当前句子
                current_audio = self.tts.generate_stream_to_file(text)
                if current_audio is None:
                    # 流式生成失败，回退到非流式
                    print(f"[TTS Worker] Stream failed, falling back to non-stream for: {text[:30]}...")
                    current_audio = self.tts.generate(text)

            if current_audio and not self._interrupted:
                print(f"[TTS Worker] Audio generated: {current_audio}")
                # Push audio event to WebSocket
                self._push_ws_event("audio", current_audio)

                # 尝试预生成下一句（在独立线程中与播放并行）
                try:
                    peek = self._tts_queue.get(timeout=0.05)
                    if peek is not None and not self._interrupted:
                        pregen_thread = threading.Thread(
                            target=_pregenerate, args=(peek,), daemon=True
                        )
                        pregen_thread.start()
                    elif peek is None:
                        self._speaking = False
                except Empty:
                    pass

                # 播放当前音频
                done_event = threading.Event()
                self.player.play_async(current_audio, on_done=done_event.set)
                done_event.wait(timeout=15)

                # 等待预生成线程完成（如果正在运行）
                if pregen_done.is_set() or not threading.enumerate():
                    pass  # 预生成已完成或无预生成线程
                # 注意：不阻塞等待预生成，下一轮循环会检查 next_audio
    
    def _run_async(self, coro):
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(asyncio.run, coro)
                    return future.result(timeout=60)
            else:
                return loop.run_until_complete(coro)
        except RuntimeError:
            return asyncio.run(coro)
    
    async def _process_with_agent(self, text: str) -> str:
        from agent import process_message
        response, _ = await process_message(
            uid="default",
            msg=text,
            enable_tts=False
        )
        return response
    
    def process_text(self, text: str) -> Tuple[str, Optional[str]]:
        response = self._run_async(self._process_with_agent(text))
        audio_path = None
        if response:
            audio_path = self.tts.generate(response)
        return response, audio_path

    def process_live_message(self, text: str, source: str = "danmaku"):
        """处理来自直播间的消息（弹幕/礼物/SC/大航海/进场）

        复用 Agent 流式处理流程，回复通过 WebSocket 推送。
        高优先级消息（SC/大航海）可打断当前处理。

        Args:
            text: 直播消息文本（已格式化）
            source: 消息来源（danmaku/gift/super_chat/guard/entry/proactive）
        """
        # 高优先级消息（SC/大航海）可打断当前处理
        high_priority = source in ("super_chat", "guard")

        if self._processing and not high_priority:
            # AI 正在处理普通消息，低优先级消息跳过
            print(f"[直播-{source}] AI 正在处理，跳过消息: {text[:30]}...")
            return

        if self._processing and high_priority:
            # 高优先级消息打断当前处理
            print(f"[直播-{source}] 高优先级消息，打断当前处理")
            self._interrupted = True
            self.player.stop()

        print(f"[直播-{source}] {text[:50]}...")
        self._push_ws_event("text", f"[直播] {text}")
        self._push_ws_event("status", {"speaking": True})

        threading.Thread(
            target=self._stream_process,
            args=(text,),
            daemon=True
        ).start()

    def run(self):
        self.init()
        self.start_voice()
        
        try:
            while self._running:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n正在停止...")
            self.stop_voice()
