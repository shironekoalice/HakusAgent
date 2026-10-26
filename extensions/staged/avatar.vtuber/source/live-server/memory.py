"""长期记忆 — 参考 HakusAI_chat 的向量记忆思路（Chroma/Faiss），
改为零依赖实现：DashScope text-embedding + JSON 持久化 + 余弦检索。
用途：记住观众说过的事（名字/喜好/梗），在相关对话时自动召回注入上下文。
"""
import json
import math
import time
from pathlib import Path
from typing import List, Dict, Optional

MEM_FILE = Path(__file__).parent / "data" / "memory.json"
TOP_K = 3
SIM_THRESHOLD = 0.55


class Memory:
    def __init__(self, embed_fn):
        self.embed_fn = embed_fn          # async fn(texts) -> [[float]]
        self.items: List[Dict] = []       # {text, vec, ts, user, kind}
        self._load()

    def _load(self):
        if MEM_FILE.exists():
            try:
                self.items = json.loads(MEM_FILE.read_text(encoding="utf-8"))
            except Exception:
                self.items = []

    def _save(self):
        try:
            MEM_FILE.parent.mkdir(parents=True, exist_ok=True)
            MEM_FILE.write_text(json.dumps(self.items[-2000:], ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    async def recall(self, query: str) -> List[str]:
        """召回与query最相关的TOP_K条记忆"""
        if not self.items:
            return []
        vecs = await self.embed_fn([query])
        if not vecs:
            return []
        q = vecs[0]
        scored = []
        for it in self.items:
            if "vec" not in it:
                continue
            sim = _cos(q, it["vec"])
            if sim >= SIM_THRESHOLD:
                scored.append((sim, it))
        scored.sort(key=lambda x: -x[0])
        return [f"{it['text']}（{time.strftime('%m-%d', time.localtime(it['ts']))}）"
                for _, it in scored[:TOP_K]]

    async def remember(self, text: str, user: str = "", kind: str = "fact") -> bool:
        """写入一条记忆（自动向量化）"""
        if not text.strip():
            return False
        vecs = await self.embed_fn([text])
        if not vecs:
            return False
        self.items.append({"text": text.strip(), "vec": vecs[0], "ts": time.time(),
                           "user": user, "kind": kind})
        self._save()
        return True


def _cos(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1e-9
    nb = math.sqrt(sum(y * y for y in b)) or 1e-9
    return dot / (na * nb)


# —— 简单的记忆价值判断（哪些弹幕值得记） ——
REMEMBER_PATTERNS = ["我叫", "我喜欢", "我讨厌", "记住", "我是", "我住在", "我生日", "别忘", "我的名字"]


def worth_remembering(text: str) -> bool:
    return any(p in text for p in REMEMBER_PATTERNS) or (len(text) >= 12 and "？" not in text)
