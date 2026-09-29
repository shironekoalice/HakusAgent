<div align="center">

<img src="docs/assets/hakusai-26.png" alt="HakusAI" width="480" />

# HakusAI

**本地优先的 AI 工作台**

在桌面或终端中连接你选择的模型，围绕项目工作区完成对话、文件处理、命令执行和流程编排。

[![Latest release](https://img.shields.io/github/v/release/modemneko/HakusAgent?label=最新版本)](https://github.com/modemneko/HakusAgent/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/modemneko/HakusAgent/build-all.yml?label=构建)](https://github.com/modemneko/HakusAgent/actions)
[![Platform](https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-4DA3FF)](#支持平台)

</div>

---

```text
2026-9-28 00:10:15 [INFO] 建议：目前本项目正在进行重大重构，预计最快2026-10-15前完成，
建议重构完成后从 Releases 最新的二进制文件根据自己的平台进行下载并手动更新。
```

## 适合什么场景

HakusAI 面向需要长期使用 AI 工具的人：代码与文档工作、项目资料整理、重复任务自动化、远程工作区操作，以及希望自己管理模型和数据边界的个人用户。

它不是一个只提供聊天窗口的网页套壳。每个会话都可以绑定到项目工作区，工具调用、改动审阅、任务状态和历史记录都围绕这个工作区组织。

## 主要能力

- **项目工作区**：为每个项目选择本地文件夹，或通过 SSH、WSL、Docker 连接远程工作区。
- **多模型接入**：支持内置模型服务商、兼容 OpenAI 协议的服务，以及本地模型运行时。
- **可审阅的工具调用**：文件修改、命令执行和外部服务访问遵循权限设置，并在执行前后保留可读的操作记录。
- **流程画布**：把模型、工具、条件、循环、文件和人工确认组合成可重复运行的工作流。
- **长任务与会话**：支持会话持久化、任务暂停与恢复、工作区级历史和运行状态。
- **Skills 与 MCP**：按项目或用户范围安装扩展能力，使用前可以检查来源、权限和作用范围。
- **语音与桌面集成**：提供语音输入、播报、托盘和自动更新等桌面能力。

## 界面一览

**对话主界面** —— 会话按工作区分组管理，右侧工作台提供 Diff 审阅、运行轨迹、终端与日志：

![对话主界面](docs/assets/screens/chat.png)

**模型与模型商** —— 多模型多 Key 管理，改动自动保存，无需手动点按钮：

![模型与模型商](docs/assets/screens/settings-model.png)

**紧凑侧栏** —— 收起后只保留核心动作，一键回到完整会话列表：

![紧凑侧栏](docs/assets/screens/compact.png)

## 工作方式

```text
桌面端 / 终端
        │
        ▼
本地运行时：会话、权限、工具、事件与持久化
        │
        ├── 本地项目工作区
        ├── 远程工作区
        ├── 模型服务或本地模型
        └── 经授权的 Skills / MCP 服务
```

默认情况下，配置、会话、日志和扩展状态由本机管理。模型请求是否离开本机，取决于你选择的模型服务；项目文件不会因为安装应用而自动上传。

## 支持平台

| 入口 | 支持平台 | 适合用途 |
| --- | --- | --- |
| 桌面应用 | Windows、macOS、Linux | 完整图形界面、项目管理、流程画布和设置 |
| 终端程序 | Windows、macOS、Linux | 终端工作流、自动化、服务器和脚本 |
| Android / Termux | Android arm64 | 移动终端和轻量远程环境 |

## 下载与开始使用

从 [Releases](https://github.com/modemneko/HakusAgent/releases/latest) 下载对应平台的安装包或终端程序。

首次启动时：

1. 选择语言和默认工作区。
2. 在模型设置中添加服务商和凭据。
3. 选择模型后开始对话，或新建一个项目工作区。
4. 需要操作文件和命令时，按当前项目的权限策略确认。

终端程序的安装、配置和平台说明见 [终端使用指南](frontend/terminal/docs/README.md)。

## 公开文档

- [使用与平台总览](docs/PROJECT_OVERVIEW.md)
- [安装与首次配置](docs/INSTALL.md)
- [模型与服务商](frontend/terminal/docs/PROVIDERS.md)
- [权限与安全边界](frontend/terminal/docs/SANDBOX.md)
- [Skills 与扩展](docs/SKILLS.md)
- [MCP 外部工具](frontend/terminal/docs/MCP.md)
- [文档索引](docs/README.md)

## 数据与隐私

- API Key、会话和本地偏好默认保存在当前设备。
- 项目工具以已选择的工作区为边界；远程项目只访问你明确连接的远程环境。
- 第三方扩展和 MCP 服务拥有自己的代码与网络能力，启用前应检查来源和权限。
- 应用不会替你判断第三方模型服务的隐私政策；发送到模型服务的内容由所选服务商处理。

## 许可

请参阅仓库中的许可证与归属说明。版本、平台产物和变更信息以 GitHub Releases 页面为准。

<div align="center">

**HAKUSAI 26**

</div>
