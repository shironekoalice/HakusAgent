import asyncio
import json
import time
import threading
import random
from typing import Optional, Callable, List
from dataclasses import dataclass
from abc import ABC, abstractmethod

@dataclass
class Danmaku:
    username: str
    content: str
    timestamp: float
    uid: str = ""
    medal_level: int = 0
    medal_name: str = ""
    is_gift: bool = False
    gift_name: str = ""
    gift_count: int = 0
    guard_level: int = 0  # 大航海等级（0=普通, 1=总督, 2=提督, 3=舰长）
    # 扩展数据（动态添加，不在 dataclass 中定义）
    # gift_data: dict  # 礼物原始数据
    # sc_data: dict     # SC 原始数据
    # guard_data: dict  # 大航海原始数据

class LivePlatform(ABC):
    @abstractmethod
    async def connect(self): pass
    
    @abstractmethod
    async def disconnect(self): pass
    
    @abstractmethod
    async def get_danmaku(self) -> List[Danmaku]: pass

class BilibiliLive(LivePlatform):
    """使用 bilibili-api-python 的 LiveDanmaku 接收直播间事件"""

    def __init__(self, room_id: str, credential=None):
        """
        Args:
            room_id: 直播间号
            credential: bilibili_api.Credential 对象，None 表示匿名连接
        """
        self.room_id = room_id
        self.credential = credential
        self._room = None  # bilibili_api.live.LiveDanmaku 实例
        self._running = False
        self._danmaku_queue = []
        self._gift_queue = []
        self._sc_queue = []
        self._guard_queue = []
        self._entry_queue = []
        self._reconnect_attempts = 0
        self._max_reconnect_interval = 60

    async def connect(self):
        """连接直播间"""
        try:
            from bilibili_api import live

            # 创建 LiveDanmaku 实例
            self._room = live.LiveDanmaku(int(self.room_id), credential=self.credential)

            # 注册事件处理器
            self._register_handlers()

            # 启动连接
            await self._room.connect()
            self._running = True
            self._reconnect_attempts = 0
            print(f"已连接到 B站直播间: {self.room_id}")

        except Exception as e:
            print(f"连接直播间失败: {e}")
            await self._schedule_reconnect()

    def _register_handlers(self):
        """注册各类事件处理器"""

        @self._room.on("DANMU_MSG")
        async def on_danmaku(event):
            """弹幕事件"""
            try:
                info = event.get("data", {}).get("info", [])
                if len(info) >= 2:
                    content = info[1] if info[1] else ""
                    username = info[2][1] if len(info) > 2 and len(info[2]) > 1 else "未知"
                    uid = str(info[2][0]) if len(info) > 2 and len(info[2]) > 0 else ""

                    # 粉丝牌信息
                    medal_level = 0
                    medal_name = ""
                    if len(info) > 3 and info[3]:
                        medal_level = info[3][0] if info[3][0] else 0
                        medal_name = info[3][1] if len(info[3]) > 1 and info[3][1] else ""

                    # 大航海等级
                    guard_level = 0
                    if len(info) > 7 and info[7]:
                        guard_level = info[7] if info[7] else 0

                    danmaku = Danmaku(
                        username=username,
                        content=content,
                        timestamp=time.time(),
                        uid=uid,
                        medal_level=medal_level,
                        medal_name=medal_name,
                    )
                    danmaku.guard_level = guard_level
                    self._danmaku_queue.append(danmaku)
            except Exception as e:
                print(f"解析弹幕事件失败: {e}")

        @self._room.on("SEND_GIFT")
        async def on_gift(event):
            """礼物事件"""
            try:
                data = event.get("data", {}).get("data", {})
                if not data:
                    data = event.get("data", {})
                danmaku = Danmaku(
                    username=data.get("uname", "未知"),
                    content=f"送出了 {data.get('giftName', '礼物')}",
                    timestamp=time.time(),
                    uid=str(data.get("uid", "")),
                    is_gift=True,
                    gift_name=data.get("giftName", ""),
                    gift_count=data.get("num", 1),
                )
                # 保存礼物原始数据供回调使用
                danmaku.gift_data = {
                    "gift_name": data.get("giftName", ""),
                    "gift_count": data.get("num", 1),
                    "coin_type": data.get("coin_type", "gold"),
                    "total_coin": data.get("total_coin", 0),
                    "price": data.get("price", 0),
                }
                self._gift_queue.append(danmaku)
            except Exception as e:
                print(f"解析礼物事件失败: {e}")

        @self._room.on("SUPER_CHAT_MESSAGE")
        async def on_super_chat(event):
            """醒目留言（SC）事件"""
            try:
                data = event.get("data", {}).get("data", {})
                if not data:
                    data = event.get("data", {})
                danmaku = Danmaku(
                    username=data.get("user_info", {}).get("uname", "未知"),
                    content=data.get("message", ""),
                    timestamp=time.time(),
                    uid=str(data.get("uid", "")),
                )
                # 保存 SC 原始数据
                danmaku.sc_data = {
                    "message": data.get("message", ""),
                    "price": data.get("price", 0),
                    "duration": data.get("time", 60),
                    "background_color": data.get("background_color", "#FFB300"),
                    "user_face": data.get("user_info", {}).get("face", ""),
                }
                self._sc_queue.append(danmaku)
            except Exception as e:
                print(f"解析 SC 事件失败: {e}")

        @self._room.on("GUARD_BUY")
        async def on_guard(event):
            """大航海购买事件"""
            try:
                data = event.get("data", {}).get("data", {})
                if not data:
                    data = event.get("data", {})
                guard_level = data.get("guard_level", 0)
                guard_names = {1: "总督", 2: "提督", 3: "舰长"}
                guard_name = guard_names.get(guard_level, "大航海")
                danmaku = Danmaku(
                    username=data.get("username", "未知"),
                    content=f"开通了 {guard_name}",
                    timestamp=time.time(),
                    uid=str(data.get("uid", "")),
                )
                danmaku.guard_data = {
                    "guard_level": guard_level,
                    "guard_name": guard_name,
                    "num": data.get("num", 1),
                }
                self._guard_queue.append(danmaku)
            except Exception as e:
                print(f"解析大航海事件失败: {e}")

        @self._room.on("INTERACT_WORD")
        async def on_interact(event):
            """用户进场/关注事件"""
            try:
                data = event.get("data", {}).get("data", {})
                if not data:
                    data = event.get("data", {})
                msg_type = data.get("msg_type", 0)
                if msg_type == 1:  # 进入直播间
                    danmaku = Danmaku(
                        username=data.get("uname", "未知"),
                        content="进入直播间",
                        timestamp=time.time(),
                        uid=str(data.get("uid", "")),
                    )
                    self._entry_queue.append(danmaku)
            except Exception as e:
                print(f"解析进场事件失败: {e}")

    async def _schedule_reconnect(self):
        """断线重连（指数退避）"""
        if not self._running:
            return

        self._reconnect_attempts += 1
        # 指数退避：5s -> 10s -> 20s -> 40s -> 60s
        interval = min(5 * (2 ** (self._reconnect_attempts - 1)), self._max_reconnect_interval)
        print(f"[直播] {interval}秒后重连（第 {self._reconnect_attempts} 次）...")
        await asyncio.sleep(interval)

        try:
            await self.connect()
        except Exception as e:
            print(f"重连失败: {e}")
            await self._schedule_reconnect()

    async def disconnect(self):
        """断开连接"""
        self._running = False
        if self._room:
            try:
                await self._room.disconnect()
            except Exception:
                pass

    async def get_danmaku(self) -> List[Danmaku]:
        """获取并清空弹幕队列"""
        danmaku_list = self._danmaku_queue.copy()
        self._danmaku_queue.clear()
        return danmaku_list

    async def get_gifts(self) -> List[Danmaku]:
        """获取并清空礼物队列"""
        gift_list = self._gift_queue.copy()
        self._gift_queue.clear()
        return gift_list

    async def get_super_chats(self) -> List[Danmaku]:
        """获取并清空 SC 队列"""
        sc_list = self._sc_queue.copy()
        self._sc_queue.clear()
        return sc_list

    async def get_guards(self) -> List[Danmaku]:
        """获取并清空大航海队列"""
        guard_list = self._guard_queue.copy()
        self._guard_queue.clear()
        return guard_list

    async def get_entries(self) -> List[Danmaku]:
        """获取并清空进场队列"""
        entry_list = self._entry_queue.copy()
        self._entry_queue.clear()
        return entry_list

