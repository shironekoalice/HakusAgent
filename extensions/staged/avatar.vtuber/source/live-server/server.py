"""JaumeAI — AI 直播后端 v3

链路：弹幕/聊天文本 → 记忆召回+心情注入 → LLM(人格+情感+动作标记) → 表情/动作即时下发 →
     句子级流水线 CosyVoice → 逐句音频推送（前端队列播放+口型+字幕）

移植来源：
- emotions.py / tts_cosyvoice.py  ← HakusAI_chat（情感枚举、语气指令、CosyVoice封装）
- mind.py                        ← HakusAI_chat inner_mind（情绪状态机裁剪版）
- llm.py                         ← HakusAI_chat models/base 设计（多平台故障切换）
- memory.py                      ← HakusAI_chat 向量记忆思路（零依赖实现）
- bilibili.py                    ← Celia/Open-LLM-VTuber 同款 blivedm 弹幕接入
"""
import asyncio
import base64
import os
import json
import re
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config_loader import CFG
from emotions import EmotionType, EMOTION_INSTRUCT, MOTIONS
from tts_cosyvoice import CosyVoiceTTS
from llm import LLMRouter
from mind import Mind
from memory import Memory, worth_remembering
from bilibili import start_if_configured

ROOT = Path(__file__).parent
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

tts = CosyVoiceTTS(CFG["tts"], data_dir=str(ROOT))
llm = LLMRouter(CFG["llm"]["providers"])
mind = Mind(storage_dir=str(ROOT / "data"))

TAG_RE = re.compile(r"\[([a-zA-Z]+)[:：]([0-9.]+)(?::([a-zA-Z]+))?\]\s*$")
POSE_RE = re.compile(r"\[pose ([^\]]+)\]\s*$")
AXES = {"angleX", "angleY", "angleZ", "eyeX", "eyeY", "body", "armY", "armPos"}
SENT_SPLIT = re.compile(r"(?<=[。！？!?~～…])\s*")

history: list[dict] = []
memory = Memory(embed_fn=lambda texts: llm.embed(texts))

# 直播串行队列：同一时间只回一条，避免弹幕刷屏打爆 LLM/TTS
_chat_q: asyncio.Queue = asyncio.Queue(maxsize=32)
_reply_lock = asyncio.Lock()


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d}]", *a, flush=True)


def broadcast(payload: dict):
    """推给所有已连接前端；无前端时丢弃（直播时至少有一个 OBS 浏览器页）"""
    conns = list(getattr(app, "websocket_connections", set()))
    for c in conns:
        asyncio.ensure_future(_safe_send(c, payload))


async def _safe_send(ws: WebSocket, payload: dict):
    try:
        await ws.send_json(payload)
    except Exception:
        app.websocket_connections.discard(ws)


def build_system_prompt() -> str:
    return CFG["persona"]["system"] + "\n标签完整格式:[情感:强度] 或 [情感:强度:动作]\n" \
        + mind.get_inner_context()


async def llm_chat(user_text: str):
    """返回 (句子列表, emotion, strength, motion, pose)；标签从回复末尾解析"""
    recalled = await memory.recall(user_text)
    msgs = [{"role": "system", "content": build_system_prompt()}]
    if recalled:
        msgs[0]["content"] += "\n【相关记忆】" + "；".join(recalled)
    msgs += history[-12:] + [{"role": "user", "content": user_text}]

    lp = CFG["llm"]
    t0 = time.time()
    text, provider = await llm.chat(msgs, max_tokens=lp.get("max_tokens", 200),
                                    temperature=lp.get("temperature", 0.9))
    log(f"LLM[{provider}] {int((time.time()-t0)*1000)}ms: {text}")

    emotion, strength, motion, pose = EmotionType.CALM, 0.6, None, None
    pm = POSE_RE.search(text)
    if pm:
        pose = {}
        for pair in pm.group(1).replace("，", ",").split(","):
            if ":" in pair:
                k, v = pair.split(":", 1)
                if k.strip() in AXES:
                    try: pose[k.strip()] = max(-1, min(1, float(v)))
                    except ValueError: pass
        text = text[: pm.start()].strip()
    m = TAG_RE.search(text)
    if m:
        try:
            emotion = EmotionType(m.group(1).lower())
        except ValueError:
            emotion = EmotionType.CALM
        try:
            strength = max(0.05, min(1.0, float(m.group(2))))
        except ValueError:
            pass
        if m.group(3) and m.group(3).lower() in MOTIONS:
            motion = m.group(3).lower()
        text = text[: m.start()].strip()

    mind.process_interaction(emotion, strength)

    sents = [s.strip() for s in SENT_SPLIT.split(text) if s.strip()] or ([text] if text else [])
    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": text})
    if len(history) > 24:
        del history[: len(history) - 24]
    return sents, emotion, strength, motion, pose


