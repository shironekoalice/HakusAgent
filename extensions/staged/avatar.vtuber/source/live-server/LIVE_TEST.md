# B 站直播测试清单（上半身 + AI）

## 1. 启动顺序

1. 双击 `live-server\start_live.bat`  
   看到 `JaumeAI 直播后端 v3 启动 ws://127.0.0.1:9091/ws` 即可  
2. 打开 `Auto-live2D-beta\index.html`（自动加载 v4 PSD）  
3. 右下角输入框若可发送，说明 WebSocket 已连上（标题旁 opacity 会变亮）

## 2. 开 B 站弹幕前

编辑 `live-server\config.yaml`：

```yaml
bilibili:
  enabled: true
  room_id: 你的直播间数字ID   # 不是短链，是纯数字房间号
  cooldown_sec: 4.5          # 两条弹幕最小间隔
  max_per_min: 10            # 每分钟最多回几条
```

改完 **重启 start_live.bat**。

## 3. 皮上建议打开

| 开关 | 用途 |
|---|---|
| 自动眨眼 | 不死鱼眼 |
| 待机/随机动作 | 不说话时也活着 |
| 麦克风口型 | 你自己说话时口型（可选） |
| 背景：绿幕 | OBS 抠像 |

摄像头追踪需要 localhost/https；用 `python main.py` 桌面版更稳。

## 4. OBS

- 窗口捕获 / 浏览器源：`http://127.0.0.1:5500` 或直接捕获浏览器窗口  
- 若用 file:// 开 index.html：PSD 自动加载可以，摄像头权限可能不行  
- 推荐：在 `Auto-live2D-beta` 目录起本地服务再开页面  

```bat
cd D:\项目\live2dControl\Auto-live2D-beta
"D:\Python311\python.exe" -m http.server 8080
```
浏览器打开 `http://127.0.0.1:8080/index.html`

## 5. 这次后端改了什么（直播稳定性）

- **串行回复队列**：弹幕刷屏时不会并发打爆 LLM/TTS  
- **弹幕只入队一次**：不再「开几个网页就回几遍」  
- 队列满会丢弃并打日志，避免无限堆积  
- 首句 TTS 仍是句级流水线，先出声再补后面句  

## 6. 延迟预期（粗算）

| 段 | 大约 |
|---|---|
| 弹幕 → 入队 | <50ms |
| LLM | 0.6–2s（qwen-turbo 更快） |
| 首句 TTS | 0.4–1.5s |
| **端到端首次出声** | **约 1.5–3.5s** |

要更快：把 preferred 切到 `dashscope-turbo`，并保证回复只有 1 句。

## 7. 上播前自测 5 分钟

1. 后端 health：`http://127.0.0.1:9091/health`  
2. 皮上输入框发：`你好` → 应有字幕 + 声音 + 表情  
3. 再发：`你是谁` → 应短句、带 [情感] 效果（笑/歪头等）  
4. 连发 5 条弹幕 → 应排队一条条回，不炸  
5. 关掉后端 → 皮上应自动重连（5s）

## 8. 已知限制

- 裙摆遮挡未修（下半身先不管）  
- `mouth_close` 很淡，闭嘴可能偏空 → 可调「闭合难易」  
- API key 写在 config.yaml，**不要直播时把文件夹整个开给别人看**；有条件请轮换密钥  
