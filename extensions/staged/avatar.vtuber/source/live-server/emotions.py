"""情感与动作定义 — 复制自 HakusAI_chat/core/inner_mind.py 的 EmotionType 并裁剪，
新增直播动作原语（motion primitives）供 LLM 标签驱动 Live2D。"""
from enum import Enum


class EmotionType(str, Enum):
    HAPPY = "happy"
    EXCITED = "excited"
    SURPRISED = "surprised"
    SAD = "sad"
    ANGRY = "angry"
    TSUNDERE = "tsundere"
    TENDER = "tender"
    CONFUSED = "confused"
    CALM = "calm"


# EmotionType -> CosyVoice instruct（复制自 HakusAI_chat tts/cosyvoice_tts.py 的
# get_instruction_for_emotion()，v3-flash 系统音色支持的7种情感值）
EMOTION_INSTRUCT = {
    EmotionType.HAPPY:     "你正在进行闲聊对话，你说话的情感是happy。",
    EmotionType.EXCITED:   "你正在进行闲聊对话，你说话的情感是happy。",
    EmotionType.SURPRISED: "你正在进行闲聊对话，你说话的情感是surprised。",
    EmotionType.SAD:       "你正在进行闲聊对话，你说话的情感是sad。",
    EmotionType.ANGRY:     "你正在进行闲聊对话，你说话的情感是angry。",
    EmotionType.TSUNDERE:  "你正在进行闲聊对话，你说话的情感是angry。",
    EmotionType.CONFUSED:  "你正在进行闲聊对话，你说话的情感是surprised。",
    EmotionType.TENDER:    "你正在进行闲聊对话，你说话的情感是neutral。",
    EmotionType.CALM:      "你正在进行闲聊对话，你说话的情感是neutral。",
}

# 动作原语：LLM 可在情感标签里附加，前端会执行对应的参数关键帧序列
MOTIONS = ["nod", "shake", "tilt", "bounce", "lean", "stretch", "wave"]