async def handle_chat(text: str, user: str):
    """单次回复：LLM → 表情/动作 → 逐句 TTS。由队列 worker 串行调用。"""
    async with _reply_lock:
        broadcast({"type": "status", "stage": "thinking"})
        try:
            sents, emotion, strength, motion, pose = await llm_chat(text)
        except Exception as e:
            log("LLM失败:", e)
            broadcast({"type": "status", "stage": "error", "detail": str(e)})
            return

        full = "".join(sents)
        broadcast({"type": "reply", "text": full, "user": user})
        broadcast({"type": "emotion", "emotion": emotion.value, "strength": strength})
        if motion:
            broadcast({"type": "motion", "name": motion})
        if pose:
            broadcast({"type": "pose", "axes": pose})
        broadcast({"type": "mood", **mind.mood_payload()})

        if worth_remembering(text) or worth_remembering(user + ":" + text):
            asyncio.ensure_future(memory.remember(f"{user}说过：{text}", user=user))

        instruct = EMOTION_INSTRUCT.get(EmotionType(emotion))
        for i, sent in enumerate(sents):
            if not re.search(r"[\w一-鿿]", sent):
                continue   # 纯标点/语气符号句，CosyVoice会报400
            t0 = time.time()
            audio = await tts.generate_audio(sent, instruct)
            dt = int((time.time() - t0) * 1000)
            if audio:
                tag = "首句" if i == 0 else f"第{i+1}句"
                log(f"TTS {tag} {dt}ms ({len(audio)}B): {sent[:20]}")
                broadcast({
                    "type": "audio", "idx": i, "b64": base64.b64encode(audio).decode(),
                    "mime": f"audio/{CFG['tts']['format']}",
                    "emotion": emotion.value, "strength": strength,
                    "first": i == 0, "tts_ms": dt,
                })
            else:
                broadcast({"type": "status", "stage": "tts-failed"})
                break
        broadcast({"type": "status", "stage": "idle"})


async def _chat_worker():
    while True:
        item = await _chat_q.get()
        try:
            await handle_chat(item["text"], item["user"])
        except Exception as e:
            log("回复异常:", e)
        finally:
            _chat_q.task_done()


def enqueue_chat(text: str, user: str = "观众"):
    try:
        _chat_q.put_nowait({"text": text, "user": user})
        log(f"入队({ _chat_q.qsize() }): {user}: {text[:40]}")
    except asyncio.QueueFull:
        log("队列已满，丢弃:", text[:40])


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    app.websocket_connections.add(ws)
    log("前端已连接")
    await ws.send_json({"type": "mood", **mind.mood_payload()})
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "chat":
                text = (msg.get("text") or "").strip()
                if text:
                    enqueue_chat(text, msg.get("user", "观众"))
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        app.websocket_connections.discard(ws)
        log("前端断开")


@app.get("/health")
async def health():
    return {"ok": True, "history": len(history), "memories": len(memory.items),
            "mind": mind.mood_payload()}


