# Kross 文档

本文档集只描述当前 SaaS Work Agent 产品。阶段性评审和迁移背景保留为历史记录，不作为现行接口说明。

## 使用与运维

| 目标 | 文档 |
|---|---|
| 安装并完成第一个任务 | [快速上手](getting-started.md) |
| 配置身份、模型、Worker 与存储 | [配置参考](configuration.md) |
| 部署单机或多机环境 | [部署与运维](cloud-agent-deployment.md)、[k3s 选型](deployment-k3s-decision.md) |
| 理解身份、文件和外部工具边界 | [安全模型](security.md) |
| 排查登录、直播、Worker 和文件问题 | [故障排查](troubleshooting.md) |
| 查看支持环境 | [支持范围](support.md) |

## 架构与开发

| 目标 | 文档 |
|---|---|
| 理解组件、Runtime 与数据流 | [技术概览](technical-overview.md) |
| 实现 Web 或 Worker 集成 | [Cloud Protocol](cloud-protocol.md) |
| 理解工作闭环、恢复和结果契约 | [Agent Harness](harness.md) |
| 发布平台 Skill 或受管外部工具 | [扩展 Kross](extensions.md) |
| 理解 Provider 能力与指标 | [Provider 能力](provider-capabilities.md)、[调用观测](provider-observability.md) |
| 准备版本 | [发布指南](releasing.md) |
| 查看当前实施顺序 | [实施方案](roadmap-2026-09-01.md) |

## 维护约定

- 用户可见行为、配置和协议变化必须同步文档与 `CHANGELOG.md`。
- 普通用户文档不暴露内部模型选择、调试 Trace 或连接命令。
- 平台扩展以版本化 Skill 和受管外部工具为边界，不把 Worker Core 当作稳定 SDK。
- `node scripts/check-doc-links.mjs` 校验根目录和 `docs/` 中的本地 Markdown 链接。