class DanmakuAggregator:
    """Aggregate danmaku messages within a time window to avoid flooding"""

    def __init__(self, window_seconds: float = 5.0, max_messages: int = 20):
        self.window_seconds = window_seconds
        self.max_messages = max_messages
        self._buffer = []  # List of (timestamp, username, message)
        self._lock = threading.Lock()
        self._timer = None
        self._on_aggregate = None  # Callback when aggregation is ready

    def set_callback(self, callback):
        """Set callback: callback(messages: list) -> None"""
        self._on_aggregate = callback

    def add_message(self, username: str, message: str):
        """Add a danmaku message to the buffer"""
        with self._lock:
            self._buffer.append((time.time(), username, message))

            # Start/reset the timer
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self.window_seconds, self._flush)
            self._timer.daemon = True
            self._timer.start()

            # If buffer is full, flush immediately
            if len(self._buffer) >= self.max_messages:
                self._flush_locked()

    def _flush_locked(self):
        """Flush the buffer while already holding the lock"""
        if not self._buffer:
            return
        messages = self._buffer.copy()
        self._buffer.clear()
        if self._timer:
            self._timer.cancel()
            self._timer = None

        # Release lock before calling callback to avoid deadlock
        # Callback will be invoked after lock release
        if self._on_aggregate:
            # Schedule callback outside lock
            threading.Thread(target=self._on_aggregate, args=(messages,), daemon=True).start()

    def _flush(self):
        """Flush the buffer and trigger callback"""
        with self._lock:
            if not self._buffer:
                return
            messages = self._buffer.copy()
            self._buffer.clear()
            if self._timer:
                self._timer.cancel()
                self._timer = None

        if self._on_aggregate:
            self._on_aggregate(messages)

    def format_messages(self, messages: list) -> str:
        """Format aggregated messages into a context string for LLM"""
        if len(messages) == 1:
            _, username, msg = messages[0]
            return f"{username}说：{msg}"

        parts = []
        for _, username, msg in messages:
            parts.append(f"{username}：{msg}")
        return f"直播间弹幕（{len(messages)}条）：\n" + "\n".join(parts)

    def stop(self):
        """Stop the aggregator and cancel pending timer"""
        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None
            self._buffer.clear()


