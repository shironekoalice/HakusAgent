"""B站直播弹幕接入 — 基于 blivedm（Celia/Open-LLM-VTuber 同款方案）。
把弹幕转成 chat 事件喂给主循环，带限流（冷却+每分钟上限）防止弹幕刷屏打爆LLM。
配置 config.yaml:  bilibili: {enabled, room_id, cooldown_sec, max_per_min}
"""
import asyncio
import time
from typing import Callable, Optional

from config_loader import CFG

_dm = None


class DanmakuBridge:
    def __init__(self, room_id: int, on_msg: Callable[[str, str], None],
                 cooldown_sec: float = 2.0, max_per_min: int = 12):
        self.room_id = room_id
        self.on_msg = on_msg
        self.cooldown = cooldown_sec
        self.max_per_min = max_per_min
        self._last = 0.0
        self._timestamps: list = []
        self._client = None

    async def run(self):
        import blivedm
        import blivedm.models.web as web_models

        class Handler(blivedm.BaseHandle):
            async def _on_danmaku(self, client, command):
                m: web_models.DanmakuMessage = command.info[1]
                self.outer._dispatch(m.uname, m.msg)

        h = Handler()
        h.outer = self
        self._client = blivedm.BLiveClient(self.room_id)
        self._client.add_handler(h)
        self._client.start()
        print(f"[弹幕] 已连接B站房间 {self.room_id}")
        try:
            while True:
                await asyncio.sleep(3600)
        finally:
            self._client.stop()

    def _dispatch(self, uname: str, msg: str):
        now = time.time()
        if now - self._last < self.cooldown:
            return
        self._timestamps = [t for t in self._timestamps if now - t < 60]
        if len(self._timestamps) >= self.max_per_min:
            return
        self._last = now
        self._timestamps.append(now)
        self.on_msg(uname, msg)


def start_if_configured(on_msg) -> Optional[asyncio.Task]:
    b = CFG.get("bilibili") or {}
    if not (b.get("enabled") and b.get("room_id")):
        return None
    bridge = DanmakuBridge(int(b["room_id"]), on_msg,
                           b.get("cooldown_sec", 2.0), b.get("max_per_min", 12))
    return asyncio.ensure_future(bridge.run())
