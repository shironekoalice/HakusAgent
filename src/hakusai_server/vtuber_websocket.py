"""
虚拟主播全双工 WebSocket 处理器
支持实时语音对话、流式TTS、口型同步、打断机制

架构:
- asyncio.Task 全局取消机制
- 流式管线: LLM流式输出 -> 标点切分 -> 逐句TTS -> 逐句音频推送
- 打断刹车: 收到interrupt指令立刻取消当前LLM+TTS任务
"""

import asyncio
import json
import base64
import logging
import time
import re
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, field
from enum import Enum

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

# WebSocket 配置常量
_WS_RECEIVE_TIMEOUT = 300.0  # WebSocket 接收超时（秒）
_WS_TTS_WORKER_TIMEOUT = 60.0  # TTS 工作协程等待超时（秒）
_WS_TTS_TASK_SHUTDOWN_TIMEOUT = 30.0  # TTS 任务关闭等待超时（秒）
_LIP_SYNC_FRAME_DURATION_MS = 50  # 口型同步帧时长（毫秒）


class WSAction(Enum):
    TEXT = "text"
    INTERRUPT = "interrupt"
    AUDIO_CHUNK = "audio_chunk"
    INTERRUPTED = "interrupted"
    EMOTION = "emotion"
    LIP_SYNC = "lip_sync"
    TTS_START = "tts_start"
    TTS_END = "tts_end"
    ERROR = "error"
    CONTROL = "control"
    PING = "ping"
    PONG = "pong"
    STATE = "state"
    TOKEN = "token"


@dataclass
class VTuberSession:
    session_id: str
    user_id: str
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    is_speaking: bool = False
    current_text: str = ""
    emotion: str = "neutral"
    current_task: Optional[asyncio.Task] = None
    tts_engine: Optional[Any] = None


class SentenceSplitter:
    """标点符号切分器 - 流式文本按句切分"""

    SENTENCE_ENDINGS = re.compile(r'[。！？!?\n]')
    CLAUSE_ENDINGS = re.compile(r'[，,；;：:、]')

    def __init__(self, min_length: int = 4, max_length: int = 80):
        self.buffer = ""
        self.min_length = min_length
        self.max_length = max_length

    def feed(self, text: str) -> List[str]:
        if not text:
            return []

        self.buffer += text
        sentences = []

        while self.buffer:
            sent_end = self.SENTENCE_ENDINGS.search(self.buffer)
            clause_end = self.CLAUSE_ENDINGS.search(self.buffer)

            cut_pos = None
            if sent_end:
                cut_pos = sent_end.end()
            elif len(self.buffer) >= self.max_length and clause_end:
                cut_pos = clause_end.end()

            if cut_pos is not None and cut_pos >= self.min_length:
                sentence = self.buffer[:cut_pos].strip()
                if sentence:
                    sentences.append(sentence)
                self.buffer = self.buffer[cut_pos:]
            elif len(self.buffer) >= self.max_length:
                sentence = self.buffer.strip()
                if sentence:
                    sentences.append(sentence)
                self.buffer = ""
            else:
                break

        return sentences

    def flush(self) -> Optional[str]:
        if self.buffer.strip():
            result = self.buffer.strip()
            self.buffer = ""
            return result
        return None

    def reset(self):
        self.buffer = ""


