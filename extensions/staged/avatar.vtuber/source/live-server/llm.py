"""多平台 LLM 适配器 — 复制自 HakusAI_chat/models/base.py 的设计思想：
「新增供应商只需加配置，不用写代码」（全部走 OpenAI 兼容协议），并实现故障自动切换。
原版用 openai SDK 分六平台；这里统一为 aiohttp 直连，按 providers 顺序尝试，失败自动降级。
"""
import time
from typing import List, Dict, Optional, Tuple

import aiohttp


class LLMRouter:
    def __init__(self, providers: List[Dict]):
        # providers: [{name, base_url, api_key, model, priority}]，按优先级排序
        self.providers = sorted(providers, key=lambda p: p.get("priority", 99))
        self.fail_until: Dict[str, float] = {}   # provider -> 熔断恢复时间
        self.COOLDOWN = 120                       # 失败后熔断120秒

    async def chat(self, messages: List[Dict], max_tokens: int = 200,
                   temperature: float = 0.9) -> Tuple[str, str]:
        """返回 (回复文本, 实际使用的provider名)；全部失败抛异常"""
        errors = []
        now = time.time()
        for p in self.providers:
            if self.fail_until.get(p["name"], 0) > now:
                continue
            try:
                text = await self._one(p, messages, max_tokens, temperature)
                return text, p["name"]
            except Exception as e:
                self.fail_until[p["name"]] = now + self.COOLDOWN
                errors.append(f"{p['name']}: {e}")
        raise RuntimeError("所有LLM供应商均失败: " + " | ".join(errors))

    async def _one(self, p: Dict, messages, max_tokens, temperature) -> str:
        body = {"model": p["model"], "messages": messages,
                "max_tokens": max_tokens, "temperature": temperature}
        headers = {"Authorization": f"Bearer {p['api_key']}"}
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{p['base_url']}/chat/completions", headers=headers, json=body,
                              timeout=aiohttp.ClientTimeout(total=60)) as r:
                if r.status != 200:
                    raise RuntimeError(f"HTTP {r.status}")
                data = await r.json()
        return data["choices"][0]["message"]["content"].strip()

    async def embed(self, texts: List[str]) -> Optional[List[List[float]]]:
        """embedding 走当前第一个支持 embedding 的供应商（默认 dashscope）"""
        for p in self.providers:
            if not p.get("embedding_model"):
                continue
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.post(f"{p['base_url']}/embeddings",
                                      headers={"Authorization": f"Bearer {p['api_key']}"},
                                      json={"model": p["embedding_model"], "input": texts},
                                      timeout=aiohttp.ClientTimeout(total=30)) as r:
                        if r.status != 200:
                            continue
                        data = await r.json()
                return [d["embedding"] for d in data["data"]]
            except Exception:
                continue
        return None
