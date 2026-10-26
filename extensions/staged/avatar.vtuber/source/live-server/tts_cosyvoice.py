"""CosyVoice TTS — 复制自 HakusAI_chat/tts/cosyvoice_tts.py 并裁剪为独立版：
- 去掉全局单例/线程锁、NoneBot 生态依赖、safe_fetch 校验
- 直接返回音频 bytes（原来落临时文件）
- 保留声音克隆能力（可选，配置 ref_audio 后自动克隆）
"""
import asyncio
import os
from typing import Optional

import aiohttp
import ssl


class CosyVoiceTTS:
    def __init__(self, cfg: dict, data_dir: str = "."):
        self.api_key = cfg.get("dashscope_api_key", "")
        self.model = cfg.get("model", "cosyvoice-v3-flash")
        self.voice_id = cfg.get("voice_id") or cfg.get("voice", "")
        self.ref_audio = cfg.get("ref_audio", "")
        self.audio_format = cfg.get("format", "mp3")
        self.sample_rate = cfg.get("sample_rate", 22050)
        self.base_url = "dashscope.aliyuncs.com"
        self._voice_cache = os.path.join(data_dir, "cosyvoice_voice_id.txt")
        self.clone_status = "idle"   # idle/running/ok/failed
        self.clone_error = ""
        # 克隆音色缓存优先于配置音色（克隆成功后应自动成为默认声音）
        if os.path.exists(self._voice_cache):
            cached = open(self._voice_cache, encoding="utf-8").read().strip()
            if cached:
                self.voice_id = cached
        self._clone_started = False

    def ensure_voice(self) -> Optional[str]:
        """返回可用音色；需要克隆时触发一次后台克隆"""
        if self.voice_id:
            return self.voice_id
        if "v3.5" in self.model:
            # v3.5-plus 必须用复刻音色
            if self.ref_audio and not self._clone_started:
                self._clone_started = True
                asyncio.get_event_loop().run_in_executor(None, lambda: asyncio.run(self._clone_voice()))
            return None
        return "longanhuan"  # v3-flash 系统音色兜底

    async def generate_audio(self, text: str, instruction: str = None) -> Optional[bytes]:
        if not self.api_key or not text or not text.strip():
            return None
        voice = self.ensure_voice()
        if not voice:
            return None
        input_obj = {"text": text, "voice": voice, "format": self.audio_format,
                     "sample_rate": self.sample_rate}
        if instruction:
            input_obj["instruction"] = instruction
        body = {"model": self.model, "input": input_obj}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        url = f"https://{self.base_url}/api/v1/services/audio/tts/SpeechSynthesizer"
        async with aiohttp.ClientSession() as s:
            async with s.post(url, headers=headers, json=body,
                              timeout=aiohttp.ClientTimeout(total=60)) as r:
                if r.status != 200:
                    print(f"[TTS] 请求失败 {r.status}: {(await r.text())[:200]}")
                    return None
                result = await r.json()
            audio_url = (result.get("output") or {}).get("audio", {}).get("url")
            if not audio_url:
                print(f"[TTS] 无音频URL: {str(result)[:200]}")
                return None
            async with s.get(audio_url, timeout=aiohttp.ClientTimeout(total=60)) as ar:
                if ar.status != 200:
                    return None
                return await ar.read()

    async def _clone_voice(self):
        """参考音频克隆（复制自 HakusAI_chat，逻辑保持一致）"""
        self.clone_status = "running"; self.clone_error = ""
        if self.voice_id and "hakusai" in self.voice_id:
            print(f"[TTS] 已有克隆voice_id，直接查询部署状态: {self.voice_id}")
            return await self._poll_voice()
        print(f"[TTS] 开始声音克隆: {self.ref_audio}")
        if not self.api_key:
            self.clone_status = "failed"; self.clone_error = "缺少 DASHSCOPE_API_KEY"
            print("[TTS] " + self.clone_error); return
        if not os.path.exists(self.ref_audio):
            self.clone_status = "failed"; self.clone_error = f"参考音频不存在: {self.ref_audio}"
            print("[TTS] " + self.clone_error); return
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
        connector = aiohttp.TCPConnector(ssl=ssl_ctx)
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=120)) as s:
                data = aiohttp.FormData()
                data.add_field("purpose", "file-extract")
                data.add_field("files", open(self.ref_audio, "rb"),
                               filename=os.path.basename(self.ref_audio), content_type="audio/wav")
                async with s.post(f"https://{self.base_url}/api/v1/files", headers=headers, data=data) as r:
                    if r.status != 200:
                        self.clone_status = "failed"; self.clone_error = f"上传失败 HTTP {r.status}: {(await r.text())[:200]}"
                        print("[TTS] " + self.clone_error); return
                    file_id = (await r.json())["data"]["uploaded_files"][0]["file_id"]
                async with s.get(f"https://{self.base_url}/api/v1/files/{file_id}", headers=headers) as r:
                    oss_url = (await r.json())["data"]["url"]
                body = {"model": "voice-enrollment", "input": {
                    "action": "create_voice", "target_model": self.model,
                    "prefix": "hakusai", "url": oss_url, "language_hints": ["zh"]}}
                h2 = {**headers, "Content-Type": "application/json"}
                async with s.post(f"https://{self.base_url}/api/v1/services/audio/tts/customization",
                                  headers=h2, json=body) as r:
                    if r.status != 200:
                        self.clone_status = "failed"; self.clone_error = f"创建克隆声音失败 HTTP {r.status}: {(await r.text())[:200]}"
                        print("[TTS] " + self.clone_error); return
                    voice_id = (await r.json()).get("output", {}).get("voice_id", "")
                if not voice_id:
                    self.clone_status = "failed"; self.clone_error = "克隆响应中无voice_id"
                    print("[TTS] " + self.clone_error); return
                await self._poll_voice(s, h2, voice_id)
        except Exception as e:
            self.clone_status = "failed"; self.clone_error = str(e)
            print(f"[TTS] 克隆异常: {e}")

    async def _poll_voice(self, s = None, h2 = None, voice_id = None):
        """轮询克隆部署状态（最长15分钟）；voice_id未传则用当前实例的"""
        own = s is None
        if own:
            ssl_ctx = ssl.create_default_context(); ssl_ctx.check_hostname = False; ssl_ctx.verify_mode = ssl.CERT_NONE
            s = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ssl_ctx))
            h2 = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        voice_id = voice_id or self.voice_id
        url = f"https://{self.base_url}/api/v1/services/audio/tts/customization"
        try:
            for _ in range(180):
                q = {"model": "voice-enrollment", "input": {"action": "query_voice", "voice_id": voice_id}}
                async with s.post(url, headers=h2, json=q) as r:
                    status = (await r.json()).get("output", {}).get("status", "") if r.status == 200 else ""
                if status == "OK":
                    self.voice_id = voice_id
                    self.clone_status = "ok"
                    os.makedirs(os.path.dirname(self._voice_cache), exist_ok=True)
                    open(self._voice_cache, "w", encoding="utf-8").write(voice_id)
                    print(f"[TTS] 声音克隆成功 voice_id={voice_id}")
                    return
                if status in ("FAILED", "ERROR", "UNDEPLOYED"):
                    self.clone_status = "failed"; self.clone_error = f"平台返回状态: {status}"
                    print("[TTS] " + self.clone_error); return
                await asyncio.sleep(5)
            self.clone_status = "timeout"
            self.clone_error = "平台部署超过15分钟，稍后重新保存即可继续查询"
            print("[TTS] " + self.clone_error)
        finally:
            if own: await s.close()