@app.get("/api/config")
async def get_config():
    """前端设置抽屉读当前配置（含实时状态）"""
    return {
        "persona": CFG["persona"],
        "bilibili": CFG.get("bilibili", {}),
        "tts": {"voice": tts.voice_id, "model": tts.model, "ref_audio": tts.ref_audio,
                "cloning": tts.clone_status == "running",
                "clone_status": tts.clone_status, "clone_error": tts.clone_error},
        "llm": {"providers": [{"name": p["name"], "model": p["model"], "priority": p.get("priority", 99)}
                              for p in CFG["llm"]["providers"]],
                "temperature": CFG["llm"].get("temperature", 0.9),
                "max_tokens": CFG["llm"].get("max_tokens", 200)},
        "mind": mind.mood_payload(),
        "memory_count": len(memory.items),
    }


@app.post("/api/config")
async def set_config(patch: dict):
    """前端保存设置：全部热更新（写回 config.yaml），弹幕开关/房间号需重启"""
    note = []
    if "persona" in patch and isinstance(patch["persona"], dict):
        CFG["persona"].update({k: v for k, v in patch["persona"].items() if v})
    if "bilibili" in patch and isinstance(patch["bilibili"], dict):
        CFG.setdefault("bilibili", {}).update(patch["bilibili"])
        note.append("弹幕开关/房间号需重启后端生效")
    if "tts" in patch and isinstance(patch["tts"], dict):
        t = patch["tts"]
        if t.get("voice") is not None and t["voice"] != "":
            tts.voice_id = t["voice"].strip()          # 音色实时切换
        if t.get("model"):
            tts.model = t["model"]
        if "ref_audio" in t:
            new_ref = t["ref_audio"].strip()
            if new_ref and new_ref != tts.ref_audio:
                if not os.path.exists(new_ref):
                    return {"ok": False, "error": f"参考音频文件不存在: {new_ref}"}
                tts.ref_audio = new_ref
                import threading
                def _run_clone():
                    try:
                        asyncio.run(tts._clone_voice())
                    except Exception as e:
                        tts.clone_status = "failed"; tts.clone_error = str(e)
                        print(f"[TTS] 克隆线程异常: {e}")
                threading.Thread(target=_run_clone, daemon=True).start()
                note.append("声音克隆已启动，约1~5分钟后自动切换新音色")
            elif new_ref == "":
                tts.ref_audio = ""
    if "llm" in patch and isinstance(patch["llm"], dict):
        l = patch["llm"]
        if "temperature" in l:
            CFG["llm"]["temperature"] = max(0.1, min(1.5, float(l["temperature"])))
        if "max_tokens" in l:
            CFG["llm"]["max_tokens"] = max(60, min(600, int(l["max_tokens"])))
        if l.get("preferred"):
            ps = CFG["llm"]["providers"]
            for i, p in enumerate(ps):
                if p["name"] == l["preferred"]:
                    ps.insert(0, ps.pop(i))
                    for j, q in enumerate(ps):
                        q["priority"] = j + 1
                    break
            note.append(f"对话模型已切换为 {l['preferred']}")
    try:
        import yaml as _yaml
        (ROOT / "config.yaml").write_text(_yaml.dump(CFG, allow_unicode=True, sort_keys=False),
                                          encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "note": "；".join(note) or "已保存"}


@app.post("/api/memory/clear")
async def memory_clear():
    n = len(memory.items)
    memory.items = []
    memory._save()
    return {"ok": True, "cleared": n}


@app.post("/api/mind/reset")
async def mind_reset():
    mind.state.current_emotion = EmotionType.CALM
    mind.state.intensity = 0.5
    mind.state.happiness = 0.5
    mind.state.anxiety = 0.3
    mind.state.affection = 0.5
    mind.state.energy = 0.7
    mind.state.history = []
    mind._save()
    return {"ok": True, "mind": mind.mood_payload()}


@app.on_event("startup")
async def startup():
    app.websocket_connections = set()
    asyncio.ensure_future(_chat_worker())
    log("聊天队列 worker 已启动")

    def on_dm(uname, msg):
        log(f"[弹幕] {uname}: {msg}")
        enqueue_chat(msg, uname)   # 只入队一次，不再按前端数量重复触发 LLM
    start_if_configured(on_dm)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else CFG["server"]["ws_port"]
    log(f"JaumeAI 直播后端 v3 启动 ws://127.0.0.1:{port}/ws")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
