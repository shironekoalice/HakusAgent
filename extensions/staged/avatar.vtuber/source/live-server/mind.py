"""情绪状态机 — 复制自 HakusAI_chat/core/inner_mind.py 的 EmotionalState 裁剪版。
保留核心逻辑：情绪维度（开心/焦虑/好感/精力）、强度自然衰减、维度回归基准线、
上下文文本生成（注入 LLM 提示词，让人格有连续的心情而不是每次从零开始）。
裁剪掉：神经动力学衰减(PyTorch)、昼夜节律表、潜意识联想、自省等陪伴向重模块。
"""
import json
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional

from emotions import EmotionType


@dataclass
class EmotionalState:
    current_emotion: EmotionType = EmotionType.CALM
    intensity: float = 0.5
    happiness: float = 0.5    # 开心程度
    anxiety: float = 0.3      # 焦虑程度
    affection: float = 0.5    # 好感度
    energy: float = 0.7       # 精力/活跃度
    history: List[Dict] = field(default_factory=list)
    last_updated: float = field(default_factory=time.time)

    def update_emotion(self, new_emotion: EmotionType, intensity: float):
        self.current_emotion = new_emotion
        self.intensity = intensity
        self.last_updated = time.time()
        self.history.append({"emotion": new_emotion.value, "intensity": intensity, "timestamp": time.time()})
        if len(self.history) > 100:
            self.history = self.history[-100:]
        # 维度更新（原版逻辑）
        if new_emotion == EmotionType.HAPPY:
            self.happiness = min(1.0, self.happiness + intensity * 0.2)
            self.energy = min(1.0, self.energy + intensity * 0.1)
        elif new_emotion == EmotionType.SAD:
            self.happiness = max(0.0, self.happiness - intensity * 0.2)
            self.energy = max(0.0, self.energy - intensity * 0.15)
        elif new_emotion == EmotionType.ANGRY:
            self.anxiety = min(1.0, self.anxiety + intensity * 0.2)
        elif new_emotion in (EmotionType.EXCITED, EmotionType.TENDER):
            self.affection = min(1.0, self.affection + intensity * 0.15)

    def decay(self):
        """情绪自然衰减（原版固定衰减分支；神经动力学分支为可选重模块未搬入）"""
        self.intensity *= 0.95
        self.happiness += (0.5 - self.happiness) * 0.05
        self.anxiety += (0.3 - self.anxiety) * 0.05
        self.energy += (0.7 - self.energy) * 0.05
        # 精力随时间恢复
        self.energy = min(1.0, self.energy + 0.02)

    def mood_face_baseline(self) -> Dict[str, float]:
        """把心情维度映射为形象表情基线（开心→嘴角上扬，焦虑→眉低，困→眼半闭）"""
        return {
            "mouthForm": (self.happiness - 0.5) * 0.5,
            "brow": -(self.anxiety - 0.3) * 0.4,
            "eyeOpenL": 0.72 + self.energy * 0.28,
            "eyeOpenR": 0.72 + self.energy * 0.28,
        }

    def to_context_string(self) -> str:
        emotion_text = {
            EmotionType.HAPPY: "开心", EmotionType.SAD: "有点难过", EmotionType.ANGRY: "有点生气",
            EmotionType.EXCITED: "很兴奋", EmotionType.CALM: "平静", EmotionType.CONFUSED: "有点困惑",
            EmotionType.TENDER: "心里暖暖的", EmotionType.TSUNDERE: "傲娇中",
        }.get(self.current_emotion, "平静")
        intensity_text = "非常" if self.intensity > 0.8 else ("比较" if self.intensity > 0.5 else "有点")
        energy_text = "精力充沛" if self.energy > 0.8 else ("状态正常" if self.energy > 0.5 else "有点困")
        return (f"【当前心情】{intensity_text}{emotion_text}（{energy_text}，"
                f"好感度: {self.affection*100:.0f}%，开心度: {self.happiness*100:.0f}%）")


class Mind:
    """带持久化的内心状态管理（对应原版 InnerMind 的状态部分）"""

    def __init__(self, storage_dir: str = "./data"):
        self.path = Path(storage_dir) / "mind.json"
        self.state = EmotionalState()
        self._load()
        # 定时衰减
        self._timer = None
        import threading
        def _loop():
            while True:
                time.sleep(60)
                self.state.decay()
                self._save()
        threading.Thread(target=_loop, daemon=True).start()

    def process_interaction(self, emotion: EmotionType, intensity: float):
        """每次互动后更新情绪并持久化"""
        self.state.update_emotion(emotion, intensity)
        self._save()

    def get_inner_context(self) -> str:
        return self.state.to_context_string()

    def mood_payload(self) -> Dict:
        s = self.state
        return {"emotion": s.current_emotion.value, "intensity": round(s.intensity, 2),
                "happiness": round(s.happiness, 2), "anxiety": round(s.anxiety, 2),
                "affection": round(s.affection, 2), "energy": round(s.energy, 2),
                "face": s.mood_face_baseline()}

    def _load(self):
        if self.path.exists():
            try:
                d = json.loads(self.path.read_text(encoding="utf-8"))
                s = self.state
                s.current_emotion = EmotionType(d.get("emotion", "calm"))
                s.intensity = d.get("intensity", 0.5)
                s.happiness = d.get("happiness", 0.5)
                s.anxiety = d.get("anxiety", 0.3)
                s.affection = d.get("affection", 0.5)
                s.energy = d.get("energy", 0.7)
                s.history = d.get("history", [])
            except Exception:
                pass

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.mood_payload() | {"history": self.state.history[-50:]},
                                            ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
