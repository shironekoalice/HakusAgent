# ZCode、DeepSeek Harness 与 HakusAgent 对比

## 结论

三套代码解决的问题不同：ZCode 更接近可交付的编码产品，DeepSeek Harness
提供最清晰的插件化 Agent 运行时，HakusAgent 拥有最宽的产品能力和最多的
模型/角色扩展。HakusAgent 的迁移主线应当是：**吸收 Harness 的事件与能力
边界，保留 ZCode 的工作区和产品交互经验，把现有 Rust Runtime 作为唯一
执行平面，继续把语音、Live2D、VTuber 和 Android 放在可选扩展层。**

## 代码事实

| 维度 | ZCode | deepseek-harness | HakusAgent | 对我们的意义 |
|---|---|---|---|---|
| 产品形态 | Desktop/Web/TUI/CLI，面向编码工作流 | 可组合的 Agent runtime/插件系统 | Desktop/TUI/Web/Android/语音/VTuber | 以 ZCode 的工作台作为入口，以 Harness 的 runtime 作为内核 |
| 执行循环 | 工具调用、工作流、子代理已产品化 | 事件驱动 AgentLoop，插件提供能力 | Python AgentCore 与 Rust runtime 并存 | Rust 统一执行，Python 只保留扩展协议 |
| 事件与会话 | SQLite 会话、checkpoint、恢复能力 | append-only session event log，事件是事实源 | session store、checkpoint、rollout、long-task 多套并存 | 采用 Harness 的 ledger，checkpoint 只做恢复索引 |
| 工作区 | Local、SSH、WSL 远程工作流成熟 | capability seam，运行时不绑定具体传输 | 本地工具面广，Rust Fleet 已统一 Local/SSH/WSL/Docker HostSpec 与 executor | 统一 `discover -> prepare -> connect -> execute -> observe -> stop -> dispose` |
| 权限/沙箱 | 用户确认、工具风险和工作区策略 | 明确的 approval/sandbox pipeline | Python 与 Rust 各有权限、命令安全和沙箱逻辑 | 一个 `allow/ask/deny` 策略边界，所有适配器调用它 |
| 扩展 | workflow、subagent、MCP 等产品集成 | Cordis everything-is-a-plugin，profile/bundle 组合 | MCP、Skills、provider、语音、VTuber、Android | 插件安装必须分阶段检查、声明能力、记录版本和 checksum |
| Provider | 产品配置和模型选择成熟 | provider/capability seam 清晰 | Provider 数量最多，但配置格式存在多套 | OpenAI-compatible 为主，兼容 DeepSeek 官方协议和本地端点 |
| UI | 编码工作台成熟，产品完成度高 | 运行时/控制台导向 | 角色化 UI 能力强，但页面、聊天、终端布局重复 | Chat、编辑器、终端、任务和 Review 做同级面板 |
| 主要风险 | 运行时抽象对 HakusAgent 领域能力覆盖有限 | 需要补齐桌面产品和远程工作区 UX | 架构重复、会话事实源分裂、启动/内存负担高 | 先收敛 runtime，再改 UI，最后退休旧 Python/Vue 路径 |

## 逐项判断

### Runtime

DeepSeek Harness 的核心优势是边界清楚：AgentLoop 只编排事件和能力，插件
负责实现能力，session log 追加写入且可重放。这个设计最适合解决 HakusAgent
当前的重复状态问题。迁移时不应直接复制 Harness 的插件目录结构，而应把
其三个契约移植到现有 Rust Runtime：事件 envelope、能力声明、审批结果。

ZCode 的优势是把这些能力包装成完整产品：任务、子代理、工作区、审查和恢复
都能被用户操作。它适合作为交互和流程参考，而不是新的后端事实源。

### Workspace

ZCode 已证明 SSH/WSL 工作区可以成为普通项目入口。HakusAgent 的 Rust Fleet
已经有本地进程隔离、SSH 命令构造、日志上限、重启和停止语义，并已加入 WSL
HostSpec：通过 `wsl.exe` 启动、支持 distro 选择和 Windows 到 `/mnt` 路径转换。
现阶段 SSH Fleet 使用密钥和 `BatchMode`，密码登录只在交互式 smoke test 中
验证，尚未接入无头 worker。Docker 已接入同一 executor：通过受限的 `docker run`
参数构造、allowlist 环境注入和显式 stop/rm 清理承载 worker；当前只做 fake
contract，真实 Docker 仍按计划暂不启动。

### Session 与恢复

HakusAgent 目前同时存在 Python session store、Rust runtime ledger、checkpoint
和 long-task/recovery 数据。继续增加任何新的 transcript 或 checkpoint 格式
都会扩大迁移成本。目标是让一次用户输入、模型流、工具调用、审批、结果、
取消和完成都先进入 ledger，再由 UI、任务板和恢复视图投影出来。

### Provider

桌面配置同时存在旧的顶层 `api_keys` 和当前的
`models.providers.<id>.api_key`。解析器现在兼容两种布局，支持 AISZ GPT、
StepFun 和 SenseNova，并返回稳定的健康状态：`healthy`、`unconfigured`、
`unauthorized`、`forbidden`、`rate_limited`、`unavailable`、`error`。
指定配置中的 `aisz / gpt-5.6-luna` 已通过真实 `/models` 健康检查，适合作为
当前 GPT 路由；默认配置中的其他健康 provider 仍可切换。

## 迁移优先级

1. 固化 Rust Runtime API、事件 envelope、权限决策和本地工作区契约。
2. 在同一契约后接 SSH，再接 WSL；Docker 先完成 adapter 和 fake contract test，
   等用户明确后再做真实容器测试。
3. 让 Desktop、TUI、Web 只消费同一事件 ledger，停止新增旧 Python 会话格式。
4. 用工作台面板替换页面式 UI，同时保持 runtime API 稳定。
5. 将语音、Live2D/VRM、VTuber、Android 和旧 provider 适配器迁移为版本化
   Python extension。
6. 迁移诊断通过后，删除旧 Python AgentCore、重复 session/checkpoint 和旧 Vue
   路径。

## 验收基线

- Windows 冷启动不超过 5 秒，空闲内存不超过 450 MB。
- 本地和远程任务并发时，事件序列不冲突。
- 取消确认后，工具进程不能继续修改工作区。
- pause/resume 从 ledger 重建出相同的模型可见历史。
- provider 健康检查不泄露密钥，并区分不可达、未授权、限流和健康。
- SSH、WSL、Docker adapter 先通过契约测试，再开放真实环境 smoke test。
