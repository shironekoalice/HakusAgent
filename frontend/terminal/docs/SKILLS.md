# 终端 Skills

Skill 为终端程序提供任务规则、模板和参考资源。它不会改变系统权限，也不应被当作可信代码。

## 使用建议

1. 从可信来源安装。
2. 阅读 `SKILL.md` 和随附脚本。
3. 确认它需要的文件、命令和网络范围。
4. 只在需要的工作区启用。

终端会在当前工作区和用户范围中发现可用 Skill。项目范围优先，适合项目约定；用户范围适合个人通用流程。

## 最小格式

```text
summarize/
└── SKILL.md
```

示例：

```markdown
---
name: summarize
description: Summarize selected project notes.
---

# Instructions

Describe the input, output, and limits.
```

## 安全边界

- Skill 中的指令不能绕过审批、沙箱或工作区边界。
- 带脚本的 Skill 可能执行本地代码，启用前必须审查。
- 不要把密钥、令牌、Cookie 或私有地址写进 Skill。
- 更新 Skill 后重新确认内容和访问范围。
