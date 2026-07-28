# Security Policy

## 支持范围

Kross 目前处于预发布阶段。安全修复优先合入 `main`，并在下一个补丁版本中发布；旧的预发布版本不保证持续维护。

## 报告安全问题

请使用 GitHub 仓库 Security 页面中的 **Report a vulnerability** 私密报告入口：

https://github.com/zzc-101/Kross/security/advisories/new

请提供受影响版本、复现步骤、潜在影响，以及可行时的最小 PoC。请不要在公开 Issue 中披露尚未修复的漏洞、密钥或敏感数据。

维护者确认问题后会尽快回复，并在修复可用前协调披露时间。普通功能缺陷请使用公开 Issues。

## 安全边界

本地 TUI 的 shell 命令使用当前用户权限；Cloud Worker 则以 Docker 容器作为执行边界。运行不受信任仓库、Skills 或 MCP server 前，请先阅读 [安全模型](docs/security.md)。
