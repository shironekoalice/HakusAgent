# HakusCLI

HakusCLI 是 HakusAI 的终端入口，适合服务器、脚本、远程工作区和偏好键盘操作的用户。

它提供：

- 交互式对话和非交互任务；
- 多模型服务商与自定义兼容地址；
- 项目文件、命令、MCP 和 Skills；
- 会话历史、任务恢复和可审阅的工具操作；
- Windows、macOS、Linux 与 Android Termux 支持。

## 快速开始

从 Releases 下载与你的系统和 CPU 架构匹配的程序，放入可执行路径后运行：

```text
hakuscli
hakuscli exec "整理当前项目的待办事项"
```

完整的配置、模型和平台说明见 [`docs/README.md`](docs/README.md)。

## 数据边界

终端程序默认将配置、会话和运行记录保存在本机数据目录。项目文件只会在当前工作区和已授权的远程环境中访问。云端模型和外部工具服务会按照各自的网络与隐私策略处理发送给它们的数据。
