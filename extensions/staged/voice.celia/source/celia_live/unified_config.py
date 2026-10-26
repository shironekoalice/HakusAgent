"""统一配置加载器 - 支持 YAML 优先，JSON 回退，自动迁移"""
import os
import json
import logging
import yaml
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 配置文件路径
YAML_CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.yaml")
JSON_CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.json")


def resolve_env_vars(value: Any, max_iterations: int = 10) -> Any:
    """解析环境变量，支持 ${ENV_VAR:default_value} 格式，支持嵌套变量递归解析"""
    if isinstance(value, str):
        import re

        def replace_once(text):
            """单次替换，支持嵌套变量的平衡括号匹配"""
            start = text.find('${')
            if start == -1:
                return text

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
        return {k: resolve_env_vars(v, max_iterations) for k, v in value.items()}
    elif isinstance(value, list):
        return [resolve_env_vars(item, max_iterations) for item in value]
    return value


def load_yaml(path: str) -> Dict[str, Any]:
    """加载 YAML 配置文件"""
    with open(path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    return data if data else {}


def load_json(path: str) -> Dict[str, Any]:
    """加载 JSON 配置文件"""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data


def _migrate_json_to_yaml(json_path: str, yaml_path: str) -> Dict[str, Any]:
    """将 config.json 迁移为 config.yaml，保留原有值"""
    json_data = load_json(json_path)
    # 加载 YAML 模板（如果存在的话用模板结构，否则直接写 JSON 内容）
    if os.path.exists(yaml_path):
        yaml_data = load_yaml(yaml_path)
    else:
        yaml_data = {}

    # 将 JSON 中的值合并到 YAML 结构中
    _merge_json_into_yaml(json_data, yaml_data)

    # 写入 YAML 文件
    with open(yaml_path, 'w', encoding='utf-8') as f:
        yaml.dump(yaml_data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    logger.info(f"已将 {json_path} 迁移为 {yaml_path}")
    return yaml_data


def _merge_json_into_yaml(json_data: dict, yaml_data: dict) -> None:
    """将 JSON 数据中的值合并到 YAML 结构中（就地修改 yaml_data）"""
    # character_name -> character.name
    if "character_name" in json_data:
        yaml_data.setdefault("character", {})["name"] = json_data["character_name"]

    # character_prompt -> character.prompt
    if "character_prompt" in json_data:
        yaml_data.setdefault("character", {})["prompt"] = json_data["character_prompt"]

    # asr
    if "asr" in json_data:
        asr = json_data["asr"]
        yaml_asr = yaml_data.setdefault("asr", {})
        if "provider" in asr:
            yaml_asr["provider"] = asr["provider"]
        if "model" in asr:
            yaml_asr["model_path"] = asr["model"]
        if "sample_rate" in asr:
            yaml_asr["sample_rate"] = asr["sample_rate"]

    # llm
    if "llm" in json_data:
        llm = json_data["llm"]
        yaml_llm = yaml_data.setdefault("llm", {})
        if "provider" in llm:
            yaml_llm["provider"] = llm["provider"]
        if "model" in llm:
            yaml_llm["model"] = llm["model"]
        if "api_key" in llm:
            yaml_llm["api_key"] = llm["api_key"]

    # tts
    if "tts" in json_data:
        tts = json_data["tts"]
        yaml_tts = yaml_data.setdefault("tts", {})
        if "provider" in tts:
            yaml_tts["provider"] = tts["provider"]
        if "voice_id" in tts:
            # 根据 provider 分配 voice_id
            provider = tts.get("provider", "bert_vits2")
            if provider == "bert_vits2" or provider == "bert-vits2":
                yaml_tts.setdefault("bert_vits2", {})["speaker"] = tts["voice_id"]
            else:
                yaml_tts.setdefault(provider, {})["voice_id"] = tts["voice_id"]
        if "output_dir" in tts:
            yaml_tts["output_dir"] = tts["output_dir"]

    # live
    if "live" in json_data:
        live = json_data["live"]
        yaml_live = yaml_data.setdefault("live", {})
        if "enabled" in live:
            yaml_live["enabled"] = live["enabled"]
        if "platform" in live:
            yaml_live["platform"] = live["platform"]
        if "room_id" in live:
            yaml_live["room_id"] = live["room_id"]

    # avatar
    if "avatar" in json_data:
        avatar = json_data["avatar"]
        yaml_avatar = yaml_data.setdefault("avatar", {})
        if "enabled" in avatar:
            yaml_avatar["enabled"] = avatar["enabled"]
        if "type" in avatar:
            yaml_avatar["type"] = avatar["type"]

    # log_level -> logging.level
    if "log_level" in json_data:
        yaml_data.setdefault("logging", {})["level"] = json_data["log_level"]


def load_unified_config(yaml_path: str = YAML_CONFIG_PATH,
                        json_path: str = JSON_CONFIG_PATH) -> Dict[str, Any]:
    """
    加载统一配置：
    1. 优先加载 config.yaml
    2. 如果 YAML 不存在但 JSON 存在，自动迁移
    3. 如果都不存在，返回空配置
    """
    yaml_exists = os.path.exists(yaml_path)
    json_exists = os.path.exists(json_path)

    if yaml_exists:
        data = load_yaml(yaml_path)
        logger.debug(f"从 YAML 加载配置: {yaml_path}")
    elif json_exists:
        # 自动迁移：JSON -> YAML
        logger.info(f"config.yaml 不存在，从 config.json 自动迁移...")
        data = _migrate_json_to_yaml(json_path, yaml_path)
    else:
        logger.warning("未找到 config.yaml 或 config.json，使用默认配置")
        data = {}

    # 解析环境变量
    data = resolve_env_vars(data)
    return data


# ==================== Agent BASE_CONFIG 兼容层 ====================

def convert_value(value: str, key: str) -> Any:
    """根据 key 转换配置值为正确的类型"""
    bool_keys = ['ENABLED', 'AUDIO_OUTPUT', 'ENABLE_IMAGE_GENERATION']
    if any(key.endswith(bk) for bk in bool_keys):
        return str(value).lower() in ('true', '1', 'yes', 'on')

    int_keys = ['THREAD_COUNT', 'BATCH_SIZE', 'SHORT_TERM_MAX_LENGTH',
                'LONG_TERM_MAX_LENGTH', 'SAMPLE_RATE']
    if any(key.endswith(ik) for ik in int_keys):
        try:
            return int(value)
        except (ValueError, TypeError):
            return value

    float_keys = ['SPEED', 'VOLUME', 'PITCH']
    if any(key.endswith(fk) for fk in float_keys):
        try:
            return float(value)
        except (ValueError, TypeError):
            return value

    return value


def build_agent_base_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    从统一配置构建 agent 所需的 BASE_CONFIG 字典。
    保持与原 agent/utils/config.py 中 BASE_CONFIG 的完全兼容。
    """
    agent_cfg = config.get("agent", {})
    api_keys = agent_cfg.get("api_keys", {})
    models = agent_cfg.get("models", {})
    embedding = agent_cfg.get("embedding", {})
    memory = agent_cfg.get("memory", {})
    tts_cfg = config.get("tts", {})
    features = agent_cfg.get("features", {})
    github = agent_cfg.get("github", {})
    qzone = agent_cfg.get("qzone", {})
    trading = agent_cfg.get("trading", {})

    base_config = {
        # API Keys
        "GEMINI_API_KEY": api_keys.get("gemini_api_key", ""),
        "GOOGLE_API_KEY": api_keys.get("google_api_key", ""),
        "GOOGLE_CSE_ID": api_keys.get("google_cse_id", ""),
        "DASHSCOPE_API_KEY": api_keys.get("dashscope_api_key", ""),
        "DEEPSEEK_API_KEY": api_keys.get("deepseek_api_key", ""),
        "DEEPSEEK_BASE_URL": models.get("deepseek", {}).get("base_url", "https://api.deepseek.com/v1"),
        "GLM_API_KEY": api_keys.get("glm_api_key", ""),
        "OPENAI_API_KEY": api_keys.get("openai_api_key", ""),
        "MIMO_API_KEY": api_keys.get("mimo_api_key", ""),

        # Models
        "DEFAULT_MODEL": models.get("default_model", "deepseek"),
        "GEMINI_MODEL_NAME": models.get("gemini", {}).get("model_name", "gemini-2.5-flash"),
        "QWEN_MODEL_NAME": models.get("qwen", {}).get("model_name", "qwen-flash"),
        "DEEPSEEK_MODEL_NAME": models.get("deepseek", {}).get("model_name", "deepseek-v4-flash"),
        "GLM_MODEL_NAME": models.get("glm", {}).get("model_name", "glm-4-flash"),
        "MIMO_MODEL_NAME": models.get("mimo", {}).get("model_name", "mimo-v2.5"),
        "MIMO_BASE_URL": models.get("mimo", {}).get("base_url", "https://api.xiaomimimo.com/v1"),

        # Embedding
        "EMBEDDING_TYPE": embedding.get("type", "dashscope"),
        "EMBEDDING_MODEL_PATH": embedding.get("model_path", "shibing624/text2vec-base-chinese"),
        "LOCAL_EMBEDDING_MODEL_PATH": embedding.get("local_model_path", "./embedding_models/text2vec-base-chinese"),
        "EMBEDDING_DEVICE": embedding.get("device", "cpu"),
        "CPU_THREAD_COUNT": convert_value(embedding.get("thread_count", 4), "THREAD_COUNT"),
        "EMBEDDING_BATCH_SIZE": convert_value(embedding.get("batch_size", 8), "BATCH_SIZE"),
        "OPENAI_EMBEDDING_MODEL": embedding.get("openai_model", "text-embedding-3-small"),
        "GLM_EMBEDDING_MODEL": embedding.get("glm_model", "embedding-3"),
        "DASHSCOPE_EMBEDDING_MODEL": embedding.get("dashscope_model", "text-embedding-v2"),
        "OPENAI_BASE_URL": api_keys.get("openai_base_url", ""),

        # Memory
        "SHORT_TERM_MEMORY_MAX_LENGTH": convert_value(
            memory.get("short_term", {}).get("max_messages", 50), "SHORT_TERM_MAX_LENGTH"),
        "LONG_TERM_MEMORY_MAX_LENGTH": convert_value(
            memory.get("long_term", {}).get("max_length", 500), "LONG_TERM_MAX_LENGTH"),
        "STATE_DIR": os.path.abspath(memory.get("state_dir", "./user_states")),
        "MEMORY_DB_DIR": os.path.abspath(memory.get("db_dir", "./hakusai_memory_db")),

        # TTS (从统一 tts 配置读取)
        "ENABLE_TTS": True,
        "ENABLE_TTS_AUDIO_OUTPUT": True,
        "TTS_TYPE": tts_cfg.get("provider", "sherpa_onnx"),
        "TTS_API_TYPE": tts_cfg.get("cosyvoice", {}).get("model", "qwen"),
        "TTS_VOICE_ID": tts_cfg.get("cosyvoice", {}).get("voice_id", ""),
        "SHERPA_ONNX_MODEL_DIR": tts_cfg.get("sherpa_onnx", {}).get("model_dir", "./tts_models"),
        "SHERPA_ONNX_VOICE": tts_cfg.get("sherpa_onnx", {}).get("voice", "zh"),
        "SHERPA_ONNX_SPEED": convert_value(tts_cfg.get("sherpa_onnx", {}).get("speed", 1.0), "SPEED"),
        "SHERPA_ONNX_VOLUME": convert_value(tts_cfg.get("sherpa_onnx", {}).get("volume", 1.0), "VOLUME"),
        "SHERPA_ONNX_PITCH": convert_value(tts_cfg.get("sherpa_onnx", {}).get("pitch", 1.0), "PITCH"),
        "SHERPA_ONNX_AUDIO_FORMAT": tts_cfg.get("sherpa_onnx", {}).get("audio_format", "wav"),
        "SHERPA_ONNX_SAMPLE_RATE": convert_value(tts_cfg.get("sherpa_onnx", {}).get("sample_rate", 24000), "SAMPLE_RATE"),
        "SHERPA_ONNX_DEVICE": tts_cfg.get("sherpa_onnx", {}).get("device", "cpu"),

        # Features
        "ENABLE_IMAGE_GENERATION": convert_value(
            features.get("enable_image_generation", False), "ENABLE_IMAGE_GENERATION"),

        # GitHub
        "GITHUB_TOKEN": github.get("token", ""),
        "GITHUB_REPO_OWNER": github.get("repo_owner", ""),
        "GITHUB_REPO_NAME": github.get("repo_name", ""),
        "GITHUB_BRANCH": github.get("branch", "main"),
        "GITHUB_POSTS_PATH": github.get("posts_path", "source/_posts"),

        # Qzone
        "QZONE_COOKIES": qzone.get("cookies", ""),

        # Trading
        "TRADING_API_KEY": trading.get("api_key", "") or api_keys.get("deepseek_api_key", ""),
        "TRADING_API_BASE": trading.get("api_base", "https://api.deepseek.com/v1"),
        "TRADING_MODEL": trading.get("model", "deepseek-v4-flash"),
        "TRADING_REASONING": convert_value(trading.get("reasoning", False), "ENABLED"),
        "TRADING_REASONING_EFFORT": trading.get("reasoning_effort", "high"),
        "TRADING_TIMEOUT": convert_value(trading.get("timeout", 120), "THREAD_COUNT"),

        # Logging
        "LOG_LEVEL": getattr(logging, config.get("logging", {}).get("level", "INFO").upper(), logging.INFO),
    }

    return base_config


def get_autopublish_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """从统一配置获取自动发布配置"""
    return config.get("agent", {}).get("autopublish", {})


# 创建必要的目录
def ensure_dirs(base_config: Dict[str, Any]) -> None:
    """确保配置中引用的目录存在"""
    for dir_path in [base_config.get("STATE_DIR", ""), base_config.get("MEMORY_DB_DIR", "")]:
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
