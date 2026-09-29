# Android / Termux

终端程序提供 Android arm64 版本，可在 Termux 中运行。Android 专用程序不能与 Linux glibc 版本混用。

## 使用前

1. 从 Releases 下载 Android arm64 程序包。
2. 在 Termux 中授予必要的存储和网络权限。
3. 将程序放入可执行路径并运行 `hakuscli`。
4. 首次使用时配置模型服务和工作区。

## 边界说明

- 文件访问受 Android 应用权限和 Termux 文件布局限制。
- 终端程序的审批规则不能扩大 Termux 已获得的系统权限。
- Android 环境不等同于桌面系统；部分系统级隔离和凭据存储能力不同。
- 在共享存储中处理项目时，注意其他应用可能也能访问这些文件。

## 故障排查

程序无法启动时，先确认架构是 arm64、文件具有执行权限，并且没有下载成 Linux 版本。网络或模型连接问题则按[模型服务商](PROVIDERS.md)中的地址、凭据和权限顺序检查。
