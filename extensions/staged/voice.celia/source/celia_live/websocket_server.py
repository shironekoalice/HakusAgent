"""WebSocket server for real-time communication with browser frontend"""
import asyncio
import json
import base64
import logging
import os
import threading
from typing import Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

# WebSocket message protocol:
# Backend -> Frontend:
#   {"type": "text", "data": "Hello"}           - AI text response
#   {"type": "audio", "data": "base64..."}       - Audio chunk (base64 encoded)
#   {"type": "expression", "data": "happy"}      - Expression change
#   {"type": "mouth", "data": {"value": 0.8}}    - Mouth movement
#   {"type": "status", "data": {"speaking": true, "listening": false}}  - Status update
#
# Frontend -> Backend:
#   {"type": "text_input", "data": "Hello"}      - Text input
#   {"type": "start_listening"}                   - Start voice input
#   {"type": "stop_listening"}                    - Stop voice input


class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"Client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        logger.info(f"Client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        disconnected = set()
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.add(connection)
        self.active_connections -= disconnected

    async def send(self, websocket: WebSocket, message: dict):
        try:
            await websocket.send_json(message)
        except Exception:
            self.active_connections.discard(websocket)


class CeliaWebSocketServer:
    def __init__(self, celia_live=None, host="0.0.0.0", port=12393):
        self.app = FastAPI(title="Celia AI Virtual Streamer")
        self.celia_live = celia_live
        self.host = host
        self.port = port
        self.manager = ConnectionManager()
        self._event_loop = None

        # CORS
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        # Routes
        self.app.websocket("/ws")(self.websocket_endpoint)

        # Serve frontend static files
        frontend_dist = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "frontend", "dist"
        )
        frontend_public = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "frontend", "public"
        )
        if os.path.exists(frontend_dist):
            assets_dir = os.path.join(frontend_dist, "assets")
            if os.path.exists(assets_dir):
                self.app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

            @self.app.get("/")
            async def serve_index():
                return FileResponse(os.path.join(frontend_dist, "index.html"))

        # Serve Live2D model files from frontend/public
        live2d_models = os.path.join(frontend_public, "live2d-models")
        if os.path.exists(live2d_models):
            self.app.mount("/live2d-models", StaticFiles(directory=live2d_models), name="live2d-models")

        # Message callback for CeliaLive
        self._message_callback = None

    def set_celia_live(self, celia_live):
        """Set the CeliaLive instance and register callbacks"""
        self.celia_live = celia_live
        # Celia emits events from worker threads. Schedule them on Uvicorn's
        # loop because WebSocket objects belong to the server loop.
        celia_live.set_ws_callback(self._schedule_celia_event)

    def _schedule_celia_event(self, event_type: str, data):
        if self._event_loop and self._event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._on_celia_event(event_type, data), self._event_loop
            )

    async def _on_celia_event(self, event_type: str, data):
        """Callback from CeliaLive to push events to WebSocket clients"""
        if event_type == "text":
            await self.manager.broadcast({"type": "text", "data": data})
            await self.manager.broadcast({"type": "reply", "text": data})
        elif event_type == "audio":
            # data is audio file path - read and encode as base64
            if os.path.exists(data):
                with open(data, "rb") as f:
                    audio_b64 = base64.b64encode(f.read()).decode()
                await self.manager.broadcast({
                    "type": "audio",
                    "data": audio_b64,
                    "b64": audio_b64,
                    "mime": "audio/mpeg",
                    "strength": getattr(self.celia_live, "_current_emotion_intensity", 0.5),
                })
        elif event_type == "expression":
            await self.manager.broadcast({"type": "expression", "data": data})
            if isinstance(data, dict):
                await self.manager.broadcast({
                    "type": "emotion",
                    "emotion": data.get("emotion", "calm"),
                    "strength": data.get("strength", 0.5),
                })
            else:
                await self.manager.broadcast({"type": "emotion", "emotion": data, "strength": 0.5})
        elif event_type == "mood":
            await self.manager.broadcast({"type": "mood", **(data or {})})
        elif event_type == "mouth":
            await self.manager.broadcast({"type": "mouth", "data": data})
        elif event_type == "status":
            await self.manager.broadcast({"type": "status", "data": data})
        # 新增直播事件类型
        elif event_type == "danmaku":
            await self.manager.broadcast({"type": "danmaku", "data": data})
        elif event_type == "gift":
            await self.manager.broadcast({"type": "gift", "data": data})
        elif event_type == "super_chat":
            await self.manager.broadcast({"type": "super_chat", "data": data})
        elif event_type == "guard":
            await self.manager.broadcast({"type": "guard", "data": data})
        elif event_type == "entry":
            await self.manager.broadcast({"type": "entry", "data": data})
        elif event_type == "live_status":
            await self.manager.broadcast({"type": "live_status", "data": data})

    async def websocket_endpoint(self, websocket: WebSocket):
        self._event_loop = asyncio.get_running_loop()
        await self.manager.connect(websocket)
        try:
            while True:
                data = await websocket.receive_text()
                try:
                    message = json.loads(data)
                    await self._handle_client_message(websocket, message)
                except json.JSONDecodeError:
                    await self.manager.send(websocket, {"type": "error", "data": "Invalid JSON"})
        except WebSocketDisconnect:
            self.manager.disconnect(websocket)

    async def _handle_client_message(self, websocket: WebSocket, message: dict):
        msg_type = message.get("type", "")

        if msg_type in ("text_input", "chat"):
            text = message.get("data", "")
            if msg_type == "chat":
                text = message.get("text", text)
            if text and self.celia_live:
                # Process text input through CeliaLive
                # This runs in a thread to not block the event loop
                asyncio.create_task(self._process_text_input(text))

        elif msg_type == "start_listening":
            if self.celia_live:
                self.celia_live.resume_recording()
                await self.manager.broadcast({"type": "status", "data": {"listening": True}})

        elif msg_type == "stop_listening":
            if self.celia_live:
                self.celia_live.pause_recording()
                await self.manager.broadcast({"type": "status", "data": {"listening": False}})

        # 新增：模型切换
        elif msg_type == "set_model":
            model_name = message.get("data", "")
            # 通知所有客户端模型已切换（前端自行处理切换）
            await self.manager.broadcast({"type": "model_changed", "data": model_name})

        # 新增：切换直播间
        elif msg_type == "set_room":
            room_id = message.get("data", "")
            # 通知所有客户端直播间已切换
            await self.manager.broadcast({"type": "live_status", "data": {"room_id": room_id, "status": "switching"}})

        # 新增：更新配置
        elif msg_type == "update_config":
            config_data = message.get("data", {})
            # TODO: 实现配置热更新（当前仅记录日志）
            logger.info(f"Received config update request: {config_data}")

    async def _process_text_input(self, text: str):
        """Process text input from WebSocket client"""
        try:
            if self.celia_live:
                threading.Thread(
                    target=self.celia_live._stream_process,
                    args=(text,),
                    daemon=True
                ).start()
        except Exception as e:
            logger.error(f"Error processing text input: {e}")

    def run(self):
        """Run the WebSocket server"""
        import uvicorn
        uvicorn.run(self.app, host=self.host, port=self.port)

    async def run_async(self):
        """Run the WebSocket server asynchronously"""
        import uvicorn
        config = uvicorn.Config(self.app, host=self.host, port=self.port)
        server = uvicorn.Server(config)
        await server.serve()