class ProactiveSpeaker:
    """Proactive speech - AI initiates conversation when the room is quiet"""

    def __init__(self, idle_timeout: float = 30.0, min_interval: float = 60.0):
        self.idle_timeout = idle_timeout  # Seconds before proactive speech
        self.min_interval = min_interval  # Minimum interval between proactive speeches
        self._last_message_time = time.time()
        self._last_proactive_time = 0
        self._timer = None
        self._on_proactive = None  # Callback: callback() -> None
        self._running = False

    def set_callback(self, callback):
        """Set callback for proactive speech trigger"""
        self._on_proactive = callback

    def start(self):
        """Start the proactive speech timer"""
        self._running = True
        self._last_message_time = time.time()
        self._schedule_check()

    def stop(self):
        """Stop the proactive speech timer"""
        self._running = False
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def on_activity(self):
        """Call this when there's any activity (danmaku, user input, etc.)"""
        self._last_message_time = time.time()

    def _schedule_check(self):
        """Schedule the next idle check"""
        if not self._running:
            return
        self._timer = threading.Timer(self.idle_timeout, self._check_idle)
        self._timer.daemon = True
        self._timer.start()

    def _check_idle(self):
        """Check if the room has been idle long enough"""
        if not self._running:
            return

        idle_time = time.time() - self._last_message_time
        time_since_proactive = time.time() - self._last_proactive_time

        if idle_time >= self.idle_timeout and time_since_proactive >= self.min_interval:
            self._last_proactive_time = time.time()
            if self._on_proactive:
                self._on_proactive()

        self._schedule_check()


