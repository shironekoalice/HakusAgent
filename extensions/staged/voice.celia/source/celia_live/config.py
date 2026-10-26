import os
import re
import json
from dataclasses import dataclass, field
from typing import Optional, Dict, Any

@dataclass
class ASRConfig:
    provider: str = "funasr"
    model: str = "SenseVoiceSmall"
    model_path: str = "models/asr/fun_asr"
    sample_rate: int = 16000
    language: str = "auto"

@dataclass
class VADConfig:
    provider: str = "silero"  # silero / energy
    # Silero VAD 参数
    threshold: float = 0.5
    min_speech_duration: float = 0.25
    min_silence_duration: float = 0.1
    # Energy VAD 参数 (fallback)
    energy_threshold: int = 2000
    silence_timeout: float = 1.2
    min_voice_frames: int = 3
    frame_duration: float = 0.5

@dataclass
class LLMConfig:
    provider: str = "qwen"
    model: str = "qwen-flash"
    api_key: str = ""
    base_url: str = ""
    temperature: float = 0.7
    max_tokens: int = 512
    stream: bool = True

@dataclass
class CosyVoiceConfig:
    model: str = "cosyvoice-v3-flash"
    voice_id: str = "longanhuan"
    ref_audio: str = ""
    instruction: str = ""
    format: str = "mp3"
    sample_rate: int = 22050
    api_key: str = ""
    base_url: str = "dashscope.aliyuncs.com"
    proxy: str = ""

@dataclass
class BertVITS2Config:
    model_path: str = "models/tts/bert_vits2/G_1500.pth"
    config_path: str = "models/tts/bert_vits2/config.json"
    gen_config_path: str = "configs/gen_config.json"
    speaker: str = "sigewinne"
    sample_rate: int = 22050

@dataclass
class SherpaOnnxConfig:
    model_dir: str = "./tts_models"
    voice: str = "zh"
    speed: float = 1.0
    volume: float = 1.0
    pitch: float = 1.0
    audio_format: str = "wav"
    sample_rate: int = 24000
    device: str = "cpu"

@dataclass
class TTSConfig:
    provider: str = "bert-vits2"  # cosyvoice / bert_vits2 / sherpa_onnx
    model_path: str = ""
    voice_id: str = "sigewinne"
    sample_rate: int = 22050
    output_dir: str = "./output"
    # 子配置
    cosyvoice: CosyVoiceConfig = field(default_factory=CosyVoiceConfig)
    bert_vits2: BertVITS2Config = field(default_factory=BertVITS2Config)
    sherpa_onnx: SherpaOnnxConfig = field(default_factory=SherpaOnnxConfig)

@dataclass
class BilibiliLiveConfig:
    uid: int = 0
    sessdata: str = ""
    bili_jct: str = ""
    buvid3: str = ""
    ac_time_value: str = ""
    dedeuserid: str = ""

@dataclass
class LiveConfig:
    enabled: bool = False
    platform: str = "bilibili"
    room_id: str = ""
    cookie: str = ""
    bilibili: BilibiliLiveConfig = field(default_factory=BilibiliLiveConfig)
    aggregation_window: float = 5.0
    proactive_idle_timeout: float = 30.0
    proactive_min_interval: float = 60.0

@dataclass
class AvatarConfig:
    enabled: bool = False
    type: str = "live2d"  # live2d / vrm
    model_path: str = ""
    animations_path: str = ""
    model_name: str = "Cerydra"  # Cerydra / Hiyori
    background: str = "default"  # default / warm / cool / particle

@dataclass
class AudioOutputConfig:
    virtual_cable: bool = False
    cable_device: str = ""  # VB-Cable 设备名，如 "CABLE Input"
    speaker_device: str = ""  # 默认扬声器设备名，空表示系统默认

@dataclass
class FrontendConfig:
    host: str = "0.0.0.0"
    port: int = 12393