class TTSEngine:
    """TTS引擎抽象 - 支持多种后端"""

    def __init__(self):
        self._engine = None
        self._engine_type = None

    async def initialize(self, engine_type: str = "cosyvoice", config: dict = None):
        self._engine_type = engine_type
        config = config or {}

        if engine_type == "voxcpm":
            await self._init_voxcpm(config)
        elif engine_type == "cosyvoice":
            await self._init_cosyvoice(config)
        else:
            logger.warning(f"Unknown TTS engine type: {engine_type}, trying cosyvoice")
            await self._init_cosyvoice(config)

    async def _init_voxcpm(self, config: dict):
        try:
            import sys
            import os
            import torch
            voxcpm_path = config.get("voxcpm_path", r"D:\项目\HakusAI_chat\voxcpm")
            original_cwd = os.getcwd()
            os.chdir(voxcpm_path)
            sys.path.insert(0, os.path.join(voxcpm_path, "VoxCPM", "src"))

            from voxcpm import VoxCPM
            model_path = config.get("model_path", "./VoxCPM1.5/OpenBMB/VoxCPM1___5")
            self._engine = VoxCPM.from_pretrained(model_path, load_denoiser=False, optimize=False)

            # 尝试使用 Intel XPU (核显) 加速推理
            tts_model = self._engine.tts_model
            try:
                if hasattr(torch, 'xpu') and torch.xpu.is_available():
                    device_name = f"xpu:{torch.xpu.current_device()}"
                    self._engine.tts_model = tts_model.to(device_name)
                    logger.info(f"VoxCPM1.5 moved to XPU: {device_name}")
                else:
                    logger.info("XPU not available, using current device")
            except Exception as xpu_err:
                logger.warning(f"XPU move failed: {xpu_err}, using default device")

            self._engine_type = "voxcpm"
            os.chdir(original_cwd)
            logger.info(f"VoxCPM1.5 TTS engine initialized on {self._engine.tts_model.device} ({self._engine.tts_model.sample_rate}Hz)")
        except Exception as e:
            logger.error(f"Failed to initialize VoxCPM1.5: {e}")
            self._engine = None

    async def _init_cosyvoice(self, config: dict):
        try:
            from hakusai_core.voice.tts import tts_registry
            self._engine = tts_registry.create_engine("cosyvoice", config)
            await self._engine.initialize()
            self._engine_type = "cosyvoice"
            logger.info("CosyVoice TTS engine initialized")
        except Exception as e:
            logger.error(f"Failed to initialize CosyVoice: {e}")
            self._engine = None

    def is_available(self) -> bool:
        return self._engine is not None

    async def synthesize(self, text: str) -> Optional[bytes]:
        if not self._engine or not text.strip():
            return None

        try:
            if self._engine_type == "voxcpm":
                return await self._synthesize_voxcpm(text)
            elif self._engine_type == "cosyvoice":
                return await self._synthesize_cosyvoice(text)
        except Exception as e:
            logger.error(f"TTS synthesis failed: {e}")
            return None

    async def _synthesize_voxcpm(self, text: str) -> Optional[bytes]:
        try:
            import numpy as np
            import soundfile as sf
            import io

            logger.info(f"[VoxCPM] Synthesizing: '{text[:50]}'")

            loop = asyncio.get_running_loop()

            def _generate():
                wav = self._engine.generate(
                    target_text=text,
                    cfg_value=1.8,
                    inference_timesteps=5,
                )
                return wav

            wav = await loop.run_in_executor(None, _generate)
            logger.info(f"[VoxCPM] Generated wav array: {len(wav)} samples, {len(wav)/self._engine.tts_model.sample_rate:.2f}s")

            buf = io.BytesIO()
            sf.write(buf, wav, self._engine.tts_model.sample_rate, format='WAV')
            buf.seek(0)
            audio_bytes = buf.read()
            logger.info(f"[VoxCPM] WAV encoded: {len(audio_bytes)} bytes, sample_rate={self._engine.tts_model.sample_rate}")
            return audio_bytes
        except Exception as e:
            import traceback
            logger.error(f"VoxCPM synthesis failed: {e}")
            logger.error(traceback.format_exc())
            return None

    async def _synthesize_cosyvoice(self, text: str) -> Optional[bytes]:
        try:
            audio_chunks = []
            for chunk in self._engine.generate_audio_stream(text):
                if chunk and len(chunk) > 0:
                    audio_chunks.append(chunk)

            if audio_chunks:
                return b"".join(audio_chunks)
            return None
        except Exception as e:
            logger.error(f"CosyVoice synthesis failed: {e}")
            return None