class LiveManager:
    def __init__(self, platform: str = "bilibili", room_id: str = "", cookie: str = "",
                 bilibili_config=None,  # BilibiliLiveConfig 对象
                 aggregation_window: float = 5.0, proactive_idle_timeout: float = 30.0,
                 proactive_min_interval: float = 60.0, enable_aggregation: bool = True,
                 enable_proactive: bool = True):
        self.platform_name = platform
        self.room_id = room_id
        self.cookie = cookie
        self._bilibili_config = bilibili_config
        self._platform: Optional[LivePlatform] = None
        self._running = False
        self._on_danmaku: Optional[Callable[[Danmaku], None]] = None

        # 事件回调（用于推送到 WebSocket 等外部消费者）
        self._on_danmaku_event = None
        self._on_gift_event = None
        self._on_super_chat_event = None
        self._on_guard_event = None
        self._on_entry_event = None

        # Danmaku aggregation
        self.enable_aggregation = enable_aggregation
        self._aggregator = DanmakuAggregator(
            window_seconds=aggregation_window,
            max_messages=20
        )
        self._aggregator.set_callback(self._on_aggregated_messages)

        # Proactive speech
        self.enable_proactive = enable_proactive
        self._proactive_speaker = ProactiveSpeaker(
            idle_timeout=proactive_idle_timeout,
            min_interval=proactive_min_interval
        )
        self._proactive_speaker.set_callback(self._on_proactive_trigger)

        # Callback for aggregated/proactive messages to be processed by agent
        self._on_aggregated_danmaku: Optional[Callable[[str], None]] = None
        self._on_proactive_speech: Optional[Callable[[], None]] = None
    
    def set_danmaku_callback(self, callback: Callable[[Danmaku], None]):
        self._on_danmaku = callback

    def set_aggregated_danmaku_callback(self, callback: Callable[[str], None]):
        """Set callback for aggregated danmaku messages.

        callback(formatted_text: str) -> None
        """
        self._on_aggregated_danmaku = callback

    def set_proactive_speech_callback(self, callback: Callable[[], None]):
        """Set callback for proactive speech trigger.

        callback() -> None
        """
        self._on_proactive_speech = callback

    def set_danmaku_event_callback(self, callback):
        """设置弹幕事件回调（用于推送到 WebSocket）"""
        self._on_danmaku_event = callback

    def set_gift_event_callback(self, callback):
        """设置礼物事件回调"""
        self._on_gift_event = callback

    def set_super_chat_event_callback(self, callback):
        """设置 SC 事件回调"""
        self._on_super_chat_event = callback

    def set_guard_event_callback(self, callback):
        """设置大航海事件回调"""
        self._on_guard_event = callback

    def set_entry_event_callback(self, callback):
        """设置进场事件回调"""
        self._on_entry_event = callback

    async def start(self):
        if self.platform_name == "bilibili" and self.room_id:
            credential = None
            if self._bilibili_config and self._bilibili_config.sessdata:
                try:
                    from bilibili_api import Credential
                    credential = Credential(
                        sessdata=self._bilibili_config.sessdata,
                        bili_jct=self._bilibili_config.bili_jct,
                        buvid3=self._bilibili_config.buvid3,
                        ac_time_value=self._bilibili_config.ac_time_value or None,
                        dedeuserid=self._bilibili_config.dedeuserid or None,
                    )
                    print("[直播] 使用凭据连接（可接收完整事件）")
                except ImportError:
                    print("[直播] bilibili-api-python 未安装，降级为匿名连接")

            self._platform = BilibiliLive(self.room_id, credential=credential)
            await self._platform.connect()
            self._running = True

            # Start proactive speaker if enabled
            if self.enable_proactive:
                self._proactive_speaker.start()

            asyncio.create_task(self._process_loop())
        else:
            print("直播功能未配置或平台不支持")

    async def stop(self):
        self._running = False
        self._aggregator.stop()
        self._proactive_speaker.stop()
        if self._platform:
            await self._platform.disconnect()

    async def _process_loop(self):
        while self._running:
            if self._platform:
                # 处理弹幕
                danmaku_list = await self._platform.get_danmaku()
                for danmaku in danmaku_list:
                    # Notify proactive speaker of activity
                    if self.enable_proactive:
                        self._proactive_speaker.on_activity()

                    if self.enable_aggregation:
                        # Add to aggregator instead of processing immediately
                        self._aggregator.add_message(danmaku.username, danmaku.content)
                    else:
                        # Backward compatible: process individually
                        if self._on_danmaku:
                            self._on_danmaku(danmaku)
                    # 推送弹幕事件到 WebSocket
                    if self._on_danmaku_event:
                        self._on_danmaku_event(danmaku)

                # 处理礼物
                gift_list = await self._platform.get_gifts()
                for gift in gift_list:
                    if self._on_gift_event:
                        self._on_gift_event(gift)

                # 处理 SC
                sc_list = await self._platform.get_super_chats()
                for sc in sc_list:
                    if self._on_super_chat_event:
                        self._on_super_chat_event(sc)

                # 处理大航海
                guard_list = await self._platform.get_guards()
                for guard in guard_list:
                    if self._on_guard_event:
                        self._on_guard_event(guard)

                # 处理进场
                entry_list = await self._platform.get_entries()
                for entry in entry_list:
                    if self._on_entry_event:
                        self._on_entry_event(entry)

            await asyncio.sleep(0.1)

    def _on_aggregated_messages(self, messages: list):
        """Handle aggregated danmaku messages from the aggregator"""
        formatted = self._aggregator.format_messages(messages)
        print(f"[弹幕聚合] 收到 {len(messages)} 条弹幕，已聚合处理")

        if self._on_aggregated_danmaku:
            self._on_aggregated_danmaku(formatted)
        elif self._on_danmaku:
            # Fallback: create a single Danmaku from aggregated messages for backward compat
            combined = Danmaku(
                username="直播间",
                content=formatted,
                timestamp=time.time()
            )
            self._on_danmaku(combined)

    def _on_proactive_trigger(self):
        """Handle proactive speech trigger"""
        print("[主动发言] 直播间安静了一段时间，准备主动发言")
        if self._on_proactive_speech:
            self._on_proactive_speech()

    @staticmethod
    def generate_proactive_prompt() -> str:
        """Generate a prompt for proactive speech based on current context"""
        prompts = [
            "直播间好像有点安静呢，主动和观众聊聊天吧",
            "最近有什么有趣的事情可以分享吗",
            "可以和观众互动一下，问他们在做什么",
            "分享一下现在的感受或心情",
        ]
        return random.choice(prompts)