@dataclass
class Config:
    asr: ASRConfig = field(default_factory=ASRConfig)
    vad: VADConfig = field(default_factory=VADConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    tts: TTSConfig = field(default_factory=TTSConfig)
    live: LiveConfig = field(default_factory=LiveConfig)
    avatar: AvatarConfig = field(default_factory=AvatarConfig)
    audio_output: AudioOutputConfig = field(default_factory=AudioOutputConfig)
    frontend: FrontendConfig = field(default_factory=FrontendConfig)

    character_name: str = "羽汐"
    character_prompt: str = ""
    log_level: str = "INFO"

    @classmethod
    def from_file(cls, path: str = "config.json") -> "Config":
        """从文件加载配置，支持 JSON 和 YAML"""
        if not os.path.exists(path):
            return cls()

        ext = os.path.splitext(path)[1].lower()
        if ext in ('.yaml', '.yml'):
            return cls.from_yaml(path)
        else:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return cls.from_dict(data)

    @classmethod
    def _resolve_env_vars(cls, value: Any, max_iterations: int = 10) -> Any:
        """解析环境变量，支持 ${ENV_VAR:default_value} 格式（参照 HakusAI_chat 实现）"""
        if isinstance(value, str):
            def replace_once(text):
                start = text.find('${')
                if start == -1:
                    return text
                # 平衡括号匹配
                depth = 0
                end = -1
                i = start
                while i < len(text):
                    if text[i:i+2] == '${':
                        depth += 1
                        i += 2
                    elif text[i] == '}':
                        depth -= 1
                        if depth == 0:
                            end = i
                            break
                        i += 1
                    else:
                        i += 1
                if end == -1:
                    return text
                expr = text[start+2:end]
                colon_pos = expr.find(':')
                if colon_pos == -1:
                    var_name = expr
                    default_val = ""
                else:
                    var_name = expr[:colon_pos]
                    default_val = expr[colon_pos+1:]
                env_value = os.environ.get(var_name)
                replacement = env_value if env_value is not None else default_val
                return text[:start] + replacement + text[end+1:]

            for _ in range(max_iterations):
                new_value = replace_once(value)
                if new_value == value:
                    break
                value = new_value
            return value
        elif isinstance(value, dict):
            return {k: cls._resolve_env_vars(v, max_iterations) for k, v in value.items()}
        elif isinstance(value, list):
            return [cls._resolve_env_vars(item, max_iterations) for item in value]
        return value

    @classmethod
    def from_yaml(cls, path: str) -> "Config":
        """从 YAML 文件加载配置"""
        import yaml
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        # 解析 ${ENV_VAR:default_value} 格式的环境变量
        data = cls._resolve_env_vars(data)
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        """从字典创建配置，兼容 JSON 和 YAML 两种格式"""
        config = cls()

        # character: 支持 YAML 的 character.name/prompt 和 JSON 的 character_name/prompt
        if "character" in data:
            char = data["character"]
            if isinstance(char, dict):
                config.character_name = char.get("name", config.character_name)
                config.character_prompt = char.get("prompt", config.character_prompt)

        # ASR: YAML 中 model_path 对应 JSON 中的 model
        if "asr" in data:
            asr_data = data["asr"]
            # 兼容：JSON 中 "model" 字段映射到 model_path
            if "model" in asr_data and "model_path" not in asr_data:
                asr_data["model_path"] = asr_data.pop("model")
            config.asr = ASRConfig(**{k: v for k, v in asr_data.items() if k in ASRConfig.__dataclass_fields__})

        # VAD
        if "vad" in data:
            config.vad = VADConfig(**{k: v for k, v in data["vad"].items() if k in VADConfig.__dataclass_fields__})

        # LLM
        if "llm" in data:
            config.llm = LLMConfig(**{k: v for k, v in data["llm"].items() if k in LLMConfig.__dataclass_fields__})

        # TTS: 处理嵌套子配置
        if "tts" in data:
            tts_data = dict(data["tts"])
            # 提取子配置
            cosyvoice_data = tts_data.pop("cosyvoice", {})
            bert_vits2_data = tts_data.pop("bert_vits2", {})
            sherpa_onnx_data = tts_data.pop("sherpa_onnx", {})

            config.tts = TTSConfig(**{k: v for k, v in tts_data.items() if k in TTSConfig.__dataclass_fields__})

            if isinstance(cosyvoice_data, dict) and cosyvoice_data:
                config.tts.cosyvoice = CosyVoiceConfig(**{k: v for k, v in cosyvoice_data.items() if k in CosyVoiceConfig.__dataclass_fields__})
            if isinstance(bert_vits2_data, dict) and bert_vits2_data:
                config.tts.bert_vits2 = BertVITS2Config(**{k: v for k, v in bert_vits2_data.items() if k in BertVITS2Config.__dataclass_fields__})
            if isinstance(sherpa_onnx_data, dict) and sherpa_onnx_data:
                config.tts.sherpa_onnx = SherpaOnnxConfig(**{k: v for k, v in sherpa_onnx_data.items() if k in SherpaOnnxConfig.__dataclass_fields__})

        # Live: 处理嵌套 bilibili 配置
        if "live" in data:
            live_data = dict(data["live"])
            bilibili_data = live_data.pop("bilibili", {})
            config.live = LiveConfig(**{k: v for k, v in live_data.items() if k in LiveConfig.__dataclass_fields__})
            if isinstance(bilibili_data, dict) and bilibili_data:
                config.live.bilibili = BilibiliLiveConfig(**{k: v for k, v in bilibili_data.items() if k in BilibiliLiveConfig.__dataclass_fields__})

        # Avatar
        if "avatar" in data:
            config.avatar = AvatarConfig(**{k: v for k, v in data["avatar"].items() if k in AvatarConfig.__dataclass_fields__})

        # AudioOutput
        if "audio_output" in data:
            config.audio_output = AudioOutputConfig(**{k: v for k, v in data["audio_output"].items() if k in AudioOutputConfig.__dataclass_fields__})

        # Frontend
        if "frontend" in data:
            config.frontend = FrontendConfig(**{k: v for k, v in data["frontend"].items() if k in FrontendConfig.__dataclass_fields__})

        # 顶层字段（兼容旧 JSON 格式）
        for key in ["character_name", "character_prompt", "log_level"]:
            if key in data:
                setattr(config, key, data[key])

        # logging.level -> log_level
        if "logging" in data and isinstance(data["logging"], dict):
            config.log_level = data["logging"].get("level", config.log_level)

        return config

    def to_dict(self) -> dict:
        """将配置序列化为字典"""
        def _dataclass_to_dict(obj):
            if hasattr(obj, '__dataclass_fields__'):
                return {k: _dataclass_to_dict(v) for k, v in obj.__dict__.items()}
            return obj

        return {
            "character": {
                "name": self.character_name,
                "prompt": self.character_prompt,
            },
            "asr": _dataclass_to_dict(self.asr),
            "vad": _dataclass_to_dict(self.vad),
            "llm": _dataclass_to_dict(self.llm),
            "tts": _dataclass_to_dict(self.tts),
            "live": _dataclass_to_dict(self.live),
            "avatar": _dataclass_to_dict(self.avatar),
            "character_name": self.character_name,
            "character_prompt": self.character_prompt,
            "log_level": self.log_level,
        }