class VTuberWebSocketHandler:
    """
    虚拟主播 WebSocket 处理器

    全双工架构:
    - 文本消息 -> LLM流式 -> 标点切分 -> 逐句TTS -> 逐句音频推送
    - 打断指令 -> 立即取消当前Task -> 发送interrupted确认
    - 语音输入 -> ASR -> LLM -> 流式TTS -> 音频流
    - Live2D 集成: 表情控制 + 高精度口型同步
    """

    def __init__(self):
        self.sessions: Dict[str, VTuberSession] = {}
        self._agent = None
        self._model_adapter = None
        self.tts_engine = TTSEngine()
        self._interrupt_events: Dict[str, asyncio.Event] = {}

        # VTuber/Live2D is an optional feature-plane extension. Until a
        # reviewed extension bundle is installed, the compatibility server
        # must expose an explicit unavailable surface and avoid importing
        # model/audio runtimes into the core process.
        self.extension_id = "avatar.vtuber"
        self._extension_available = False

        # Live2D 虚拟形象（新增）
        self._avatar = None
        self._avatar_enabled = False

    async def initialize(self, agent=None, model_adapter=None, tts_config: dict = None):
        self._agent = agent
        self._model_adapter = model_adapter

        if not self._extension_available:
            logger.info(
                "VTuber extension unavailable; install and trust the reviewed "
                "avatar.vtuber bundle to enable Live2D/VRM streaming"
            )
            return

        tts_config = tts_config or {}
        engine_type = tts_config.get("type", "cosyvoice")
        await self.tts_engine.initialize(engine_type, tts_config)

        if self.tts_engine.is_available():
            logger.info(f"VTuber handler: TTS engine ({self.tts_engine._engine_type}) initialized")
        else:
            logger.warning("VTuber handler: No TTS engine available")

        # 初始化 Live2D 虚拟形象（新增）
        try:
            from hakusai_core.avatar import create_web_live2d_avatar, live2d_model_manager
            import os

            # 检查是否有可用模型
            if live2d_model_manager.model_names:
                model_name = tts_config.get("live2d_model", "shizuku")

                async def _ws_send(msg):
                    """临时发送函数，稍后会替换为实际的 session 发送"""
                    pass

                self._avatar = await create_web_live2d_avatar(
                    model_name=model_name,
                    config={
                        "lip_sync_enabled": True,
                        "expression_enabled": True,
                        "auto_blink": True,
                        "auto_breath": True,
                    },
                    websocket_send=_ws_send  # 稍后会在 handle_connection 中更新
                )
                self._avatar_enabled = True
                logger.info(f"VTuber handler: Live2D avatar initialized ({model_name})")
            else:
                logger.warning("VTuber handler: No Live2D models found, avatar disabled")

        except Exception as e:
            logger.warning(f"VTuber handler: Failed to initialize Live2D avatar: {e}")
            self._avatar_enabled = False

    async def handle_connection(self, websocket: WebSocket, session_id: str = "default"):
        await websocket.accept()

        if not self._extension_available:
            await websocket.send_json({
                "action": WSAction.ERROR.value,
                "code": "extension_unavailable",
                "extension_id": self.extension_id,
                "message": "VTuber/Live2D is unavailable until its reviewed extension is installed",
            })
            await websocket.close(code=1013, reason="extension unavailable")
            return

        session = VTuberSession(
            session_id=session_id,
            user_id=f"vtuber_user_{id(websocket)}"
        )
        self.sessions[session_id] = session
        self._interrupt_events[session_id] = asyncio.Event()

        logger.info(f"VTuber WebSocket connected: {session_id}")

        # 更新 Live2D 形象的 WebSocket 发送函数（新增）
        if self._avatar and self._avatar_enabled:
            async def _avatar_send(message: str):
                """Live2D 形象专用的 WebSocket 发送函数"""
                try:
                    await websocket.send_text(message)
                except Exception as e:
                    logger.debug(f"Avatar send failed (connection may be closed): {e}")

            self._avatar.set_websocket_sender(_avatar_send)

            # 发送模型配置到前端
            try:
                from hakusai_core.avatar import live2d_model_manager
                model_config = live2d_model_manager.get_model_config()
                await websocket.send_json({
                    "action": WSAction.CONTROL.value,
                    "status": "connected",
                    "session_id": session_id,
                    "tts_engine": self.tts_engine._engine_type or "none",
                    "avatar_enabled": self._avatar_enabled,
                    "model_info": model_config,  # 新增：发送模型配置
                    "message": "Virtual avatar connection established"
                })
            except Exception as e:
                logger.warning(f"Failed to send model config: {e}")
        else:
            await websocket.send_json({
                "action": WSAction.CONTROL.value,
                "status": "connected",
                "session_id": session_id,
                "tts_engine": self.tts_engine._engine_type or "none",
                "avatar_enabled": False,
                "message": "Virtual avatar connection established"
            })

        try:
            while True:
                try:
                    raw_data = await asyncio.wait_for(
                        websocket.receive(),
                        timeout=_WS_RECEIVE_TIMEOUT
                    )

                    if raw_data.get("type") == "websocket.disconnect":
                        break

                    session.last_activity = time.time()

                    if "text" in raw_data:
                        await self._handle_text(websocket, session, raw_data["text"])
                    elif "bytes" in raw_data:
                        await self._handle_binary(websocket, session, raw_data["bytes"])

                except asyncio.TimeoutError:
                    await self._send(websocket, {
                        "action": WSAction.PING.value,
                        "timestamp": time.time()
                    })

        except WebSocketDisconnect:
            logger.info(f"VTuber WebSocket disconnected: {session_id}")
        except Exception as e:
            logger.error(f"VTuber WebSocket error: {e}")
            import traceback
            logger.error(traceback.format_exc())
        finally:
            await self._cancel_current_task(session)
            if session_id in self.sessions:
                del self.sessions[session_id]
            if session_id in self._interrupt_events:
                del self._interrupt_events[session_id]

    async def _handle_text(self, websocket: WebSocket, session: VTuberSession, text: str):
        try:
            data = json.loads(text)
            action = data.get("action", WSAction.TEXT.value)

            if action == WSAction.TEXT.value:
                content = data.get("content", data.get("text", ""))
                if content and content.strip():
                    await self._process_text_input(websocket, session, content)
            elif action == WSAction.INTERRUPT.value:
                await self._handle_interrupt(websocket, session)
            elif action == "ping":
                await self._send(websocket, {
                    "action": WSAction.PONG.value,
                    "timestamp": time.time()
                })
            elif action == "emotion":
                # 处理表情请求（新增）
                emotion_name = data.get("emotion", "neutral")
                intensity = data.get("intensity", 1.0)
                await self._handle_emotion(websocket, session, emotion_name, intensity)
            elif action == "switch_model":
                # 切换 Live2D 模型（新增）
                model_name = data.get("model_name")
                if model_name:
                    await self._handle_model_switch(websocket, session, model_name)
            else:
                logger.warning(f"Unknown action: {action}")

        except json.JSONDecodeError:
            if text.strip():
                await self._process_text_input(websocket, session, text)
        except Exception as e:
            logger.error(f"Error handling text message: {e}")
            await self._send_error(websocket, str(e))

    async def _handle_binary(self, websocket: WebSocket, session: VTuberSession, data: bytes):
        try:
            if len(data) < 4:
                return
            header = data[:4]
            if header == b"CTRL":
                try:
                    control_data = json.loads(data[4:].decode('utf-8'))
                    action = control_data.get("action", "")
                    if action == "interrupt":
                        await self._handle_interrupt(websocket, session)
                except Exception:
                    pass
            else:
                logger.debug(f"[{session.session_id}] Received audio data: {len(data)} bytes")
        except Exception as e:
            logger.error(f"Error handling binary message: {e}")

    async def _process_text_input(self, websocket: WebSocket, session: VTuberSession, user_text: str):
        logger.info(f"[{session.session_id}] User input: {user_text[:50]}...")

        await self._cancel_current_task(session)

        self._interrupt_events[session.session_id] = asyncio.Event()

        task = asyncio.create_task(
            self._streaming_pipeline(websocket, session, user_text)
        )
        session.current_task = task

        try:
            await task
        except asyncio.CancelledError:
            logger.info(f"[{session.session_id}] Pipeline task cancelled")
        except Exception as e:
            logger.error(f"[{session.session_id}] Pipeline error: {e}")
            import traceback
            logger.error(traceback.format_exc())
        finally:
            session.current_task = None
            session.is_speaking = False

    async def _streaming_pipeline(self, websocket: WebSocket, session: VTuberSession, user_text: str):
        """
        流式管线: LLM流式输出 -> 标点切分 -> 逐句TTS -> 逐句音频推送

        核心流程:
        1. 调用LLM流式接口，逐token获取文本
        2. 用SentenceSplitter按标点切分句子
        3. 每切出一个句子，立刻调用TTS生成音频
        4. TTS音频base64编码后立刻通过WebSocket推送
        5. 全程监听interrupt事件，收到打断立刻终止
        """
        session.is_speaking = True
        session.current_text = ""
        interrupt_event = self._interrupt_events.get(session.session_id)
        splitter = SentenceSplitter(min_length=4, max_length=80)

        try:
            await self._send(websocket, {
                "action": WSAction.TTS_START.value,
                "timestamp": time.time()
            })

            if not self._agent:
                response_text = f"收到消息: {user_text}"
                await self._synthesize_and_send(websocket, session, response_text, interrupt_event)
                await self._send(websocket, {
                    "action": WSAction.TTS_END.value,
                    "timestamp": time.time()
                })
                return

            from hakusai_core.agent import AgentContext
            context = AgentContext(
                session_id=session.session_id,
                user_id=session.user_id
            )

            full_response = ""
            tts_semaphore = asyncio.Semaphore(1)
            tts_queue: asyncio.Queue = asyncio.Queue()
            tts_task = asyncio.create_task(
                self._tts_worker(websocket, session, tts_queue, interrupt_event, tts_semaphore)
            )

            try:
                async for response in self._agent.chat(user_text, context, stream=True):
                    if interrupt_event and interrupt_event.is_set():
                        logger.info(f"[{session.session_id}] Interrupted during LLM streaming")
                        break

                    if response.content:
                        new_text = response.content
                        full_response += new_text
                        session.current_text = full_response

                        await self._send(websocket, {
                            "action": WSAction.TOKEN.value,
                            "content": new_text,
                            "full_text": full_response
                        })

                        sentences = splitter.feed(new_text)
                        for sentence in sentences:
                            if interrupt_event and interrupt_event.is_set():
                                break
                            await tts_queue.put(sentence)

                    if response.emotion:
                        session.emotion = response.emotion
                        await self._send(websocket, {
                            "action": WSAction.EMOTION.value,
                            "emotion": response.emotion
                        })

                remaining = splitter.flush()
                if remaining and not (interrupt_event and interrupt_event.is_set()):
                    await tts_queue.put(remaining)

            finally:
                await tts_queue.put(None)
                try:
                    await asyncio.wait_for(tts_task, timeout=_WS_TTS_TASK_SHUTDOWN_TIMEOUT)
                except asyncio.TimeoutError:
                    tts_task.cancel()
                    try:
                        await tts_task
                    except asyncio.CancelledError:
                        pass

            if not (interrupt_event and interrupt_event.is_set()):
                await self._send(websocket, {
                    "action": WSAction.TTS_END.value,
                    "timestamp": time.time()
                })

        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Streaming pipeline error: {e}")
            import traceback
            logger.error(traceback.format_exc())
            await self._send_error(websocket, f"Pipeline error: {str(e)}")
        finally:
            session.is_speaking = False

    async def _tts_worker(
        self,
        websocket: WebSocket,
        session: VTuberSession,
        queue: asyncio.Queue,
        interrupt_event: Optional[asyncio.Event],
        semaphore: asyncio.Semaphore
    ):
        """TTS工作协程 - 从队列取句子，合成音频，推送"""
        while True:
            try:
                sentence = await asyncio.wait_for(queue.get(), timeout=_WS_TTS_WORKER_TIMEOUT)

                if sentence is None:
                    break

                if interrupt_event and interrupt_event.is_set():
                    break

                async with semaphore:
                    if interrupt_event and interrupt_event.is_set():
                        break
                    await self._synthesize_and_send(websocket, session, sentence, interrupt_event)

            except asyncio.TimeoutError:
                break
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"TTS worker error: {e}")

    async def _synthesize_and_send(
        self,
        websocket: WebSocket,
        session: VTuberSession,
        text: str,
        interrupt_event: Optional[asyncio.Event] = None
    ):
        """合成TTS音频并发送"""
        if not text or not text.strip():
            return

        if interrupt_event and interrupt_event.is_set():
            return

        if not self.tts_engine.is_available():
            logger.debug("TTS engine not available, sending text only")
            await self._send(websocket, {
                "action": WSAction.TEXT.value,
                "content": text,
                "skip_tts": True
            })
            return

        try:
            logger.debug(f"Starting TTS synthesis for: {text[:50]}")
            audio_data = await self.tts_engine.synthesize(text)
            logger.debug(f"TTS synthesis result: {type(audio_data)}, len={len(audio_data) if audio_data else 0}")

            if interrupt_event and interrupt_event.is_set():
                return

            if audio_data:
                # 后端直接播放音频（用于测试）
                try:
                    logger.debug(f"Playing audio on backend: {len(audio_data)} bytes")
                    import soundfile as sf
                    import sounddevice as sd
                    import io
                    
                    buf = io.BytesIO(audio_data)
                    wav_data, sample_rate = sf.read(buf)
                    
                    # 异步播放，不阻塞主流程
                    def _play():
                        sd.play(wav_data, sample_rate)
                        sd.wait()  # 等待播放完成
                    
                    import threading
                    play_thread = threading.Thread(target=_play, daemon=True)
                    play_thread.start()
                except Exception as play_err:
                    logger.debug(f"Backend playback failed: {play_err}")
                
                # 发送到前端
                audio_base64 = base64.b64encode(audio_data).decode('utf-8')
                logger.info(f"[TTS] Sending audio chunk: {len(audio_base64)} chars base64, text: {text[:30]}...")

                await self._send(websocket, {
                    "action": WSAction.AUDIO_CHUNK.value,
                    "text": text,
                    "audio": audio_base64,
                    "format": "wav",
                    "timestamp": time.time()
                })

                # 使用改进的 LipSyncEngine V2 生成口型数据（新增）
                if self._avatar and self._avatar_enabled:
                    try:
                        from hakusai_core.avatar.lip_sync_v2 import LipSyncAnalyzerV2, LipSyncConfig

                        analyzer = LipSyncAnalyzerV2(LipSyncConfig())
                        lip_sync_data = await analyzer.process_audio_file(audio_data)

                        if lip_sync_data:
                            await self._send(websocket, {
                                "action": WSAction.LIP_SYNC.value,
                                "data": lip_sync_data,
                                "text": text,
                                "engine_version": "v2"  # 标记使用 V2 引擎
                            })
                            logger.debug(f"[TTS] Sent lip sync data (v2): {len(lip_sync_data)} frames")
                    except Exception as lip_err:
                        logger.warning(f"LipSync V2 failed, falling back to v1: {lip_err}")
                        # 回退到原始算法
                        lip_sync_data = self._generate_lip_sync_data(audio_data)
                        if lip_sync_data:
                            await self._send(websocket, {
                                "action": WSAction.LIP_SYNC.value,
                                "data": lip_sync_data,
                                "text": text,
                                "engine_version": "v1"
                            })
                else:
                    # 原始算法（无 Live2D 时使用）
                    lip_sync_data = self._generate_lip_sync_data(audio_data)
                    if lip_sync_data:
                        await self._send(websocket, {
                            "action": WSAction.LIP_SYNC.value,
                            "data": lip_sync_data,
                            "text": text
                        })

                logger.debug(f"[TTS] Sent audio for: {text[:30]}...")
            else:
                logger.debug("TTS returned None, sending text only")
                await self._send(websocket, {
                    "action": WSAction.TEXT.value,
                    "content": text,
                    "skip_tts": True
                })

        except asyncio.CancelledError:
            raise
        except Exception as e:
            import traceback
            logger.error(f"TTS synthesis error: {e}")
            logger.debug(traceback.format_exc())

    async def _handle_interrupt(self, websocket: WebSocket, session: VTuberSession):
        logger.info(f"[{session.session_id}] Interrupt received")

        interrupt_event = self._interrupt_events.get(session.session_id)
        if interrupt_event:
            interrupt_event.set()

        await self._cancel_current_task(session)

        session.is_speaking = False
        session.current_text = ""

        await self._send(websocket, {
            "action": WSAction.INTERRUPTED.value,
            "timestamp": time.time()
        })

    async def _cancel_current_task(self, session: VTuberSession):
        if session.current_task and not session.current_task.done():
            session.current_task.cancel()
            try:
                await asyncio.wait_for(session.current_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            session.current_task = None

    def _generate_lip_sync_data(self, audio_data: bytes) -> Optional[List[dict]]:
        try:
            if len(audio_data) < 44:
                return None

            if audio_data[:4] == b'RIFF':
                sample_rate = int.from_bytes(audio_data[24:28], 'little')
                sample_width = int.from_bytes(audio_data[34:36], 'little')
                audio_samples = audio_data[44:]
            else:
                sample_rate = 22050
                sample_width = 2
                audio_samples = audio_data

            samples = []
            for i in range(0, len(audio_samples), sample_width):
                if i + sample_width <= len(audio_samples):
                    sample = int.from_bytes(audio_samples[i:i+sample_width], 'little', signed=True)
                    samples.append(sample)

            if not samples:
                return None

            frame_duration_ms = _LIP_SYNC_FRAME_DURATION_MS
            samples_per_frame = int(sample_rate * frame_duration_ms / 1000)
            lip_sync_data = []
            max_amplitude = max(abs(s) for s in samples) if samples else 1

            for i in range(0, len(samples), samples_per_frame):
                frame_samples = samples[i:i + samples_per_frame]
                if frame_samples:
                    rms = (sum(s*s for s in frame_samples) / len(frame_samples)) ** 0.5
                    mouth_open = min(1.0, (rms / max_amplitude) * 2.0)
                    lip_sync_data.append({
                        "time": i / sample_rate,
                        "mouth_open": mouth_open,
                        "amplitude": rms / max_amplitude if max_amplitude > 0 else 0
                    })

            return lip_sync_data

        except Exception as e:
            logger.error(f"Lip sync data generation failed: {e}")
            return None

    async def _send(self, websocket: WebSocket, message: dict):
        try:
            await websocket.send_json(message)
        except Exception as e:
            logger.error(f"Send message failed: {e}")

    async def _send_error(self, websocket: WebSocket, error_msg: str):
        await self._send(websocket, {
            "action": WSAction.ERROR.value,
            "message": error_msg,
            "timestamp": time.time()
        })

    async def _handle_emotion(self, websocket: WebSocket, session: VTuberSession, emotion_name: str, intensity: float = 1.0):
        """处理表情设置请求（新增）"""
        if not self._avatar or not self._avatar_enabled:
            await self._send(websocket, {
                "action": WSAction.ERROR.value,
                "message": "Avatar not enabled",
                "timestamp": time.time()
            })
            return

        try:
            from hakusai_core.avatar import EmotionType

            # 设置情感
            emotion = EmotionType(emotion_name.lower())
            self._avatar.set_emotion(emotion, intensity)

            # 更新会话状态
            session.emotion = emotion_name

            logger.info(f"[{session.session_id}] Emotion set to: {emotion_name} ({intensity})")

            # 发送确认
            await self._send(websocket, {
                "action": WSAction.EMOTION.value,
                "emotion": emotion_name,
                "intensity": intensity,
                "success": True,
                "timestamp": time.time()
            })

        except ValueError:
            await self._send(websocket, {
                "action": WSAction.ERROR.value,
                "message": f"Unknown emotion: {emotion_name}",
                "timestamp": time.time()
            })
        except Exception as e:
            logger.error(f"Error setting emotion: {e}")
            await self._send_error(websocket, str(e))

    async def _handle_model_switch(self, websocket: WebSocket, session: VTuberSession, model_name: str):
        """处理模型切换请求（新增）"""
        if not self._avatar_enabled:
            await self._send(websocket, {
                "action": WSAction.ERROR.value,
                "message": "Avatar not enabled",
                "timestamp": time.time()
            })
            return

        try:
            from hakusai_core.avatar import live2d_model_manager

            # 检查模型是否存在
            if model_name not in live2d_model_manager.model_names:
                available = live2d_model_manager.model_names
                await self._send(websocket, {
                    "action": WSAction.ERROR.value,
                    "message": f"Model '{model_name}' not found. Available: {available}",
                    "timestamp": time.time()
                })
                return

            # 切换模型
            success = live2d_model_manager.set_model(model_name)
            if not success:
                raise RuntimeError(f"Failed to switch to model: {model_name}")

            # 重新加载形象
            await self._avatar.unload()
            self._avatar.live2d_config.model_name = model_name
            await self._avatar.load()

            # 发送新的模型配置到前端
            model_config = live2d_model_manager.get_model_config()
            await self._send(websocket, {
                "action": "model_switched",
                "model_info": model_config,
                "success": True,
                "timestamp": time.time()
            })

            logger.info(f"[{session.session_id}] Live2D model switched to: {model_name}")

        except Exception as e:
            logger.error(f"Error switching model: {e}")
            await self._send_error(websocket, str(e))

    def get_session(self, session_id: str) -> Optional[VTuberSession]:
        return self.sessions.get(session_id)

    def get_active_sessions(self) -> int:
        return len(self.sessions)


vtuber_handler = VTuberWebSocketHandler()
